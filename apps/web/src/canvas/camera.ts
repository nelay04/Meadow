/**
 * The camera. ARCHITECTURE 5.
 *
 *   screen = (world - camera.xy) * zoom
 *   world  = screen / zoom + camera.xy
 *
 * There is exactly one camera per canvas, and both layers read it: the WebGL scene
 * through a container transform, and the DOM overlay in M3 through a CSS transform.
 * Neither keeps its own copy. A parallel copy is how the two layers end up 1 to 2 px
 * apart at fractional zoom, which reads as a broken app rather than a rounding bug.
 */

export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 8

export type Point = { x: number; y: number }
export type WorldRect = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * The transform both layers actually render with.
 *
 *   screen = world * scale + t
 *
 * Same form as `worldToScreen`, with one difference: the translation is snapped to a
 * whole device pixel. That snap is the entire fix for overlay drift. The browser and
 * the GPU round a fractional translation differently, so two layers handed
 * `-camera.x * zoom` directly will sit up to a pixel apart at zoom 1.37 even though
 * they agree on the camera. Snapping once, here, and handing the result to both means
 * they cannot disagree.
 *
 * Deliberately not folded into the camera. The camera's position stays continuous,
 * because quantising it would round a fractional trackpad delta down to nothing and
 * the pan would stall. Input reads the continuous camera, rendering reads this. The
 * two differ by at most half a device pixel and that error never accumulates.
 */
export type ViewTransform = { tx: number; ty: number; scale: number }

export function viewTransform(camera: Camera, devicePixelRatio: number): ViewTransform {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1
  const snap = (value: number): number => Math.round(value * ratio) / ratio
  return {
    tx: snap(-camera.x * camera.zoom),
    ty: snap(-camera.y * camera.zoom),
    scale: camera.zoom,
  }
}

/** Project a world point with a `ViewTransform`. Chrome and the overlay share this. */
export function projectPoint(transform: ViewTransform, worldX: number, worldY: number): Point {
  return {
    x: worldX * transform.scale + transform.tx,
    y: worldY * transform.scale + transform.ty,
  }
}

/**
 * A fence the camera may not leave.
 *
 * What turns an endless surface into a page you write down: the horizontal range is
 * the column, the vertical range is the paper, and the zoom is held to a band around
 * the size the page was set at.
 *
 * Expressed in world units and applied by the camera rather than by whoever moved it,
 * because a camera can be moved from six places - a wheel, a pinch, the hand tool, a
 * keyboard shortcut, a fit, a reset - and a rule enforced at the call sites is a rule
 * that is missing from the seventh.
 */
export type CameraFence = {
  /** World x of the column's left edge. */
  left: number
  /** World x of its right edge. */
  right: number
  /** The lowest world y the top of the viewport may reach. */
  top: number
  /**
   * World y of the bottom of the paper. The camera stops when this reaches the bottom
   * of the window, so a page has an end you can see rather than running on forever.
   */
  bottom: number
  /**
   * The zoom range this camera is held to.
   *
   * It was one fixed zoom, on the reasoning that a zoom control over a column of text
   * is a font-size control wearing a magnifying glass. True, and beside the point: a
   * page you cannot zoom is a page somebody with tired eyes cannot read. The range is
   * narrow, so the measure the surface is built around still means something.
   */
  minZoom: number
  maxZoom: number
}

export class Camera {
  x = 0
  y = 0
  zoom = 1

  /** Bumped on every change, so a renderer can tell whether it needs to redraw. */
  version = 0

  private fence: CameraFence | null = null
  private viewW = 0
  private viewH = 0

  /**
   * Tell the camera how big the window is.
   *
   * Only a fenced camera cares: it has to re-centre a column when the window changes
   * width, and it cannot ask. Cheap enough to call every frame, and it does nothing
   * at all when the size has not moved.
   */
  setViewport(width: number, height: number): void {
    if (width === this.viewW && height === this.viewH) return
    this.viewW = width
    this.viewH = height
    this.constrain()
  }

  /** Fence the camera into a column, or pass null to free it. */
  setFence(fence: CameraFence | null): void {
    // A page opens at its top. `constrain` only stops the camera going above `top`, so
    // without this the first line would sit hard against the window's top edge and
    // under whatever floats there. Only from the origin, so re-fencing a camera
    // somebody has already scrolled does not throw their place away.
    if (fence !== null && this.y === 0) this.y = fence.top
    this.fence = fence
    this.constrain()
  }

  get fenced(): boolean {
    return this.fence !== null
  }

  /**
   * Pull the camera back inside its fence.
   *
   * Called after every move rather than instead of one: the move is still applied and
   * then corrected, so a pan that is half vertical and half horizontal keeps the half
   * that is allowed. Refusing the whole gesture instead makes a fenced board feel
   * stuck rather than guided.
   */
  private constrain(): void {
    const fence = this.fence
    if (fence === null || this.viewW <= 0) return

    const before = `${this.x}|${this.y}|${this.zoom}`
    this.zoom = Math.min(fence.maxZoom, Math.max(fence.minZoom, this.zoom))

    const column = fence.right - fence.left
    const visible = this.viewW / this.zoom
    this.x =
      visible >= column
        ? // Wider window than column: centre it, and the margins are the page's.
          fence.left - (visible - column) / 2
        : // Narrower: the column runs off the edge, so allow sideways movement inside
          // it and no further. A phone reads the same page, just less of it at a time.
          Math.min(Math.max(this.x, fence.left), fence.right - visible)

    // The last line stops at the bottom of the window, not the top of it. `top` wins
    // when the whole page fits on screen, or the page would jump away from its start.
    const floor = Math.max(fence.top, fence.bottom - this.viewH / this.zoom)
    this.y = Math.min(Math.max(this.y, fence.top), floor)

    if (`${this.x}|${this.y}|${this.zoom}` !== before) this.version += 1
  }

  /**
   * Put the top of the viewport at this world y, leaving x and the zoom alone.
   *
   * For a jump that is not a gesture: turning to another page of a lea opens it at its
   * first line. Fenced like any other move, so a page shorter than the window still
   * lands where the fence says rather than where the caller asked.
   */
  scrollTo(worldY: number): void {
    if (this.y === worldY) return
    this.y = worldY
    this.version += 1
    this.constrain()
  }

  screenToWorld(screenX: number, screenY: number): Point {
    return { x: screenX / this.zoom + this.x, y: screenY / this.zoom + this.y }
  }

  worldToScreen(worldX: number, worldY: number): Point {
    return { x: (worldX - this.x) * this.zoom, y: (worldY - this.y) * this.zoom }
  }

  /** Screen-space distance expressed in world units, for zoom-independent tolerances. */
  toWorldDistance(screenDistance: number): number {
    return screenDistance / this.zoom
  }

  panByScreen(dxScreen: number, dyScreen: number): void {
    this.x -= dxScreen / this.zoom
    this.y -= dyScreen / this.zoom
    this.version += 1
    this.constrain()
  }

  /**
   * Zoom about a screen point, so the world position under the cursor stays put.
   * Zooming to the viewport centre instead is the single most common way an
   * infinite canvas feels wrong.
   */
  zoomAt(screenX: number, screenY: number, nextZoom: number): void {
    const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextZoom))
    if (clamped === this.zoom) return

    const anchor = this.screenToWorld(screenX, screenY)
    this.zoom = clamped
    // Solve for the camera position that puts `anchor` back under the same pixel.
    this.x = anchor.x - screenX / clamped
    this.y = anchor.y - screenY / clamped
    this.version += 1
    this.constrain()
  }

  zoomBy(screenX: number, screenY: number, factor: number): void {
    this.zoomAt(screenX, screenY, this.zoom * factor)
  }

  setZoom(zoom: number, viewportWidth: number, viewportHeight: number): void {
    this.zoomAt(viewportWidth / 2, viewportHeight / 2, zoom)
  }

  /** The world rectangle currently on screen. This is the culling query. */
  visibleWorld(viewportWidth: number, viewportHeight: number, padding = 0): WorldRect {
    const pad = padding / this.zoom
    return {
      minX: this.x - pad,
      minY: this.y - pad,
      maxX: this.x + viewportWidth / this.zoom + pad,
      maxY: this.y + viewportHeight / this.zoom + pad,
    }
  }

  /** Frame a world rectangle, with a margin, clamped to the zoom range. */
  fit(rect: WorldRect, viewportWidth: number, viewportHeight: number, margin = 64): void {
    const width = Math.max(rect.maxX - rect.minX, 1)
    const height = Math.max(rect.maxY - rect.minY, 1)
    const zoom = Math.min(
      MAX_ZOOM,
      Math.max(
        MIN_ZOOM,
        Math.min((viewportWidth - margin * 2) / width, (viewportHeight - margin * 2) / height),
      ),
    )

    this.zoom = zoom
    this.x = (rect.minX + rect.maxX) / 2 - viewportWidth / 2 / zoom
    this.y = (rect.minY + rect.maxY) / 2 - viewportHeight / 2 / zoom
    this.version += 1
    this.constrain()
  }

  reset(): void {
    this.x = 0
    this.y = 0
    this.zoom = 1
    this.version += 1
    this.constrain()
  }
}
