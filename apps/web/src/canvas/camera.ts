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

export class Camera {
  x = 0
  y = 0
  zoom = 1

  /** Bumped on every change, so a renderer can tell whether it needs to redraw. */
  version = 0

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
  }

  reset(): void {
    this.x = 0
    this.y = 0
    this.zoom = 1
    this.version += 1
  }
}
