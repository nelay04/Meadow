/**
 * Binds the canvas engine to a Y.Doc session.
 *
 * The engine holds no document state of its own, so this is where Y observers turn
 * into targeted cache updates. Note the direction: a tool writes to the Y.Doc, the
 * observer fires, and only then does the engine's cache change. Even a purely local
 * drag round-trips through the document. That is deliberate. It means a local edit and
 * a remote one take exactly the same path, so there is no second code path to keep
 * correct.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ArrowRouting } from '@meadow/schema'
import type { TextMark } from '../../doc/richText'
import {
  CanvasEngine,
  DEFAULT_PAGE_LINES,
  PAGE_LINES_STEP,
  type WritingColumn,
} from '../../canvas/engine'
import { type CanvasSurface, DEFAULT_SURFACE } from '../../canvas/surface'
import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { ToolId } from '../../canvas/tools/types'
import { DocEngineHost, observeDocument } from '../../doc/engineHost'
import {
  type DocSession,
  addPageLines,
  observePageMeta,
  readPageDate,
  readPageLines,
  readPagePaper,
  readPageSubject,
  setPageDate,
  setPagePaper,
  setPageSubject,
  reconcileBindings,
  reconcileOrder,
  reseatWritingRows,
} from '../../doc/mutations'
import { createTextEditor } from '../../overlay/textEditor'
import { THEME_EVENT } from '../../ui/theme'

const GRID_KEY = 'meadow.grid'

function readGridPreference(): boolean {
  try {
    return localStorage.getItem(GRID_KEY) !== 'off'
  } catch {
    // Private-mode Safari throws on localStorage. The grid is not worth a crash.
    return true
  }
}

function writeGridPreference(visible: boolean): void {
  try {
    localStorage.setItem(GRID_KEY, visible ? 'on' : 'off')
  } catch {
    // As above: it still applies for this session.
  }
}

export type CanvasHandle = {
  containerRef: (element: HTMLDivElement | null) => void
  engine: CanvasEngine | null
  tool: ToolId
  setTool(tool: ToolId): void
  selection: string[]
  objectCount: number
  zoom: number
  /** The object currently being text-edited, or null. */
  editingId: string | null
  /** Hand remote presence to the engine for the next frame. */
  setWanderers(wanderers: readonly Wanderer[]): void
  zoomToFit(): void
  resetZoom(): void
  /** Put the caret in a text-bearing object. False if it is not editable yet. */
  beginTextEdit(id: string): boolean
  /** Put the caret on a row of a writing surface, making the row if it is not there. */
  beginWritingRow(row: number): boolean
  /** How many rules this page has, on a writing surface. Zero on a free canvas. */
  pageLines: number
  /** Lengthen the page by one step. No-op when the role cannot write. */
  addLines(): void
  /** The date printed at the top of the page, `YYYY-MM-DD` or '' for none. */
  pageDate: string
  setDate(iso: string): void
  /** What the page is about, written beside the date. */
  pageSubject: string
  setSubject(subject: string): void
  /** The stock this page is printed on, or '' to take the reader's own default. */
  pagePaper: string
  setPaper(paper: string): void
  /** Re-read the surface colours. For anything that repaints the page under WebGL. */
  syncTheme(): void
  deleteSelection(): void
  /** Graph paper on the board surface. Cosmetic, remembered across sessions. */
  gridVisible: boolean
  toggleGrid(): void
  /**
   * The shape newly drawn arrows get. Chosen in the rail beside the arrow tool, the
   * way a stroke width is chosen: before you draw, not after.
   */
  arrowRouting: ArrowRouting
  setArrowRouting(routing: ArrowRouting): void

  /**
   * Text formatting, for the object being edited or for a text-bearing selection.
   *
   * `marks` is only meaningful while an editor is open, because a mark applies to a
   * range inside a fragment and there is no range without a caret. Size is an object
   * property and works either way.
   */
  canFormatText: boolean
  activeMarks: readonly TextMark[]
  toggleMark(mark: TextMark): void
  textSize: number | null
  setTextSize(size: number): void
}

export type CanvasPresence = {
  /** Publish the local pointer, in world coordinates. */
  onPointer(point: { x: number; y: number } | null): void
  onSelection(ids: readonly string[]): void
}

/**
 * Everything the hook needs that is not the document or the presence channel.
 *
 * An object rather than more positional arguments: both of these are optional, both
 * arrive from the page rather than from the sync layer, and a third and fourth
 * positional parameter is how a call site ends up reading `useCanvas(s, p, '', fn)`.
 */
export type CanvasOptions = {
  /** The signed-in person's display name, for the byline on a sticky they create. */
  authorName?: string
  /**
   * The paper under the canvas, chosen by the glade's kind.
   *
   * It arrives one request after the page mounts, so it is applied by its own effect
   * rather than only at init. Changing it never rebuilds the engine: it is a class on
   * the host and two style writes, and tearing the canvas down for a background would
   * drop the camera and the selection.
   */
  surface?: CanvasSurface
  /**
   * The tools this kind of glade offers, or undefined for all of them.
   *
   * Applied to the engine and not only to the rail, because every tool also has a
   * single-key shortcut and hiding a button does not unbind a key.
   */
  tools?: readonly ToolId[]
  /**
   * Fence the canvas into a writing column of this world width. Undefined leaves it
   * as an unbounded plane.
   */
  column?: WritingColumn | null
  /**
   * A write the role would not allow. Fired from a pointer handler, so it can arrive
   * once a frame for as long as someone keeps dragging on a board they cannot edit.
   * Whatever consumes it has to expect repeats.
   */
  onRefused?(message: string): void
}

export function useCanvas(
  session: DocSession,
  presence?: CanvasPresence,
  options: CanvasOptions = {},
): CanvasHandle {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [tool, setToolState] = useState<ToolId>('select')
  const [selection, setSelection] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [objectCount, setObjectCount] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [gridVisible, setGridVisible] = useState(readGridPreference)
  const [arrowRouting, setArrowRoutingState] = useState<ArrowRouting>('straight')
  const [activeMarks, setActiveMarks] = useState<readonly TextMark[]>([])
  // A counter, not the value: the engine is the source of truth for both of these and
  // they change on selection, on editing, and on a peer's edit. Bumping this on the
  // events that can move them re-reads the engine rather than mirroring its state.
  const [formatVersion, setFormatVersion] = useState(0)
  const engineRef = useRef<CanvasEngine | null>(null)

  // The session changes identity when the role changes. Keeping it in a ref lets the
  // host read the current one without tearing down and rebuilding the engine, which
  // would drop the camera and the selection on every reconnect.
  const sessionRef = useRef(session)
  sessionRef.current = session

  // Same reason as the session: presence is rebuilt when the connection changes, and
  // capturing it would pin the engine to a dead awareness instance.
  const presenceRef = useRef(presence)
  presenceRef.current = presence

  // The engine's effect must not re-run when the grid is toggled - that would tear
  // down the canvas and drop the camera - so the initial value is read through a ref.
  const gridRef = useRef(gridVisible)
  gridRef.current = gridVisible

  // Same reason as the session: the name arrives after the engine is built, so the
  // host reads it through a ref rather than capturing whatever it was at mount. The
  // refusal handler goes through one too, so the engine's effect can keep `[element]`
  // as its only dependency and a new callback identity never rebuilds the canvas.
  const optionsRef = useRef(options)
  optionsRef.current = options

  useEffect(() => {
    if (element === null) return

    const current = () => sessionRef.current

    const host = new DocEngineHost(current, {
      onRefused: (message) => optionsRef.current.onRefused?.(message),
      onMarks: setActiveMarks,
      // The engine asks for an editor and never learns what it is. This is the only
      // place ProseMirror is named on the board path, which is what keeps src/canvas
      // free of it.
      createEditor: createTextEditor,
      authorName: () => optionsRef.current.authorName ?? '',
    })
    const unobserveHost = host.observe()

    const engine = new CanvasEngine(element, host, {
      onSelectionChange: (ids) => {
        setSelection(ids)
        setFormatVersion((version) => version + 1)
        presenceRef.current?.onSelection(ids)
      },
      onObjectCountChange: setObjectCount,
      onToolChange: setToolState,
      onCameraChange: (camera) => setZoom(camera.zoom),
      onEditingChange: (id) => {
        setEditingId(id)
        setFormatVersion((version) => version + 1)
        if (id === null) setActiveMarks([])
      },
      onPointerWorld: (point) => presenceRef.current?.onPointer(point),
    })
    engineRef.current = engine

    let cancelled = false
    void engine.init().then(() => {
      if (cancelled) return
      engine.setGridVisible(gridRef.current)
      engine.setSurface(optionsRef.current.surface ?? DEFAULT_SURFACE)
      engine.setAvailableTools(optionsRef.current.tools ?? null)
      engine.setColumn(optionsRef.current.column ?? null)
      engine.setPageLines(readPageLines(current(), DEFAULT_PAGE_LINES))
      reconcileOrder(current())
      // A target may have moved while this client was offline, or the document may
      // have been written by a client that solved differently.
      reconcileBindings(current())
      host.invalidate()
      engine.resync()
    })

    const unobserveDoc = observeDocument(current(), engine)

    // WebGL is the one surface CSS cannot repaint, so the engine is told directly
    // when the theme changes.
    const onTheme = () => engineRef.current?.syncTheme()
    window.addEventListener(THEME_EVENT, onTheme)

    return () => {
      cancelled = true
      window.removeEventListener(THEME_EVENT, onTheme)
      unobserveDoc()
      unobserveHost()
      engineRef.current = null
      engine.destroy()
    }
  }, [element])

  // Depends on the value, not on `options`: the hook is called with a fresh options
  // object every render, and depending on that would re-run this on every keystroke.
  const surface = options.surface ?? DEFAULT_SURFACE
  useEffect(() => {
    engineRef.current?.setSurface(surface)
  }, [surface, element])

  // The kind registry's arrays are module-level constants, so this identity is stable
  // and the effect runs when the kind actually changes rather than on every render.
  const tools = options.tools ?? null
  useEffect(() => {
    engineRef.current?.setAvailableTools(tools)
  }, [tools, element])

  /*
   * Split into its own numbers rather than passed as an object, because the page
   * builds a fresh one every render and an object dependency would re-fence the camera
   * on every keystroke.
   */
  const column = options.column ?? null
  const width = column?.width ?? null
  const fontSize = column?.fontSize ?? 0
  const lineHeight = column?.lineHeight ?? 0
  useEffect(() => {
    engineRef.current?.setColumn(width === null ? null : { width, fontSize, lineHeight })
  }, [width, fontSize, lineHeight, element])

  /*
   * Put an older page's rows back on the ruling.
   *
   * Waits for objects, because the kind and the document arrive from two different
   * requests and repairing an empty document repairs nothing. Keyed on the pitch it
   * last repaired for rather than a boolean, so a page opened before its type changed
   * is repaired again afterwards, and typing a new row does not re-run it.
   */
  /*
   * The page's length, read from the document rather than held here.
   *
   * `useSyncExternalStore` over the doc's `meta`, for the same reason every other
   * document value is read that way: a copy in React state is a copy that is wrong the
   * moment a peer lengthens the page.
   */
  const subscribeMeta = useCallback(
    (onChange: () => void) => observePageMeta(session, onChange),
    [session],
  )
  const pageLines = useSyncExternalStore(subscribeMeta, () =>
    readPageLines(session, DEFAULT_PAGE_LINES),
  )
  const pageDate = useSyncExternalStore(subscribeMeta, () => readPageDate(session))
  const pageSubject = useSyncExternalStore(subscribeMeta, () => readPageSubject(session))
  const pagePaper = useSyncExternalStore(subscribeMeta, () => readPagePaper(session))
  useEffect(() => {
    engineRef.current?.setPageLines(pageLines)
  }, [pageLines, element])

  const addLines = useCallback(() => {
    addPageLines(
      sessionRef.current,
      readPageLines(sessionRef.current, DEFAULT_PAGE_LINES),
      PAGE_LINES_STEP,
    )
  }, [])

  const setDate = useCallback((iso: string) => {
    setPageDate(sessionRef.current, iso)
  }, [])

  const setSubject = useCallback((subject: string) => {
    setPageSubject(sessionRef.current, subject)
  }, [])

  const setPaper = useCallback((paper: string) => {
    setPagePaper(sessionRef.current, paper)
  }, [])

  // The stock decides the ink, and the ink is the one colour WebGL cannot re-resolve
  // for itself. Same call the theme toggle makes, for the same reason.
  const syncTheme = useCallback(() => {
    engineRef.current?.syncTheme()
  }, [])

  const reseated = useRef<number | null>(null)
  useEffect(() => {
    const spacing = fontSize * lineHeight
    if (width === null || objectCount === 0 || reseated.current === spacing) return
    reseated.current = spacing
    reseatWritingRows(sessionRef.current, spacing)
  }, [width, fontSize, lineHeight, objectCount])

  const setTool = useCallback((next: ToolId) => {
    engineRef.current?.setTool(next)
  }, [])

  const toggleGrid = useCallback(() => {
    setGridVisible((shown) => {
      const next = !shown
      engineRef.current?.setGridVisible(next)
      writeGridPreference(next)
      return next
    })
  }, [])

  // Read so the value is not flagged as unused: its only job is to make this hook
  // re-run, which re-reads `canFormatText` and `textSize` off the engine.
  void formatVersion

  const setArrowRouting = useCallback((routing: ArrowRouting) => {
    engineRef.current?.setDefaultArrowRouting(routing)
    setArrowRoutingState(routing)
  }, [])

  const setWanderers = useCallback((wanderers: readonly Wanderer[]) => {
    engineRef.current?.setWanderers(wanderers)
  }, [])

  /*
   * Stable, and that matters more here than for the other handles on this object.
   *
   * The rest of them are only ever called from a click. This one is called from an
   * effect - the board view puts the caret on a writing surface's first line - and a
   * fresh identity every render would make that effect run every render, which put the
   * caret back every time the user clicked away from it.
   */
  const beginTextEdit = useCallback((id: string) => {
    return engineRef.current?.beginTextEdit(id) ?? false
  }, [])

  // Stable for the same reason as `beginTextEdit`: the board view calls it from an
  // effect when a lea is opened empty.
  const beginWritingRow = useCallback((row: number) => {
    return engineRef.current?.beginWritingRow(row) ?? false
  }, [])

  return {
    containerRef: setElement,
    engine: engineRef.current,
    tool,
    setTool,
    selection,
    objectCount,
    zoom,
    editingId,
    setWanderers,
    beginTextEdit,
    beginWritingRow,
    pageLines: options.column === null || options.column === undefined ? 0 : pageLines,
    addLines,
    pageDate,
    setDate,
    pageSubject,
    setSubject,
    pagePaper,
    setPaper,
    syncTheme,
    zoomToFit: () => engineRef.current?.zoomToFit(),
    resetZoom: () => engineRef.current?.resetZoom(),
    deleteSelection: () => engineRef.current?.deleteSelection(),
    gridVisible,
    toggleGrid,
    arrowRouting,
    setArrowRouting,
    canFormatText: engineRef.current?.canFormatText ?? false,
    activeMarks,
    toggleMark: (mark: TextMark) => engineRef.current?.toggleTextMark(mark),
    textSize: engineRef.current?.textSize ?? null,
    setTextSize: (size: number) => {
      engineRef.current?.setTextSize(size)
      setFormatVersion((version) => version + 1)
    },
  }
}
