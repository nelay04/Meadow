/**
 * Arrows and lines. One `Graphics`, cleared and rebuilt every frame.
 *
 * Deliberately outside the instanced SDF batch, and the reasoning is worth keeping
 * because it looks inconsistent with ARCHITECTURE 5 otherwise. The batch exists
 * because 5,000 rectangles at one draw call each is 5,000 draw calls. Arrows do not
 * have that shape of problem: a board has tens of them against thousands of shapes, so
 * their draw calls are noise. What they do have is genuinely dynamic geometry, since
 * every endpoint can move when an unrelated object is dragged, and an instanced
 * renderer is exactly the wrong tool for that.
 *
 * One shared Graphics rather than one per arrow. Fewer nodes for Pixi to walk, and
 * re-recording a few hundred short paths is cheap. `pnpm bench:arrows` measures the
 * case that would disprove this: one arrow moving among two hundred static ones. If
 * that ever goes over budget the answer is dirty-rect rebuilding, not per-arrow
 * Graphics objects.
 *
 * Heads are part of the path, not sprites. Once the pass is not batched, the sprite
 * batching win is worth nothing, and a path head rotates and scales correctly for
 * free.
 *
 * **Arrows always draw above shapes.** The pass is a sibling of the batch, added
 * after, so z-order between an arrow and a rectangle is not expressible. That is a
 * chosen constraint, not an oversight. See ARCHITECTURE 5 for what it costs.
 */

import { Graphics } from 'pixi.js'

import type { ArrowHead } from '@meadow/schema'

export type ArrowDraw = {
  /** Flat [x0,y0,x1,y1,...] in world coordinates. At least two points. */
  points: readonly number[]
  stroke: number
  strokeAlpha: number
  strokeWidth: number
  startHead: ArrowHead
  endHead: ArrowHead
  headSize: number
}

/** Half-angle of the head, in radians. 22 degrees reads as an arrow rather than a wedge. */
const HEAD_ANGLE = 0.384

/**
 * Everything drawn with one stroke style, accumulated before any of it is recorded.
 *
 * ARCHITECTURE 5 again: batch by material, not by logical object. The first version of
 * this issued a `stroke()` and a `fill()` per arrow and cost 19 microseconds each,
 * because every call is a separate tessellated instruction that cannot merge with its
 * neighbour. Grouping first collapses a whole board to a handful, since real documents
 * use a handful of stroke styles however many arrows they contain.
 */
type StyleGroup = {
  stroke: number
  strokeAlpha: number
  strokeWidth: number
  /** Polylines to stroke, each a flat point array. */
  shafts: number[][]
  /** Triangles to fill, each a flat point array. */
  solidHeads: number[][]
  /** Open heads, stroked with the same style as the shaft. */
  openHeads: number[][]
}

export class ArrowPass {
  readonly view = new Graphics()

  private count = 0
  private readonly groups = new Map<string, StyleGroup>()

  begin(): void {
    this.view.clear()
    this.count = 0
    this.groups.clear()
  }

  get drawn(): number {
    return this.count
  }

  push(arrow: ArrowDraw): void {
    const points = arrow.points
    if (points.length < 4) return

    this.count += 1

    const key = `${arrow.stroke}|${arrow.strokeAlpha}|${arrow.strokeWidth}`
    let group = this.groups.get(key)
    if (group === undefined) {
      group = {
        stroke: arrow.stroke,
        strokeAlpha: arrow.strokeAlpha,
        strokeWidth: arrow.strokeWidth,
        shafts: [],
        solidHeads: [],
        openHeads: [],
      }
      this.groups.set(key, group)
    }

    // The shaft stops short of a solid head, so the stroke's own round cap does not
    // poke out of the tip. An open head is two lines and needs no trim.
    const endTrim = arrow.endHead === 'triangle' ? arrow.headSize * 0.85 : 0
    const startTrim = arrow.startHead === 'triangle' ? arrow.headSize * 0.85 : 0
    group.shafts.push(trimEnds(points, startTrim, endTrim))

    const last = points.length - 2
    if (arrow.endHead !== 'none') {
      this.head(
        group,
        arrow,
        points[last],
        points[last + 1],
        Math.atan2(points[last + 1] - points[last - 1], points[last] - points[last - 2]),
        arrow.endHead,
      )
    }
    if (arrow.startHead !== 'none') {
      this.head(
        group,
        arrow,
        points[0],
        points[1],
        Math.atan2(points[1] - points[3], points[0] - points[2]),
        arrow.startHead,
      )
    }
  }

  /** Record every group. Two stroke calls and one fill call per style, not per arrow. */
  end(): void {
    for (const group of this.groups.values()) {
      const style = {
        width: group.strokeWidth,
        color: group.stroke,
        alpha: group.strokeAlpha,
        cap: 'round' as const,
        join: 'round' as const,
      }

      if (group.shafts.length > 0 || group.openHeads.length > 0) {
        for (const path of group.shafts) this.trace(path)
        for (const path of group.openHeads) this.trace(path)
        this.view.stroke(style)
      }

      if (group.solidHeads.length > 0) {
        for (const triangle of group.solidHeads) this.view.poly(triangle)
        this.view.fill({ color: group.stroke, alpha: group.strokeAlpha })
      }
    }
  }

  private trace(path: readonly number[]): void {
    this.view.moveTo(path[0], path[1])
    for (let index = 2; index + 1 < path.length; index += 2) {
      this.view.lineTo(path[index], path[index + 1])
    }
  }

  /** `angle` points along the direction of travel, so the head opens backwards from it. */
  private head(
    group: StyleGroup,
    arrow: ArrowDraw,
    tipX: number,
    tipY: number,
    angle: number,
    kind: ArrowHead,
  ): void {
    const size = arrow.headSize
    const leftX = tipX - size * Math.cos(angle - HEAD_ANGLE)
    const leftY = tipY - size * Math.sin(angle - HEAD_ANGLE)
    const rightX = tipX - size * Math.cos(angle + HEAD_ANGLE)
    const rightY = tipY - size * Math.sin(angle + HEAD_ANGLE)

    if (kind === 'open') {
      group.openHeads.push([leftX, leftY, tipX, tipY, rightX, rightY])
      return
    }

    group.solidHeads.push([tipX, tipY, leftX, leftY, rightX, rightY])
  }

  destroy(): void {
    this.view.destroy()
  }
}

/**
 * Shorten a polyline at each end by a distance along its own direction.
 *
 * Walks segments rather than moving the endpoint straight towards its neighbour,
 * because on an orthogonal route the trim can be longer than the final segment, and
 * cutting only that segment would leave the shaft bent away from the head.
 */
export function trimEnds(
  points: readonly number[],
  startTrim: number,
  endTrim: number,
): number[] {
  let out = Array.from(points)
  if (endTrim > 0) out = trimTail(out, endTrim)
  if (startTrim > 0) out = trimTail(reversePoints(out), startTrim)
  return startTrim > 0 ? reversePoints(out) : out
}

function reversePoints(points: readonly number[]): number[] {
  const out: number[] = new Array(points.length)
  for (let index = 0; index + 1 < points.length; index += 2) {
    out[points.length - 2 - index] = points[index]
    out[points.length - 1 - index] = points[index + 1]
  }
  return out
}

function trimTail(points: number[], distance: number): number[] {
  let remaining = distance

  while (points.length >= 4) {
    const last = points.length - 2
    const dx = points[last] - points[last - 2]
    const dy = points[last + 1] - points[last - 1]
    const length = Math.hypot(dx, dy)

    if (length === 0) {
      points = points.slice(0, last)
      continue
    }

    if (length > remaining) {
      const scale = (length - remaining) / length
      points[last] = points[last - 2] + dx * scale
      points[last + 1] = points[last - 1] + dy * scale
      return points
    }

    // The trim eats this whole segment. Drop it and carry the remainder back.
    remaining -= length
    points = points.slice(0, last)
  }

  // Trimmed away to nothing. Keep a degenerate two-point path so the caller still has
  // something to draw and the head still has a direction.
  return points.length >= 4 ? points : [points[0] ?? 0, points[1] ?? 0, points[0] ?? 0, points[1] ?? 0]
}
