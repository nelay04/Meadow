/**
 * Freehand ink. One `Graphics` for every stroke on the board, rebuilt only when the
 * ink itself changes.
 *
 * This is the third rendering strategy in the engine and the one furthest from the
 * other two, so the reasoning matters.
 *
 * The instanced batch exists because five thousand rectangles are five thousand draw
 * calls, and it can only draw what an SDF can express. A stroke is a polygon of a few
 * hundred points whose shape came out of somebody's wrist; there is no signed distance
 * field for that.
 *
 * The arrow pass rebuilds every frame because arrow geometry is genuinely dynamic:
 * move a box and every arrow bound to it moves. Ink is the opposite. A stroke is
 * finished the moment the pointer lifts and never changes again unless it is dragged,
 * so rebuilding it on every pan is work with a guaranteed identical result. So this
 * pass is invalidated rather than cleared: the geometry lives in world coordinates in
 * the world container, the camera moves the container, and a pan or a zoom over a
 * page of handwriting costs nothing at all.
 *
 * Two consequences worth stating.
 *
 * No culling. The pass holds every stroke, on screen or not, because a rebuild is
 * triggered by editing and not by looking, and culling would turn every pan back into
 * a rebuild. The cost is vertices held on the GPU for ink nobody is looking at, which
 * is the cheap side of that trade.
 *
 * And outlines are cached per stroke, keyed on the identity of the stored points
 * array. Yjs hands back the same array until somebody writes a new one, so adding the
 * five hundredth stroke to a board re-tessellates one stroke, not five hundred.
 */

import { Graphics } from 'pixi.js'

import { type FreedrawProps, strokeOutline } from '@meadow/schema'

export type InkDraw = {
  id: string
  /** Stored samples, relative to the stroke's own origin. Identity is the cache key. */
  points: readonly number[]
  /** Where those samples sit in the world. */
  x: number
  y: number
  /** Rotation about the stroke's centre, in radians. */
  rotation: number
  /** Half-extent of the object's box, for rotating about its centre. */
  halfW: number
  halfH: number
  props: FreedrawProps
  /** Colour after the theme has had its say, and alpha after the object's opacity. */
  color: number
  alpha: number
}

type CacheEntry = {
  points: readonly number[]
  tip: string
  size: number
  angle: number
  outline: number[][]
}

export class InkPass {
  readonly view = new Graphics()

  private readonly cache = new Map<string, CacheEntry>()
  private count = 0

  get drawn(): number {
    return this.count
  }

  /**
   * Replace everything this pass draws.
   *
   * Called on a change to the ink and not on a frame, so the loop can ask for a
   * hundred frames between two of these and pay nothing for them.
   */
  rebuild(strokes: Iterable<InkDraw>): void {
    this.view.clear()
    this.count = 0

    // Grouped by fill, the same rule the arrow pass follows: one `fill()` per colour
    // rather than per stroke. A page of handwriting is one colour, so it is one call.
    const groups = new Map<string, { color: number; alpha: number; polygons: number[][] }>()
    const live = new Set<string>()

    for (const stroke of strokes) {
      live.add(stroke.id)
      const outline = this.outlineFor(stroke)
      if (outline.length === 0) continue

      this.count += 1
      const key = `${stroke.color}|${stroke.alpha.toFixed(3)}`
      let group = groups.get(key)
      if (group === undefined) {
        group = { color: stroke.color, alpha: stroke.alpha, polygons: [] }
        groups.set(key, group)
      }
      // A stroke is a run of convex pieces rather than one polygon. See
      // `strokeOutline`: a self-crossing stroke has a self-crossing outline, and a
      // triangulator handed one of those fills the loops it encloses.
      for (const piece of outline) {
        if (piece.length >= 6) group.polygons.push(place(piece, stroke))
      }
    }

    for (const [id] of this.cache) if (!live.has(id)) this.cache.delete(id)

    for (const group of groups.values()) {
      for (const polygon of group.polygons) this.view.poly(polygon)
      this.view.fill({ color: group.color, alpha: group.alpha })
    }
  }

  /** The stroke's outline in its own space, tessellated at most once per edit. */
  private outlineFor(stroke: InkDraw): number[][] {
    const cached = this.cache.get(stroke.id)
    if (
      cached !== undefined &&
      cached.points === stroke.points &&
      cached.tip === stroke.props.tip &&
      cached.size === stroke.props.size &&
      cached.angle === stroke.props.angle
    ) {
      return cached.outline
    }

    const outline = strokeOutline(stroke.points, stroke.props)
    this.cache.set(stroke.id, {
      points: stroke.points,
      tip: stroke.props.tip,
      size: stroke.props.size,
      angle: stroke.props.angle,
      outline,
    })
    return outline
  }

  destroy(): void {
    this.cache.clear()
    this.view.destroy()
  }
}

/**
 * Move a stroke's outline from its own space into the world.
 *
 * Applied here rather than by giving each stroke its own container, because a
 * container per stroke is the per-object node count the batch exists to avoid. It is
 * also where rotation is honoured: a rotated stroke is the only case that costs more
 * than an add, and it is rare enough to be worth the branch.
 */
function place(outline: readonly number[], stroke: InkDraw): number[] {
  const out: number[] = new Array(outline.length)

  if (stroke.rotation === 0) {
    for (let index = 0; index + 1 < outline.length; index += 2) {
      out[index] = outline[index] + stroke.x
      out[index + 1] = outline[index + 1] + stroke.y
    }
    return out
  }

  const cos = Math.cos(stroke.rotation)
  const sin = Math.sin(stroke.rotation)
  const centreX = stroke.x + stroke.halfW
  const centreY = stroke.y + stroke.halfH

  for (let index = 0; index + 1 < outline.length; index += 2) {
    const dx = outline[index] + stroke.x - centreX
    const dy = outline[index + 1] + stroke.y - centreY
    out[index] = centreX + dx * cos - dy * sin
    out[index + 1] = centreY + dx * sin + dy * cos
  }
  return out
}
