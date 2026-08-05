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
import { CanvasEngine } from '../../canvas/engine'
import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { ToolId } from '../../canvas/tools/types'
import { DocEngineHost, observeDocument } from '../../doc/engineHost'
import { type DocSession, reconcileBindings, reconcileOrder } from '../../doc/mutations'
import { createTextEditor } from '../../overlay/textEditor'

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
}

export type CanvasPresence = {
  /** Publish the local pointer, in world coordinates. */
  onPointer(point: { x: number; y: number } | null): void
  onSelection(ids: readonly string[]): void
}

export function useCanvas(session: DocSession, presence?: CanvasPresence): CanvasHandle {
  const [element, setElement] = useState<HTMLDivElement | null>(null)
  const [tool, setToolState] = useState<ToolId>('select')
  const [selection, setSelection] = useState<string[]>([])
  const [zoom, setZoom] = useState(1)
  const [objectCount, setObjectCount] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  useEffect(() => {
    if (element === null) return

    const current = () => sessionRef.current

    const host = new DocEngineHost(current, {
      onRefused: setNotice,
      // The engine asks for an editor and never learns what it is. This is the only
      // place ProseMirror is named on the board path, which is what keeps src/canvas
      // free of it.
      createEditor: createTextEditor,
    })
    const unobserveHost = host.observe()

    const engine = new CanvasEngine(element, host, {
      onSelectionChange: (ids) => {
        setSelection(ids)
        presenceRef.current?.onSelection(ids)
      },
      onObjectCountChange: setObjectCount,
      onToolChange: setToolState,
      onCameraChange: (camera) => setZoom(camera.zoom),
      onEditingChange: setEditingId,
      onPointerWorld: (point) => presenceRef.current?.onPointer(point),
    })
    engineRef.current = engine

    let cancelled = false
    void engine.init().then(() => {
      if (cancelled) return
      reconcileOrder(current())
      // A target may have moved while this client was offline, or the document may
      // have been written by a client that solved differently.
      reconcileBindings(current())
      host.invalidate()
      engine.resync()
    })

    const unobserveDoc = observeDocument(current(), engine)

    return () => {
      cancelled = true
      unobserveDoc()
      unobserveHost()
      engineRef.current = null
      engine.destroy()
    }
  }, [element])

  const setTool = useCallback((next: ToolId) => {
    engineRef.current?.setTool(next)
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
  }
}
