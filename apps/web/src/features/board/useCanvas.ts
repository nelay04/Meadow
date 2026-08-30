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
import {
  type ArrowRouting,
  DEFAULT_POLYGON_SIDES,
  FREEDRAW_TIPS,
  type FreedrawTip,
  MAX_POLYGON_SIDES,
  MIN_POLYGON_SIDES,
  PEN_ASSIST,
  type PenAssist,
} from '@meadow/schema'
import type { TextMark } from '../../doc/richText'
import {
  CanvasEngine,
  DEFAULT_PAGE_LINES,
  PAGE_LINES_STEP,
  pageSpan,
  pageStride,
  type WritingColumn,
} from '../../canvas/engine'
import { type CanvasSurface, DEFAULT_SURFACE } from '../../canvas/surface'
import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { PenSettings, ToolId } from '../../canvas/tools/types'
import { DocEngineHost, observeDocument } from '../../doc/engineHost'
import {
  type DocSession,
  type PageMeta,
  addPage,
  addPageLines,
  observePageMeta,
  readLeaPaper,
  readPages,
  removePage,
  setLeaPaper,
  setPageDate,
  setPageSubject,
  reconcileBindings,
  reconcileOrder,
  reseatWritingRows,
} from '../../doc/mutations'
import { createTextEditor } from '../../overlay/textEditor'
import { THEME_EVENT } from '../../ui/theme'

const GRID_KEY = 'meadow.grid'
const PEN_KEY = 'meadow.pen'

/**
 * The nib, as this person last left it.
 *
 * Remembered for the same reason the grid is, and with more reason: a pen is a tool
 * somebody chooses once and then uses for weeks, and handing them a default ballpoint
 * every time they open a board is asking them to set it up again each session. It is
 * a preference, not document state: two people on one board draw with their own pens.
 */
const DEFAULT_PEN: PenSettings = {
  tip: 'round',
  size: 3,
  angle: -Math.PI / 7,
  color: null,
  // Off, and it has to be off. A pen that turned the first thing somebody drew into a
  // rectangle they did not ask for would be a pen they stopped trusting, and the two
  // assisted modes are only worth having if they were chosen.
  assist: 'off',
}

function readPenPreference(): PenSettings {
  try {
    const raw = localStorage.getItem(PEN_KEY)
    if (raw === null) return DEFAULT_PEN
    const stored: unknown = JSON.parse(raw)
    if (typeof stored !== 'object' || stored === null) return DEFAULT_PEN
    // Field by field against the default, because this string was last written by a
    // different version of the app and may be missing anything or carrying nonsense.
    const value = stored as Partial<Record<keyof PenSettings, unknown>>
    return {
      // Checked against the list rather than cast, because an unknown tip indexes
      // `TIP_PROFILES` as undefined and takes the rail down on the next render.
      tip: FREEDRAW_TIPS.includes(value.tip as FreedrawTip)
        ? (value.tip as FreedrawTip)
        : DEFAULT_PEN.tip,
      size: typeof value.size === 'number' ? value.size : DEFAULT_PEN.size,
      angle: typeof value.angle === 'number' ? value.angle : DEFAULT_PEN.angle,
      color: typeof value.color === 'number' ? value.color : null,
      // Checked against the list for the same reason the tip is: an unknown mode read
      // back from an older or newer build must not decide what a stroke becomes.
      assist: PEN_ASSIST.includes(value.assist as PenAssist)
        ? (value.assist as PenAssist)
        : DEFAULT_PEN.assist,
    }
  } catch {
    return DEFAULT_PEN
  }
}

function writePenPreference(pen: PenSettings): void {
  try {
    localStorage.setItem(PEN_KEY, JSON.stringify(pen))
  } catch {
    // As with the grid: it still applies for this session.
  }
}

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
  /**
   * The pages of a lea, in order, and which one is open.
   *
   * Empty on a free canvas: a glade is not a diary and has no pages. Which page is
   * open is this client's alone and never written to the document - two people reading
   * one diary are usually not on the same page, and a shared cursor through the pages
   * would make that impossible.
   */
  pages: readonly PageMeta[]
  pageIndex: number
  turnToPage(index: number): void
  /** Add a page at the end and turn to it. No-op when the role cannot write. */
  addPage(): void
  /** Tear a page out, and the writing on it. Refuses the last page. */
  removePage(index: number): void
  /** How many rules the open page has, on a writing surface. Zero on a free canvas. */
  pageLines: number
  /** Lengthen the open page by one step. No-op when the role cannot write. */
  addLines(): void
  /** The date printed at the top of the open page, `YYYY-MM-DD` or '' for none. */
  pageDate: string
  setDate(iso: string): void
  /** What the open page is about, written above its first rule. */
  pageSubject: string
  setSubject(subject: string): void
  /** The stock this lea is printed on, or '' to take the reader's own default. */
  paper: string
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
   * How many sides the polygon tool draws with.
   *
   * Unlike the arrow's routing this is not only a setting for the next one: applying it
   * also reshapes any selected polygons, because a side count is the shape rather than
   * a mode it was drawn in. The engine does both; this is the number the rail shows.
   */
  polygonSides: number
  setPolygonSides(sides: number): void

  /**
   * The nib the next stroke will be drawn with, and how to change it.
   *
   * Partial, because the flyout changes one thing at a time. Remembered across
   * sessions in this browser, never in the document.
   */
  pen: PenSettings
  setPen(patch: Partial<PenSettings>): void

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

/** A glade has no pages, and one frozen empty array keeps that a stable identity. */
const EMPTY_PAGES: readonly PageMeta[] = []

/** Field by field, because the snapshot has to be stable while nothing has changed. */
function samePages(a: readonly PageMeta[], b: readonly PageMeta[]): boolean {
  if (a.length !== b.length) return false
  return a.every((page, index) => {
    const other = b[index]
    return (
      other !== undefined &&
      page.id === other.id &&
      page.slot === other.slot &&
      page.subject === other.subject &&
      page.date === other.date &&
      page.lines === other.lines
    )
  })
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
  const [polygonSides, setPolygonSidesState] = useState(DEFAULT_POLYGON_SIDES)
  const [pen, setPenState] = useState<PenSettings>(readPenPreference)
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

  // And the same for the nib, so a remembered pen is applied when the engine is built
  // rather than making the engine's effect depend on it and rebuild the canvas every
  // time somebody picked a colour.
  const penRef = useRef(pen)
  penRef.current = pen

  // Same reason as the session: the name arrives after the engine is built, so the
  // host reads it through a ref rather than capturing whatever it was at mount. The
  // refusal handler goes through one too, so the engine's effect can keep `[element]`
  // as its only dependency and a new callback identity never rebuilds the canvas.
  const optionsRef = useRef(options)
  optionsRef.current = options

  /*
   * The page that is open, for the engine's first frame.
   *
   * The effects below keep the engine in step once it exists, but the engine is built
   * inside an effect of its own and reads its starting state there. A ref rather than a
   * dependency, for the reason every other one here is: naming the open page as a
   * dependency of the effect that builds the canvas would tear the canvas down and
   * rebuild it every time somebody turned a page.
   */
  const openPageRef = useRef<PageMeta | null>(null)

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
      engine.setPen(penRef.current)
      engine.setSurface(optionsRef.current.surface ?? DEFAULT_SURFACE)
      engine.setAvailableTools(optionsRef.current.tools ?? null)
      engine.setColumn(optionsRef.current.column ?? null)
      engine.setPageSlot(openPageRef.current?.slot ?? 0)
      engine.setPageLines(openPageRef.current?.lines ?? DEFAULT_PAGE_LINES)
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
   * The diary itself, read from the document rather than held here.
   *
   * `useSyncExternalStore` over the doc's `meta`, for the same reason every other
   * document value is read that way: a copy in React state is a copy that is wrong the
   * moment a peer lengthens a page or starts a new one.
   *
   * The snapshot has to be the *same array* until something actually changes, or React
   * re-renders forever: `readPages` builds a fresh one on every call, and
   * `useSyncExternalStore` compares snapshots by identity. So the last one is kept and
   * handed back until a field of it differs.
   */
  const subscribeMeta = useCallback(
    (onChange: () => void) => observePageMeta(session, onChange),
    [session],
  )
  const lastPages = useRef<readonly PageMeta[]>([])
  const readPagesStable = useCallback((): readonly PageMeta[] => {
    const next = readPages(session, DEFAULT_PAGE_LINES)
    if (!samePages(next, lastPages.current)) lastPages.current = next
    return lastPages.current
  }, [session])
  const pages = useSyncExternalStore(subscribeMeta, readPagesStable)
  const paper = useSyncExternalStore(subscribeMeta, () => readLeaPaper(session))

  /*
   * Which page is open. This client's own, never the document's.
   *
   * Clamped on read rather than corrected in an effect, because a peer can remove the
   * page you are on: the state is then an index past the end for exactly as long as it
   * takes to render, and clamping here means that render is already correct rather than
   * being a frame of nothing followed by a fix.
   */
  const [wantedIndex, setWantedIndex] = useState(0)
  const pageIndex = Math.min(Math.max(wantedIndex, 0), pages.length - 1)
  const openPage = pages[pageIndex] ?? null
  // Callbacks below write to the page that is open without depending on which one it
  // is, so that none of them changes identity when a page is turned.
  const pageIndexRef = useRef(pageIndex)
  pageIndexRef.current = pageIndex

  openPageRef.current = openPage

  const pageLines = openPage?.lines ?? DEFAULT_PAGE_LINES
  const pageDate = openPage?.date ?? ''
  const pageSubject = openPage?.subject ?? ''

  useEffect(() => {
    engineRef.current?.setPageLines(pageLines)
  }, [pageLines, element])

  // The slot, not the index: which strip of the world this page's writing is in is a
  // property of the page and survives the pages before it being torn out.
  const pageSlot = openPage?.slot ?? 0
  useEffect(() => {
    engineRef.current?.setPageSlot(pageSlot)
  }, [pageSlot, element])

  /*
   * A page you have just started opens with the caret on its first line.
   *
   * Only that one, and never a page you turned to: once there is writing on a page,
   * choosing where you carry on is the app choosing for you, and on a surface where
   * every rule is its own slot that choice is always wrong. A blank page has one line
   * you could mean.
   *
   * One frame, because the engine learns about the new page from the effect above and
   * about the document from its own observer, and neither has necessarily run.
   */
  const caretOnSlot = useRef<number | null>(null)
  useEffect(() => {
    if (caretOnSlot.current !== pageSlot) return
    caretOnSlot.current = null
    const frame = requestAnimationFrame(() => {
      engineRef.current?.beginWritingRow(0)
    })
    return () => cancelAnimationFrame(frame)
  }, [pageSlot])

  // A different board is a different diary. Open it at its first page rather than at
  // whatever page number was open in the last one.
  const boardDoc = session.doc
  useEffect(() => {
    setWantedIndex(0)
  }, [boardDoc])

  const addLines = useCallback(() => {
    addPageLines(sessionRef.current, pageIndexRef.current, PAGE_LINES_STEP, DEFAULT_PAGE_LINES)
  }, [])

  const setDate = useCallback((iso: string) => {
    setPageDate(sessionRef.current, pageIndexRef.current, iso, DEFAULT_PAGE_LINES)
  }, [])

  const setSubject = useCallback((subject: string) => {
    setPageSubject(sessionRef.current, pageIndexRef.current, subject, DEFAULT_PAGE_LINES)
  }, [])

  const setPaper = useCallback((next: string) => {
    setLeaPaper(sessionRef.current, next)
  }, [])

  const turnToPage = useCallback((index: number) => {
    setWantedIndex(index)
  }, [])

  /*
   * A new page, and you are on it.
   *
   * Turning to it is the whole gesture. Adding a page you are then asked to go and
   * find is two steps for something that is one thing: you reached for a new page
   * because you want to write on it.
   */
  const startPage = useCallback(() => {
    const created = addPage(sessionRef.current, DEFAULT_PAGE_LINES)
    if (created < 0) return
    // The new page is empty by construction, so there is exactly one line the caret
    // could mean. Recorded as a slot rather than as an index, because it is the engine
    // catching up with the slot that this is waiting for.
    const pagesNow = readPages(sessionRef.current, DEFAULT_PAGE_LINES)
    caretOnSlot.current = pagesNow[created]?.slot ?? null
    setWantedIndex(created)
  }, [])

  const tearOutPage = useCallback(
    (index: number) => {
      if (width === null) return
      const target = readPages(sessionRef.current, DEFAULT_PAGE_LINES)[index]
      if (target === undefined) return

      const span = pageSpan({ width, fontSize, lineHeight }, target.slot)
      if (!removePage(sessionRef.current, index, span)) return
      // Stay where you were in the diary rather than jumping to the end: removing page
      // three should leave you looking at what is now page three.
      setWantedIndex((current) => (current > index ? current - 1 : current))
    },
    [width, fontSize, lineHeight],
  )

  // The stock decides the ink, and the ink is the one colour WebGL cannot re-resolve
  // for itself. Same call the theme toggle makes, for the same reason.
  const syncTheme = useCallback(() => {
    engineRef.current?.syncTheme()
  }, [])

  /*
   * Put an older page's rows back on the ruling.
   *
   * Waits for objects, because the kind and the document arrive from two different
   * requests and repairing an empty document repairs nothing. Keyed on the pitch it
   * last repaired for rather than a boolean, so a page opened before its type changed
   * is repaired again afterwards, and typing a new row does not re-run it.
   */
  const reseated = useRef<number | null>(null)
  useEffect(() => {
    const spacing = fontSize * lineHeight
    if (width === null || objectCount === 0 || reseated.current === spacing) return
    reseated.current = spacing
    reseatWritingRows(sessionRef.current, spacing, pageStride({ width, fontSize, lineHeight }))
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

  const setPolygonSides = useCallback((sides: number) => {
    const clamped = Math.max(MIN_POLYGON_SIDES, Math.min(MAX_POLYGON_SIDES, Math.round(sides)))
    engineRef.current?.setPolygonSides(clamped)
    setPolygonSidesState(clamped)
  }, [])

  const setPen = useCallback((patch: Partial<PenSettings>) => {
    setPenState((current) => {
      const next = { ...current, ...patch }
      engineRef.current?.setPen(next)
      writePenPreference(next)
      return next
    })
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
    pages: options.column === null || options.column === undefined ? EMPTY_PAGES : pages,
    pageIndex,
    turnToPage,
    addPage: startPage,
    removePage: tearOutPage,
    pageLines: options.column === null || options.column === undefined ? 0 : pageLines,
    addLines,
    pageDate,
    setDate,
    pageSubject,
    setSubject,
    paper,
    setPaper,
    syncTheme,
    zoomToFit: () => engineRef.current?.zoomToFit(),
    resetZoom: () => engineRef.current?.resetZoom(),
    deleteSelection: () => engineRef.current?.deleteSelection(),
    gridVisible,
    toggleGrid,
    arrowRouting,
    setArrowRouting,
    polygonSides,
    setPolygonSides,
    pen,
    setPen,
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
