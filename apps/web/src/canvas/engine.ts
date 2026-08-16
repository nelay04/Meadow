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

import {
  type BindingData,
  type ObjectData,
  absolutePoints,
  isArrowLike,
  isTextBearing,
  objectBounds,
  resolveArrowProps,
  resolveTextProps,
} from '@meadow/schema'
import { Application, Container, Graphics, Rectangle } from 'pixi.js'

import {
  Camera,
  type Point,
  type ViewTransform,
  type WorldRect,
  projectPoint,
  viewTransform,
} from './camera'
import { TextLayer } from './overlay/textLayer'
import { type Wanderer, type WandererSelection, WandererLayer } from './overlay/wandererLayer'
import { SpatialIndex } from './spatialIndex'
import { ArrowPass } from './renderers/arrowPass'
import { ShapeBatch } from './renderers/shapeBatch'
import type { SnapGuide } from './snapping'
import { whenFontsReady } from './text/measure'
import { FONT_STACKS } from './text/textStyle'
import {
  BINDING_COLOR,
  GUIDE_COLOR,
  MARQUEE_FILL,
  SELECTION_COLOR,
  readCanvasInk,
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
import { createArrowTool } from './tools/arrowTool'
import { createTextTool } from './tools/textTool'
import type { CanvasPointerEvent, Tool, ToolContext, ToolId } from './tools/types'

/**
 * Greedy word wrap for thumbnail text.
 *
 * Not a layout engine and not trying to be: the real wrapping is the browser's, in the
 * DOM overlay. This only has to put roughly the right words on roughly the right lines
 * at a size where a word is a few pixels wide.
 */
function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }

    let current = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current === '' ? word : `${current} ${word}`
      if (current !== '' && context.measureText(candidate).width > maxWidth) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    if (current !== '') lines.push(current)
  }

  return lines
}

/** Minimum instance capacity, so small boards do not reallocate on the first few adds. */
const MIN_BATCH_CAPACITY = 2048

/** Grid cell in world units at 1x, and the screen band its spacing is held inside. */
const GRID_BASE_WORLD = 20
const GRID_MIN_PX = 14
const GRID_MAX_PX = 56

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
  setArrowPoints(id: string, absolute: readonly number[]): void
  bindArrow(input: Omit<BindingData, 'id'>): void
  /** Static HTML for a text-bearing object, for the idle overlay. */
  textHtml(id: string): string
  /** Plain text for the same object, for thumbnails and anything non-visual. */
  textPlain(id: string): string
  /**
   * Mount a rich-text editor into an overlay element. Returns the teardown, or null
   * when this host cannot edit. The engine never learns what the editor is.
   */
  beginEdit(id: string, element: HTMLElement, onExit: () => void): (() => void) | null
}

export type EngineEvents = {
  onSelectionChange?(ids: string[]): void
  /** Fired only when the count changes, never on every geometry edit. */
  onObjectCountChange?(count: number): void
  onToolChange?(tool: ToolId): void
  onCameraChange?(camera: { x: number; y: number; zoom: number }): void
  /** The id of the object currently being text-edited, or null. */
  onEditingChange?(id: string | null): void
  /**
   * The pointer in world coordinates, or null when it leaves the canvas. Fires at the
   * raw event rate; throttling belongs to the consumer, which knows what it costs to
   * publish.
   */
  onPointerWorld?(point: Point | null): void
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
  private arrows!: ArrowPass
  private textLayer!: TextLayer
  private wanderers!: WandererLayer

  /** Remote presence. Ephemeral, never read from or written to the document. */
  private wandererState: readonly Wanderer[] = []

  /**
   * Auto-height measurements taken during a render, flushed after it.
   *
   * Writing to the document from inside the render walk would fire a Y observer that
   * marks the scene dirty while it is still being drawn. Collecting and flushing keeps
   * the write out of the render, and batches a screenful of text objects into one
   * transaction instead of one each.
   */
  private readonly pendingHeights = new Map<string, number>()

  private editing: { id: string; teardown(): void } | null = null
  private closingEditor = false

  /** Reused across frames so the render walk allocates nothing. */
  private readonly overlayObjects: { object: ObjectData; z: number }[] = []
  private lastTransform: ViewTransform = { tx: 0, ty: 0, scale: 1 }

  private tool!: Tool
  private toolId: ToolId = 'select'
  private readonly context: ToolContext

  private marquee: WorldRect | null = null
  private guides: readonly SnapGuide[] = []
  private hoverTarget: string | null = null

  private dirty = true
  private frame = 0
  private disposed = false
  private lastCameraVersion = -1
  private spacePanning = false

  /**
   * The theme's default connector colour, cached because it is read for every arrow
   * on every frame and `getComputedStyle` is not a per-frame call.
   */
  private canvasInk = 0x2a3340

  private resizeObserver: ResizeObserver | null = null

  private gridVisible = true
  private lastGridKey = ''

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
    // ARCHITECTURE 1: text metrics feed CRDT bounds, so the first frame must not be
    // measured against fallback faces. Waiting here is the cheapest way to guarantee
    // that; the alternative is every client writing a different height for the same
    // paragraph depending on how fast its fonts arrived.
    await whenFontsReady()
    if (this.disposed) return

    this.app = new Application()
    await this.app.init({
      resizeTo: this.element,
      // Transparent, so the host's CSS surface and its grid show through. The board's
      // background is a theme concern and CSS is where the theme lives; this also
      // keeps the grid out of `captureThumbnail`, which renders the stage and would
      // otherwise put graph paper behind every preview in the list.
      backgroundAlpha: 0,
      // On. The SDF batch antialiases itself in the fragment shader and does not need
      // this, but everything drawn as tessellated geometry does: arrows, lines, the
      // marquee, the selection box and its handles are all `Graphics`, and a
      // tessellated diagonal without multisampling is a staircase. That staircase is
      // the single most obvious difference between this canvas and a polished one.
      //
      // It costs fill rate rather than draw calls, so it does not move the 5k-object
      // budget the batch was built for. `pnpm bench:arrows` is the check if it ever
      // looks like it does.
      antialias: true,
      // The SDF shader is GLSL only for now. A WGSL twin is worth writing once the
      // approach has settled, not before.
      preference: 'webgl',
      autoDensity: true,
      // Render at device pixels, not CSS pixels. Without this a 2x display draws every
      // edge at half the resolution it can show and the result reads as soft and
      // steppy however good the antialiasing is.
      resolution: window.devicePixelRatio || 1,
      autoStart: false,
    })
    if (this.disposed) {
      this.app.destroy(true, { children: true })
      return
    }

    this.canvasInk = readCanvasInk(this.element)

    this.snapToDevicePixels()
    // The host's position changes with the window, and so does the rounding error.
    this.resizeObserver = new ResizeObserver(() => this.snapToDevicePixels())
    this.resizeObserver.observe(document.documentElement)

    // The overlay is positioned against this element, so it cannot be static.
    if (getComputedStyle(this.element).position === 'static') {
      this.element.style.position = 'relative'
    }

    this.element.appendChild(this.app.canvas)
    this.app.canvas.style.touchAction = 'none'
    this.app.canvas.style.display = 'block'

    this.textLayer = new TextLayer(this.element, {
      html: (id) => this.host.textHtml(id),
      onMeasured: (id, height) => {
        this.pendingHeights.set(id, height)
      },
    })
    this.textLayer.ink = this.canvasInk

    this.world = new Container()
    this.batch = new ShapeBatch(MIN_BATCH_CAPACITY)
    this.arrows = new ArrowPass()
    // Order is the z-order between the two passes, and it is fixed: connectors always
    // draw over shapes.
    this.world.addChild(this.batch.view)
    this.world.addChild(this.arrows.view)

    this.overlay = new Graphics()

    this.wanderers = new WandererLayer()

    this.app.stage.addChild(this.world)
    this.app.stage.addChild(this.overlay)
    // Above the selection chrome: a remote cursor is the one thing that should never
    // be hidden behind local UI.
    this.app.stage.addChild(this.wanderers.view)

    this.setTool('select')
    this.attachInput()
    this.resync()
    this.loop()
  }

  destroy(): void {
    this.disposed = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    cancelAnimationFrame(this.frame)
    this.stopEditing()
    this.detachInput()
    if (this.textLayer !== undefined) this.textLayer.destroy()
    if (this.wanderers !== undefined) this.wanderers.destroy()
    if (this.arrows !== undefined) this.arrows.destroy()
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

  /**
   * Nudge the host onto whole device pixels.
   *
   * At fractional display scaling - Windows at 125% or 150%, which is most Windows
   * machines - an element whose height is a round number of CSS pixels is a
   * *fractional* number of device pixels, so everything below it starts on a half
   * pixel. Measured on this layout at dpr 1.25: the canvas's top edge lands at 52.5
   * device pixels. The browser cannot blit a bitmap to half a pixel, so it resamples
   * the whole canvas, and the result is a board that is uniformly, slightly soft at
   * every zoom while the DOM chrome beside it stays sharp. DOM text escapes this
   * because the browser rasterises glyphs at their final subpixel position; a canvas
   * is one bitmap and has no such luxury.
   *
   * The correction is a sub-pixel translate on the host. Both layers live inside it -
   * the WebGL canvas and the DOM text overlay - so they move together and the
   * alignment `pnpm smoke:overlay` guards is untouched. Integer ratios need nothing
   * and get nothing.
   */
  private snapToDevicePixels(): void {
    if (this.disposed) return

    const ratio = window.devicePixelRatio || 1

    // Measure without our own correction applied, or each call compounds the last.
    this.element.style.transform = ''
    if (Number.isInteger(ratio)) return

    const rect = this.element.getBoundingClientRect()
    const dx = (Math.round(rect.left * ratio) - rect.left * ratio) / ratio
    const dy = (Math.round(rect.top * ratio) - rect.top * ratio) / ratio

    if (dx === 0 && dy === 0) return
    this.element.style.transform = `translate(${dx}px, ${dy}px)`
  }

  /**
   * Re-read the theme's canvas colour.
   *
   * WebGL cannot see the cascade, so the one surface that is not CSS has to be told.
   * Called by the board view when the theme toggle fires.
   */
  syncTheme(): void {
    if (this.app === undefined) return
    // Only the ink. The board's surface and its grid are CSS and re-resolve
    // themselves the moment the root's colour-scheme changes.
    this.canvasInk = readCanvasInk(this.element)
    this.textLayer.ink = this.canvasInk
    this.requestRender()
  }

  /** Show or hide the graph paper. Purely cosmetic; nothing else reads it. */
  setGridVisible(visible: boolean): void {
    this.gridVisible = visible
    this.element.classList.toggle('no-grid', !visible)
    if (visible) {
      // The class was toggled off while the camera moved, so the offsets are stale.
      this.lastGridKey = ''
      this.syncGrid(this.lastTransform)
    }
  }

  get gridShown(): boolean {
    return this.gridVisible
  }

  /**
   * Keep the CSS grid in step with the camera.
   *
   * The cell is chosen in world units so the grid means something - it is a ruler,
   * not a texture - but its *screen* spacing is held in a legible band by stepping
   * the world cell through powers of four. Zoomed far out the cells would otherwise
   * converge into a grey wash; zoomed far in there would be one line on screen.
   *
   * The offset is the camera's own translation modulo the spacing, taken from the
   * same device-pixel-snapped transform the two render layers use, so the grid never
   * shimmers against the shapes sitting on it.
   */
  private syncGrid(transform: ViewTransform): void {
    if (!this.gridVisible) return

    let world = GRID_BASE_WORLD
    let minor = world * transform.scale
    while (minor < GRID_MIN_PX) {
      world *= 4
      minor = world * transform.scale
    }
    while (minor > GRID_MAX_PX) {
      world /= 4
      minor = world * transform.scale
    }
    const major = minor * 4

    const phase = (offset: number, size: number): number => ((offset % size) + size) % size
    const minorX = phase(transform.tx, minor)
    const minorY = phase(transform.ty, minor)
    const majorX = phase(transform.tx, major)
    const majorY = phase(transform.ty, major)

    // One string compare instead of four style writes on a frame that did not move.
    const key = `${minor}|${minorX}|${minorY}|${majorX}|${majorY}`
    if (key === this.lastGridKey) return
    this.lastGridKey = key

    const style = this.element.style
    style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`
    style.backgroundPosition = `${majorX}px ${majorY}px, ${majorX}px ${majorY}px, ${minorX}px ${minorY}px, ${minorX}px ${minorY}px`
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
    if (this.textLayer !== undefined) this.textLayer.invalidateAll()
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
      if (this.editing?.id === id) this.stopEditing()
    }
    // A change to an object's `text` arrives here with the same id as a change to its
    // geometry, because observeDeep reports both under the object. The overlay is told
    // either way; re-serialising a fragment that did not change is cheap next to
    // tracking which of the two it was.
    if (this.textLayer !== undefined) this.textLayer.invalidate(changed)
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

  // --- text editing -----------------------------------------------------------

  get editingId(): string | null {
    return this.editing?.id ?? null
  }

  /**
   * The transform the last frame was drawn with.
   *
   * Exposed so a test can assert the WebGL scene and the DOM overlay were handed the
   * same numbers, which is the invariant the whole two-layer design rests on.
   */
  get renderTransform(): ViewTransform {
    return this.lastTransform
  }

  /** The overlay element for an object, or null when it is not mounted. */
  overlayElement(id: string): HTMLElement | null {
    return this.textLayer?.root.querySelector(`[data-object-id="${CSS.escape(id)}"]`) ?? null
  }

  /**
   * Enter text editing on an object. ARCHITECTURE 5, step 2 of the lifecycle.
   *
   * A render has to happen first. The editor mounts into the object's overlay element,
   * and that element only exists once the object has been through a sync, so a text
   * object created a microsecond ago has nowhere to put an editor yet.
   */
  beginTextEdit(id: string): boolean {
    const object = this.cache.get(id)
    if (object === undefined || !isTextBearing(object.type) || object.locked) return false
    if (this.editing?.id === id) return true

    this.stopEditing()
    this.setSelection([id])
    // Editing and a creation tool are mutually exclusive modes. Dropping back to
    // select means Escape leaves the user somewhere sensible.
    this.setTool('select')

    this.render()
    const element = this.textLayer.beginEdit(id)
    if (element === null) return false

    const teardown = this.host.beginEdit(id, element, () => this.stopEditing())
    if (teardown === null) {
      this.textLayer.endEdit()
      return false
    }

    this.editing = { id, teardown }
    this.events.onEditingChange?.(id)
    this.requestRender()
    return true
  }

  stopEditing(): void {
    const active = this.editing
    // The teardown blurs the editor, and blur is what called this. Without the guard
    // that recurses straight back in through the exit callback.
    if (active === null || this.closingEditor) return

    this.closingEditor = true
    try {
      active.teardown()
    } finally {
      this.editing = null
      this.closingEditor = false
    }

    this.textLayer.endEdit()
    this.host.commit()
    this.events.onEditingChange?.(null)
    this.requestRender()
    if (this.app !== undefined) this.app.canvas.focus()
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
      case 'text':
      case 'sticky':
        return createTextTool(this.context, id)
      case 'arrow':
      case 'line':
        return createArrowTool(this.context, id)
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
      setHoverTarget: (id) => {
        this.hoverTarget = id
      },
      createObject: (input) => this.host.createObject(input),
      applyPatches: (patches) => this.host.applyPatches(patches),
      setArrowPoints: (id, absolute) => this.host.setArrowPoints(id, absolute),
      bindArrow: (input) => this.host.bindArrow(input),
      commit: () => this.host.commit(),
      beginTextEdit: (id) => this.beginTextEdit(id),
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

    this.flushHeights()
  }

  /**
   * Push measured auto-heights into the document.
   *
   * Idempotent by construction: every client measures the same text with the same
   * fonts and arrives at the same number, so the first write settles it and the
   * tolerance in the text layer stops the rest. A read-only role never gets here,
   * because the host refuses the patch.
   */
  private flushHeights(): void {
    if (this.pendingHeights.size === 0) return

    const patches: { id: string; patch: Partial<ObjectData> }[] = []
    for (const [id, height] of this.pendingHeights) {
      const object = this.cache.get(id)
      if (object !== undefined && Math.abs(object.h - height) > 1) {
        patches.push({ id, patch: { h: height } })
      }
    }
    this.pendingHeights.clear()

    if (patches.length > 0 && this.host.canWrite) this.host.applyPatches(patches)
  }

  private render(): void {
    // One transform, snapped to device pixels once, handed to both layers. See
    // camera.ts: this is the whole reason the DOM text sits exactly on its shape.
    const transform = viewTransform(this.camera, window.devicePixelRatio || 1)
    this.lastTransform = transform

    this.world.position.set(transform.tx, transform.ty)
    this.world.scale.set(transform.scale)

    this.ensureCapacity()

    const visible = new Set(
      this.index.search(this.camera.visibleWorld(this.viewportWidth, this.viewportHeight, 64)),
    )

    this.lastVisible = this.paintScene(visible)

    this.syncGrid(transform)
    this.textLayer.sync(transform, this.overlayObjects)
    this.drawOverlay(transform)
    this.drawWanderers(transform)
  }

  /**
   * Render the whole board, fitted, as a small image for the board list.
   *
   * Two things make this more than an `extract` call.
   *
   * Culling has to be off. The live scene only ever holds the objects on screen, and a
   * thumbnail wants the ones that are not.
   *
   * And text lives in the DOM overlay, not in WebGL, so extracting the canvas alone
   * produces a board with every sticky note blank. The glyphs are drawn on afterwards
   * with plain 2D canvas text. Fidelity is not the goal at this size; a thumbnail that
   * shows where the writing is beats one that pretends there is none.
   */
  async captureThumbnail(maxDimension = 512): Promise<Blob | null> {
    if (this.app === undefined || this.cache.size === 0) return null

    const bounds = unionBounds(Array.from(this.cache.values()))
    if (bounds === null) return null

    const worldWidth = Math.max(bounds.maxX - bounds.minX, 1)
    const worldHeight = Math.max(bounds.maxY - bounds.minY, 1)
    // Never upscale. A board with three small shapes should produce a small image, not
    // a blurry large one.
    const scale = Math.min(maxDimension / worldWidth, maxDimension / worldHeight, 1)
    const width = Math.max(1, Math.round(worldWidth * scale))
    const height = Math.max(1, Math.round(worldHeight * scale))

    const transform: ViewTransform = { tx: -bounds.minX * scale, ty: -bounds.minY * scale, scale }

    // Chrome and presence are this client's own state, not the board's.
    const overlayVisible = this.overlay.visible
    const wanderersVisible = this.wanderers.view.visible
    this.overlay.visible = false
    this.wanderers.view.visible = false

    let source: HTMLCanvasElement
    try {
      this.world.position.set(transform.tx, transform.ty)
      this.world.scale.set(transform.scale)
      this.ensureCapacity()
      this.paintScene(null)

      source = this.app.renderer.extract.canvas({
        target: this.app.stage,
        frame: new Rectangle(0, 0, width, height),
        resolution: 1,
      }) as HTMLCanvasElement
    } finally {
      this.overlay.visible = overlayVisible
      this.wanderers.view.visible = wanderersVisible
      // The scene is now painted for the thumbnail rather than for the viewport, so
      // the next frame has to rebuild it.
      this.requestRender()
    }

    const surface = document.createElement('canvas')
    surface.width = width
    surface.height = height
    const context = surface.getContext('2d')
    if (context === null) return null

    // No paper under it. A thumbnail is captured once and served to everyone, so a
    // baked-in background is one client's theme imposed on every viewer: it showed up
    // as a white slab on a dark board list. Left transparent, the card's own well
    // shows through and the preview takes the reader's theme, not the author's.
    // webp carries alpha, so this survives the encode.
    context.drawImage(source, 0, 0, width, height)

    this.paintThumbnailText(context, transform)

    return await new Promise((resolve) => {
      // webp over png: a canvas of flat fills compresses far better, and the endpoint
      // accepts both.
      surface.toBlob((blob) => resolve(blob), 'image/webp', 0.8)
    })
  }

  /** Plain text for the thumbnail, since the real text is DOM and not in the capture. */
  private paintThumbnailText(context: CanvasRenderingContext2D, transform: ViewTransform): void {
    for (const { object } of this.overlayObjects) {
      const props = resolveTextProps(object)
      const size = props.fontSize * transform.scale
      // Below about three pixels a glyph is noise. Skipping is more honest than
      // drawing a grey smear where words would be.
      if (size < 3) continue

      const text = this.host.textPlain(object.id)
      if (text === '') continue

      const topLeft = projectPoint(transform, object.x, object.y)
      const boxWidth = object.w * transform.scale
      const boxHeight = object.h * transform.scale
      const padding = props.padding * transform.scale

      context.save()
      context.beginPath()
      context.rect(topLeft.x, topLeft.y, boxWidth, boxHeight)
      context.clip()

      context.fillStyle = `#${(props.color >>> 0).toString(16).padStart(6, '0').slice(-6)}`
      context.font = `${size}px ${FONT_STACKS[props.fontFamily]}`
      context.textAlign = props.align === 'center' ? 'center' : props.align === 'right' ? 'right' : 'left'
      context.textBaseline = 'top'

      const anchorX =
        props.align === 'center'
          ? topLeft.x + boxWidth / 2
          : props.align === 'right'
            ? topLeft.x + boxWidth - padding
            : topLeft.x + padding

      const lineHeight = size * props.lineHeight
      let y = topLeft.y + padding
      for (const line of wrapText(context, text, boxWidth - padding * 2)) {
        if (y > topLeft.y + boxHeight) break
        context.fillText(line, anchorX, y)
        y += lineHeight
      }

      context.restore()
    }
  }

  /**
   * Fill the batch and the arrow pass from the z-order.
   *
   * `visible` is the cull set, or null to paint everything regardless of the camera.
   * The thumbnail pass needs the second: it renders the whole board fitted into a
   * small frame, so the objects it wants are exactly the ones culling would drop.
   */
  private paintScene(visible: ReadonlySet<string> | null): number {
    this.batch.begin()
    this.arrows.begin()
    this.overlayObjects.length = 0
    let drawn = 0
    let depth = 0
    for (const id of this.host.order()) {
      depth += 1
      if (visible !== null && !visible.has(id)) continue
      const object = this.cache.get(id)
      if (object === undefined) continue

      // A text-bearing object is drawn twice on purpose: the batch paints its box, the
      // DOM overlay paints its glyphs on top. A sticky note is a rounded rectangle
      // plus real selectable text, not a picture of one.
      if (isTextBearing(object.type)) this.overlayObjects.push({ object, z: depth })

      if (isArrowLike(object.type)) {
        const style = resolveArrowProps(object)
        this.arrows.push({
          points: absolutePoints(object, style),
          // A connector that never chose a colour follows the theme; one that did
          // keeps what the document says, in both themes.
          stroke: typeof object.props.stroke === 'number' ? style.stroke : this.canvasInk,
          strokeAlpha: style.strokeAlpha * object.opacity,
          strokeWidth: style.strokeWidth,
          startHead: style.startHead,
          endHead: style.endHead,
          headSize: style.headSize,
        })
        drawn += 1
        continue
      }

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
    this.arrows.end()
    return drawn
  }

  private ensureCapacity(): void {
    const needed = this.cache.size
    if (needed <= this.batch.capacity) return

    // Grow with headroom, so a board being filled in does not reallocate every add.
    const next = Math.max(MIN_BATCH_CAPACITY, Math.ceil(needed * 1.5))
    this.world.removeChild(this.batch.view)
    this.batch.destroy()
    this.batch = new ShapeBatch(next)
    // At index 0, not appended: appending would put the shapes over the arrows and
    // silently invert the layer order the first time a board outgrew its capacity.
    this.world.addChildAt(this.batch.view, 0)
  }

  /**
   * Selection chrome, drawn in screen space.
   *
   * Handles must stay the same pixel size at every zoom, so this cannot live in the
   * world container. It reads the same camera to project, never a second copy.
   */
  private drawOverlay(transform: ViewTransform): void {
    const graphics = this.overlay
    graphics.clear()

    for (const guide of this.guides) {
      const isVertical = guide.axis === 'x'
      const from = projectPoint(transform, 
        isVertical ? guide.position : guide.from,
        isVertical ? guide.from : guide.position,
      )
      const to = projectPoint(transform, 
        isVertical ? guide.position : guide.to,
        isVertical ? guide.to : guide.position,
      )
      graphics.moveTo(from.x, from.y).lineTo(to.x, to.y)
    }
    if (this.guides.length > 0) graphics.stroke({ width: 1, color: GUIDE_COLOR })

    // What an arrow end would attach to. Drawn before the selection chrome so a
    // selected shape's own outline stays on top of it.
    if (this.hoverTarget !== null) {
      const target = this.cache.get(this.hoverTarget)
      if (target !== undefined) {
        const bounds = objectBounds(target)
        const topLeft = projectPoint(transform, bounds.minX, bounds.minY)
        const bottomRight = projectPoint(transform, bounds.maxX, bounds.maxY)
        graphics
          .rect(
            topLeft.x - 2,
            topLeft.y - 2,
            bottomRight.x - topLeft.x + 4,
            bottomRight.y - topLeft.y + 4,
          )
          .stroke({ width: 2, color: BINDING_COLOR, alpha: 0.9 })
      }
    }

    if (this.marquee !== null) {
      const topLeft = projectPoint(transform, this.marquee.minX, this.marquee.minY)
      const bottomRight = projectPoint(transform, this.marquee.maxX, this.marquee.maxY)
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
        const topLeft = projectPoint(transform, bounds.minX, bounds.minY)
        const bottomRight = projectPoint(transform, bounds.maxX, bounds.maxY)
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

    const topLeft = projectPoint(transform, box.minX, box.minY)
    const bottomRight = projectPoint(transform, box.maxX, box.maxY)
    graphics
      .rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
      .stroke({ width: 1.5, color: SELECTION_COLOR })

    if (!this.host.canWrite) return

    const positions = handlePositions(box)
    const half = HANDLE_SIZE_PX / 2

    const rotate = projectPoint(transform, positions.rotate.x, positions.rotate.y)
    graphics
      .circle(rotate.x, rotate.y - ROTATE_HANDLE_OFFSET_PX, half)
      .fill({ color: 0xffffff })
      .stroke({ width: 1.5, color: SELECTION_COLOR })

    for (const id of RESIZE_HANDLES) {
      const point = projectPoint(transform, positions[id].x, positions[id].y)
      graphics.rect(point.x - half, point.y - half, HANDLE_SIZE_PX, HANDLE_SIZE_PX)
    }
    graphics.fill({ color: 0xffffff }).stroke({ width: 1.5, color: SELECTION_COLOR })
  }

  /**
   * Remote presence for the next frame.
   *
   * Stored and drawn rather than pushed straight to the layer, because awareness
   * arrives on its own schedule and rendering on receipt would break the one-render-
   * per-frame rule for the busiest message on the socket.
   */
  setWanderers(wanderers: readonly Wanderer[]): void {
    this.wandererState = wanderers
    this.requestRender()
  }

  private drawWanderers(transform: ViewTransform): void {
    if (this.wandererState.length === 0) {
      this.wanderers.drawSelections(transform, [])
      this.wanderers.drawCursors(transform, [])
      return
    }

    const selections: WandererSelection[] = []
    for (const wanderer of this.wandererState) {
      for (const id of wanderer.selection) {
        const object = this.cache.get(id)
        // Silently skipped when the object is unknown here: a peer can have something
        // selected that this client has not loaded yet, or has already seen deleted.
        if (object !== undefined) {
          selections.push({ color: wanderer.color, bounds: objectBounds(object) })
        }
      }
    }

    this.wanderers.drawSelections(transform, selections)
    this.wanderers.drawCursors(transform, this.wandererState)
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
    const canvasEvent = this.toPointerEvent(event)
    this.events.onPointerWorld?.(canvasEvent.world)
    this.tool.onPointerMove(canvasEvent)
  }

  private onPointerLeave = (): void => {
    this.events.onPointerWorld?.(null)
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
        this.stopEditing()
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
      case 't':
      case 'T':
        this.setTool('text')
        return
      case 's':
      case 'S':
        this.setTool('sticky')
        return
      case 'a':
      case 'A':
        this.setTool('arrow')
        return
      case 'l':
      case 'L':
        this.setTool('line')
        return
      case 'Enter':
        // Enter edits the selected text object, the keyboard equivalent of a
        // double-click. Ignored for anything else.
        if (this.selected.size === 1) {
          const [id] = this.selected
          if (this.beginTextEdit(id)) event.preventDefault()
        }
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

  /**
   * Double-click enters text editing. ARCHITECTURE 5, step 2.
   *
   * Only text-bearing types respond. Double-clicking a rectangle does nothing rather
   * than growing a text field on it, because "everything is secretly a text box" is
   * the behaviour that makes a canvas feel unpredictable.
   */
  private onDoubleClick = (event: MouseEvent): void => {
    const screen = this.toCanvasPoint(event as unknown as PointerEvent)
    const world = this.camera.screenToWorld(screen.x, screen.y)
    const tolerance = this.camera.toWorldDistance(8)

    const rect = {
      minX: world.x - tolerance,
      minY: world.y - tolerance,
      maxX: world.x + tolerance,
      maxY: world.y + tolerance,
    }
    const candidates = new Set(this.index.search(rect))

    // Reverse z-order: the topmost object under the pointer wins, same rule as a click.
    const order = this.host.order()
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const id = order[index]
      if (!candidates.has(id)) continue
      const object = this.cache.get(id)
      if (object === undefined || !isTextBearing(object.type)) continue

      event.preventDefault()
      this.beginTextEdit(id)
      return
    }
  }

  private attachInput(): void {
    const canvas = this.app.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('dblclick', this.onDoubleClick)
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
      canvas.removeEventListener('pointerleave', this.onPointerLeave)
      canvas.removeEventListener('dblclick', this.onDoubleClick)
      canvas.removeEventListener('contextmenu', this.onContextMenu)
    }
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }
}
