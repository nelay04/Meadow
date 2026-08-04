/**
 * The canvas engine: camera, renderer, spatial index, tools, input.
 *
 * Owns no document state. Every object lives in the Y.Doc; this keeps a read-through
 * cache rebuilt from Y observers, because reading 5,000 Y.Maps per frame is far too
 * slow and because a second mutable copy would drift the moment a peer edits.
 *
 * ARCHITECTURE 5: never render on every state change. Changes mark the scene dirty and
 * exactly one render happens per animation frame. A drag emits a transaction per
 * pointermove, and rendering synchronously on each would triple the frame cost.
 *
 * This module must not import from src/features. The engine stays extractable.
 */

import { type ObjectData, objectBounds } from '@meadow/schema'
import { Application, Container, Graphics } from 'pixi.js'

import { Camera, type Point, type WorldRect } from './camera'
import { SpatialIndex } from './spatialIndex'
import { ShapeBatch } from './renderers/shapeBatch'
import type { SnapGuide } from './snapping'
import {
  GUIDE_COLOR,
  MARQUEE_FILL,
  SELECTION_COLOR,
  resolveStyle,
  shapeKindFor,
} from './style'
import {
  HANDLE_SIZE_PX,
  ROTATE_HANDLE_OFFSET_PX,
  RESIZE_HANDLES,
  handlePositions,
} from './transform'
import { unionBounds } from './hitTest'
import { createHandTool } from './tools/handTool'
import { createSelectTool } from './tools/selectTool'
import { createShapeTool } from './tools/shapeTool'
import type { CanvasPointerEvent, Tool, ToolContext, ToolId } from './tools/types'

/** Minimum instance capacity, so small boards do not reallocate on the first few adds. */
const MIN_BATCH_CAPACITY = 2048

export type EngineHost = {
  /** Ascending z-order of every object id. */
  order(): readonly string[]
  /** Live object lookup. */
  object(id: string): ObjectData | undefined
  allObjects(): Iterable<ObjectData>
  readonly canWrite: boolean
  createObject(input: Partial<ObjectData> & { type: ObjectData['type'] }): string | null
  applyPatches(patches: { id: string; patch: Partial<ObjectData> }[]): void
  deleteObjects(ids: readonly string[]): void
  commit(): void
  undo(): void
  redo(): void
  bringForward(ids: readonly string[]): void
  sendBackward(ids: readonly string[]): void
  bringToFront(ids: readonly string[]): void
  sendToBack(ids: readonly string[]): void
}

export type EngineEvents = {
  onSelectionChange?(ids: string[]): void
  /** Fired only when the count changes, never on every geometry edit. */
  onObjectCountChange?(count: number): void
  onToolChange?(tool: ToolId): void
  onCameraChange?(camera: { x: number; y: number; zoom: number }): void
}

export class CanvasEngine {
  readonly camera = new Camera()
  private readonly index = new SpatialIndex()
  private readonly cache = new Map<string, ObjectData>()
  private readonly selected = new Set<string>()

  private app!: Application
  private world!: Container
  private overlay!: Graphics
  private batch!: ShapeBatch

  private tool!: Tool
  private toolId: ToolId = 'select'
  private readonly context: ToolContext

  private marquee: WorldRect | null = null
  private guides: readonly SnapGuide[] = []

  private dirty = true
  private frame = 0
  private disposed = false
  private lastCameraVersion = -1
  private spacePanning = false

  /** Rolling render cost, exposed for the perf overlay. */
  private lastRenderMs = 0
  private lastVisible = 0
  private lastReportedCount = -1

  constructor(
    private readonly element: HTMLElement,
    private readonly host: EngineHost,
    private readonly events: EngineEvents = {},
  ) {
    this.context = this.createToolContext()
  }

  async init(): Promise<void> {
    this.app = new Application()
    await this.app.init({
      resizeTo: this.element,
      background: 0xfbfbf9,
      antialias: false,
      // The SDF shader is GLSL only for now. A WGSL twin is worth writing once the
      // approach has settled, not before.
      preference: 'webgl',
      autoDensity: true,
      resolution: window.devicePixelRatio || 1,
      autoStart: false,
    })
    if (this.disposed) {
      this.app.destroy(true, { children: true })
      return
    }

    this.element.appendChild(this.app.canvas)
    this.app.canvas.style.touchAction = 'none'
    this.app.canvas.style.display = 'block'

    this.world = new Container()
    this.batch = new ShapeBatch(MIN_BATCH_CAPACITY)
    this.world.addChild(this.batch.view)

    this.overlay = new Graphics()

    this.app.stage.addChild(this.world)
    this.app.stage.addChild(this.overlay)

    this.setTool('select')
    this.attachInput()
    this.resync()
    this.loop()
  }

  destroy(): void {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.detachInput()
    if (this.app !== undefined) this.app.destroy(true, { children: true })
  }

  // --- public API -------------------------------------------------------------

  get activeTool(): ToolId {
    return this.toolId
  }

  get stats(): { renderMs: number; visible: number; total: number; zoom: number } {
    return {
      renderMs: this.lastRenderMs,
      visible: this.lastVisible,
      total: this.cache.size,
      zoom: this.camera.zoom,
    }
  }

  setTool(id: ToolId): void {
    if (this.tool !== undefined) {
      if (this.toolId === id) return
      this.tool.cancel?.()
    }
    this.toolId = id
    this.tool = this.buildTool(id)
    this.setCursor(this.tool.cursor)
    this.events.onToolChange?.(id)
    this.requestRender()
  }

  getSelection(): string[] {
    return Array.from(this.selected)
  }

  setSelection(ids: Iterable<string>): void {
    this.selected.clear()
    for (const id of ids) this.selected.add(id)
    this.events.onSelectionChange?.(Array.from(this.selected))
    this.requestRender()
  }

  selectAll(): void {
    this.setSelection(this.host.order().filter((id) => !this.cache.get(id)?.locked))
  }

  deleteSelection(): void {
    if (this.selected.size === 0) return
    this.host.deleteObjects(Array.from(this.selected))
    this.setSelection([])
    this.host.commit()
  }

  zoomToFit(): void {
    const all = Array.from(this.cache.values())
    const bounds = unionBounds(all)
    if (bounds === null) {
      this.camera.reset()
    } else {
      this.camera.fit(bounds, this.viewportWidth, this.viewportHeight)
    }
    this.requestRender()
  }

  resetZoom(): void {
    this.camera.setZoom(1, this.viewportWidth, this.viewportHeight)
    this.requestRender()
  }

  /**
   * Rebuild the cache and index from scratch.
   *
   * Used on mount and after a bulk change such as the initial sync, where walking
   * every event would cost more than a straight rebuild.
   */
  resync(): void {
    this.cache.clear()
    const entries: { id: string; bounds: WorldRect }[] = []
    for (const object of this.host.allObjects()) {
      this.cache.set(object.id, object)
      entries.push({ id: object.id, bounds: objectBounds(object) })
    }
    this.index.reset(entries)
    this.pruneSelection()
    this.reportCount()
    this.requestRender()
  }

  /** Apply a targeted change. Cheaper than resync during a drag. */
  applyChanges(changed: Iterable<string>, removed: Iterable<string>): void {
    for (const id of removed) {
      this.cache.delete(id)
      this.index.remove(id)
      this.selected.delete(id)
    }
    for (const id of changed) {
      const object = this.host.object(id)
      if (object === undefined) {
        this.cache.delete(id)
        this.index.remove(id)
        this.selected.delete(id)
        continue
      }
      this.cache.set(id, object)
      this.index.insert(id, objectBounds(object))
    }
    this.reportCount()
    this.requestRender()
  }

  private reportCount(): void {
    if (this.cache.size === this.lastReportedCount) return
    this.lastReportedCount = this.cache.size
    this.events.onObjectCountChange?.(this.cache.size)
  }

  requestRender(): void {
    this.dirty = true
  }

  // --- internals --------------------------------------------------------------

  private get viewportWidth(): number {
    return this.app?.screen.width ?? this.element.clientWidth
  }

  private get viewportHeight(): number {
    return this.app?.screen.height ?? this.element.clientHeight
  }

  private pruneSelection(): void {
    let changed = false
    for (const id of Array.from(this.selected)) {
      if (!this.cache.has(id)) {
        this.selected.delete(id)
        changed = true
      }
    }
    if (changed) this.events.onSelectionChange?.(Array.from(this.selected))
  }

  private buildTool(id: ToolId): Tool {
    switch (id) {
      case 'hand':
        return createHandTool(this.context)
      case 'rect':
      case 'ellipse':
      case 'diamond':
        return createShapeTool(this.context, id)
      default:
        return createSelectTool(this.context)
    }
  }

  private createToolContext(): ToolContext {
    const host = this.host
    return {
      camera: this.camera,
      // A getter, not a snapshot: the role is resolved on the ws handshake and can
      // change on a reconnect, so a value captured at construction would go stale.
      get canWrite(): boolean {
        return host.canWrite
      },
      order: () => this.host.order(),
      object: (id) => this.cache.get(id),
      query: (rect) => this.index.search(rect),
      visibleObjects: () => this.visibleObjects(),
      selection: () => this.selected,
      setSelection: (ids) => this.setSelection(ids),
      setMarquee: (rect) => {
        this.marquee = rect
      },
      setGuides: (guides) => {
        this.guides = guides
      },
      createObject: (input) => this.host.createObject(input),
      applyPatches: (patches) => this.host.applyPatches(patches),
      commit: () => this.host.commit(),
      requestRender: () => this.requestRender(),
      setCursor: (cursor) => this.setCursor(cursor),
    }
  }

  private visibleObjects(): ObjectData[] {
    const rect = this.camera.visibleWorld(this.viewportWidth, this.viewportHeight)
    const out: ObjectData[] = []
    for (const id of this.index.search(rect)) {
      const object = this.cache.get(id)
      if (object !== undefined) out.push(object)
    }
    return out
  }

  private setCursor(cursor: string): void {
    if (this.app !== undefined) this.app.canvas.style.cursor = cursor
  }

  // --- render loop ------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)

    if (this.camera.version !== this.lastCameraVersion) {
      this.lastCameraVersion = this.camera.version
      this.dirty = true
      this.events.onCameraChange?.({
        x: this.camera.x,
        y: this.camera.y,
        zoom: this.camera.zoom,
      })
    }

    if (!this.dirty) return
    this.dirty = false

    const start = performance.now()
    this.render()
    this.app.render()
    this.lastRenderMs = performance.now() - start
  }

  private render(): void {
    // One container transform carries the camera for the whole scene, so panning and
    // zooming never touch per-object state.
    this.world.position.set(-this.camera.x * this.camera.zoom, -this.camera.y * this.camera.zoom)
    this.world.scale.set(this.camera.zoom)

    this.ensureCapacity()

    const visible = new Set(
      this.index.search(this.camera.visibleWorld(this.viewportWidth, this.viewportHeight, 64)),
    )

    // Walk the z-order so painting order matches `order`, and skip anything culled.
    this.batch.begin()
    let drawn = 0
    for (const id of this.host.order()) {
      if (!visible.has(id)) continue
      const object = this.cache.get(id)
      if (object === undefined) continue
      const kind = shapeKindFor(object.type)
      if (kind === null) continue

      const style = resolveStyle(object, kind)
      this.batch.push({
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        rotation: object.rotation,
        kind: style.kind,
        fill: style.fill,
        fillAlpha: style.fillAlpha,
        stroke: style.stroke,
        strokeAlpha: style.strokeAlpha,
        strokeWidth: style.strokeWidth,
        radius: style.radius,
      })
      drawn += 1
    }
    this.batch.end()
    this.lastVisible = drawn

    this.drawOverlay()
  }

  private ensureCapacity(): void {
    const needed = this.cache.size
    if (needed <= this.batch.capacity) return

    // Grow with headroom, so a board being filled in does not reallocate every add.
    const next = Math.max(MIN_BATCH_CAPACITY, Math.ceil(needed * 1.5))
    this.world.removeChild(this.batch.view)
    this.batch.destroy()
    this.batch = new ShapeBatch(next)
    this.world.addChild(this.batch.view)
  }

  /**
   * Selection chrome, drawn in screen space.
   *
   * Handles must stay the same pixel size at every zoom, so this cannot live in the
   * world container. It reads the same camera to project, never a second copy.
   */
  private drawOverlay(): void {
    const graphics = this.overlay
    graphics.clear()

    for (const guide of this.guides) {
      const isVertical = guide.axis === 'x'
      const from = this.camera.worldToScreen(
        isVertical ? guide.position : guide.from,
        isVertical ? guide.from : guide.position,
      )
      const to = this.camera.worldToScreen(
        isVertical ? guide.position : guide.to,
        isVertical ? guide.to : guide.position,
      )
      graphics.moveTo(from.x, from.y).lineTo(to.x, to.y)
    }
    if (this.guides.length > 0) graphics.stroke({ width: 1, color: GUIDE_COLOR })

    if (this.marquee !== null) {
      const topLeft = this.camera.worldToScreen(this.marquee.minX, this.marquee.minY)
      const bottomRight = this.camera.worldToScreen(this.marquee.maxX, this.marquee.maxY)
      graphics
        .rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
        .fill({ color: MARQUEE_FILL, alpha: 0.08 })
        .stroke({ width: 1, color: SELECTION_COLOR, alpha: 0.7 })
    }

    const selectedObjects: ObjectData[] = []
    for (const id of this.selected) {
      const object = this.cache.get(id)
      if (object !== undefined) selectedObjects.push(object)
    }
    if (selectedObjects.length === 0) return

    // Outline each member of a multi-selection, plus the union box the handles act on.
    if (selectedObjects.length > 1) {
      for (const object of selectedObjects) {
        const bounds = objectBounds(object)
        const topLeft = this.camera.worldToScreen(bounds.minX, bounds.minY)
        const bottomRight = this.camera.worldToScreen(bounds.maxX, bounds.maxY)
        graphics.rect(
          topLeft.x,
          topLeft.y,
          bottomRight.x - topLeft.x,
          bottomRight.y - topLeft.y,
        )
      }
      graphics.stroke({ width: 1, color: SELECTION_COLOR, alpha: 0.4 })
    }

    const box = unionBounds(selectedObjects)
    if (box === null) return

    const topLeft = this.camera.worldToScreen(box.minX, box.minY)
    const bottomRight = this.camera.worldToScreen(box.maxX, box.maxY)
    graphics
      .rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
      .stroke({ width: 1.5, color: SELECTION_COLOR })

    if (!this.host.canWrite) return

    const positions = handlePositions(box)
    const half = HANDLE_SIZE_PX / 2

    const rotate = this.camera.worldToScreen(positions.rotate.x, positions.rotate.y)
    graphics
      .circle(rotate.x, rotate.y - ROTATE_HANDLE_OFFSET_PX, half)
      .fill({ color: 0xffffff })
      .stroke({ width: 1.5, color: SELECTION_COLOR })

    for (const id of RESIZE_HANDLES) {
      const point = this.camera.worldToScreen(positions[id].x, positions[id].y)
      graphics.rect(point.x - half, point.y - half, HANDLE_SIZE_PX, HANDLE_SIZE_PX)
    }
    graphics.fill({ color: 0xffffff }).stroke({ width: 1.5, color: SELECTION_COLOR })
  }

  // --- input ------------------------------------------------------------------

  private toCanvasPoint(event: PointerEvent | WheelEvent): Point {
    const rect = this.app.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private toPointerEvent(event: PointerEvent): CanvasPointerEvent {
    const screen = this.toCanvasPoint(event)
    return {
      screen,
      world: this.camera.screenToWorld(screen.x, screen.y),
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      button: event.button,
      pointerId: event.pointerId,
    }
  }

  private onPointerDown = (event: PointerEvent): void => {
    // Middle-click pans regardless of tool, the convention every canvas app shares.
    if (event.button === 1 || this.spacePanning) {
      this.beginTemporaryPan()
    } else if (event.button !== 0) {
      return
    }

    this.app.canvas.setPointerCapture(event.pointerId)
    this.tool.onPointerDown(this.toPointerEvent(event))
  }

  private onPointerMove = (event: PointerEvent): void => {
    this.tool.onPointerMove(this.toPointerEvent(event))
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (this.app.canvas.hasPointerCapture(event.pointerId)) {
      this.app.canvas.releasePointerCapture(event.pointerId)
    }
    this.tool.onPointerUp(this.toPointerEvent(event))
    this.endTemporaryPan()
  }

  private temporaryPanFrom: ToolId | null = null

  private beginTemporaryPan(): void {
    if (this.temporaryPanFrom !== null || this.toolId === 'hand') return
    this.temporaryPanFrom = this.toolId
    this.setTool('hand')
  }

  private endTemporaryPan(): void {
    if (this.temporaryPanFrom === null || this.spacePanning) return
    this.setTool(this.temporaryPanFrom)
    this.temporaryPanFrom = null
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const point = this.toCanvasPoint(event)

    // Ctrl or meta plus wheel is zoom. A trackpad pinch arrives as ctrl+wheel too,
    // which is why both map to the same gesture.
    if (event.ctrlKey || event.metaKey) {
      this.camera.zoomBy(point.x, point.y, Math.exp(-event.deltaY * 0.01))
    } else if (event.shiftKey) {
      this.camera.panByScreen(-event.deltaY, 0)
    } else {
      this.camera.panByScreen(-event.deltaX, -event.deltaY)
    }
    this.requestRender()
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    // Never steal keys from a text field. M3 adds real text editing on top of this.
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA')
    ) {
      return
    }

    const accel = event.ctrlKey || event.metaKey

    if (event.code === 'Space' && !this.spacePanning) {
      this.spacePanning = true
      this.beginTemporaryPan()
      event.preventDefault()
      return
    }

    if (accel && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) this.host.redo()
      else this.host.undo()
      return
    }
    if (accel && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      this.selectAll()
      return
    }
    if (accel && event.key === ']') {
      event.preventDefault()
      this.host.bringToFront(this.getSelection())
      return
    }
    if (accel && event.key === '[') {
      event.preventDefault()
      this.host.sendToBack(this.getSelection())
      return
    }

    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        this.deleteSelection()
        return
      case 'Escape':
        this.tool.cancel?.()
        this.setSelection([])
        return
      case ']':
        this.host.bringForward(this.getSelection())
        return
      case '[':
        this.host.sendBackward(this.getSelection())
        return
      case '0':
        this.resetZoom()
        return
      case '1':
        this.zoomToFit()
        return
      case 'v':
      case 'V':
        this.setTool('select')
        return
      case 'h':
      case 'H':
        this.setTool('hand')
        return
      case 'r':
      case 'R':
        this.setTool('rect')
        return
      case 'o':
      case 'O':
        this.setTool('ellipse')
        return
      case 'd':
      case 'D':
        this.setTool('diamond')
        return
      default:
        this.tool.onKeyDown?.(event)
    }
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return
    this.spacePanning = false
    this.endTemporaryPan()
  }

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
  }

  private attachInput(): void {
    const canvas = this.app.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  private detachInput(): void {
    const canvas = this.app?.canvas
    if (canvas !== undefined) {
      canvas.removeEventListener('pointerdown', this.onPointerDown)
      canvas.removeEventListener('pointermove', this.onPointerMove)
      canvas.removeEventListener('pointerup', this.onPointerUp)
      canvas.removeEventListener('pointercancel', this.onPointerUp)
      canvas.removeEventListener('wheel', this.onWheel)
      canvas.removeEventListener('contextmenu', this.onContextMenu)
    }
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }
}
