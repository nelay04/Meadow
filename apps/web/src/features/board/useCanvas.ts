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

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ArrowRouting } from '@meadow/schema'
import type { TextMark } from '../../doc/richText'
import { CanvasEngine } from '../../canvas/engine'
import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { ToolId } from '../../canvas/tools/types'
import { DocEngineHost, observeDocument } from '../../doc/engineHost'
import { type DocSession, reconcileBindings, reconcileOrder } from '../../doc/mutations'
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
  notice: string | null
  dismissNotice(): void
  /** Hand remote presence to the engine for the next frame. */
  setWanderers(wanderers: readonly Wanderer[]): void
  zoomToFit(): void
  resetZoom(): void
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

export function useCanvas(
  session: DocSession,
  presence?: CanvasPresence,
  /** The signed-in person's display name, for the byline on a sticky they create. */
  authorName = '',
): CanvasHandle {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [tool, setToolState] = useState<ToolId>('select')
  const [selection, setSelection] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [objectCount, setObjectCount] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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
  // host reads it through a ref rather than capturing whatever it was at mount.
  const authorRef = useRef(authorName)
  authorRef.current = authorName

  useEffect(() => {
    if (element === null) return

    const current = () => sessionRef.current

    const host = new DocEngineHost(current, {
      onRefused: setNotice,
      onMarks: setActiveMarks,
      // The engine asks for an editor and never learns what it is. This is the only
      // place ProseMirror is named on the board path, which is what keeps src/canvas
      // free of it.
      createEditor: createTextEditor,
      authorName: () => authorRef.current,
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

  return {
    containerRef: setElement,
    engine: engineRef.current,
    tool,
    setTool,
    selection,
    objectCount,
    zoom,
    editingId,
    notice,
    setWanderers,
    dismissNotice: () => setNotice(null),
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
