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
  /**
   * A world-space box the shaft is cut around, for an arrow carrying a caption.
   *
   * The label is DOM and the line is WebGL, so nothing else can stop one drawing over
   * the other. The alternative is an opaque plate behind the type, which is a solid
   * rectangle on a surface that otherwise has none. Breaking the line is what a person
   * drawing this by hand does, and it is what the diagrams being copied here do.
   */
  gap?: { minX: number; minY: number; maxX: number; maxY: number }
}

/**
 * The head's proportions, as fractions of its length along the shaft.
 *
 * Two different shapes, deliberately, because they are read differently.
 *
 * An `open` head is two strokes meeting at the tip, in the shaft's own weight and with
 * the shaft's own round caps, so the whole arrow is one continuous mark. It is wide -
 * nearly as far across as it is long - which is what stops a V at a whiteboard's line
 * weight reading as a kink in the line. This is the default, and it is what a
 * whiteboard arrow actually looks like.
 *
 * A `triangle` head is a filled wedge, for the diagram that wants one. It is narrower,
 * because a filled shape at the same spread reads much heavier than an outline, and it
 * is notched at the back so the shaft runs into it rather than butting against a flat
 * base. `NOTCH` is also where the shaft is trimmed to.
 */
const OPEN_HALF_WIDTH = 0.8
const SOLID_HALF_WIDTH = 0.55
const HEAD_NOTCH = 0.72

/**
 * A head never gets smaller than the stroke it terminates.
 *
 * The stored `headSize` is a world length, so a 12-unit head on a 10-unit stroke is a
 * blunt end rather than an arrow. Scaling the floor with the width keeps a heavy
 * arrow looking like an arrow without making the author set two numbers that have to
 * agree. The open head needs more of it, since its arms are drawn *in* the stroke
 * width rather than filled: at four times the weight the two arms and the shaft meet
 * in a blob.
 */
function headLength(arrow: ArrowDraw, kind: ArrowHead): number {
  return Math.max(arrow.headSize, arrow.strokeWidth * (kind === 'open' ? 3.8 : 3.4))
}

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

    // The shaft stops at a solid head's notch, so the stroke's own round cap is hidden
    // inside the barbs instead of poking out past the tip. An open head is two lines
    // meeting at the tip *on* the shaft, so it needs no trim: the shaft running all
    // the way in is what makes the three strokes read as one mark.
    const endTrim = arrow.endHead === 'triangle' ? headLength(arrow, 'triangle') * HEAD_NOTCH : 0
    const startTrim = arrow.startHead === 'triangle' ? headLength(arrow, 'triangle') * HEAD_NOTCH : 0
    const shaft = trimEnds(points, startTrim, endTrim)
    if (arrow.gap === undefined) group.shafts.push(shaft)
    else for (const piece of splitAroundBox(shaft, arrow.gap)) group.shafts.push(piece)

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
    const size = headLength(arrow, kind)
    // Along the shaft and across it. Built from the two axes rather than from two
    // angles off the direction, so the spread and the notch depth are independent and
    // each reads as the fraction it is named for.
    const alongX = Math.cos(angle)
    const alongY = Math.sin(angle)
    const acrossX = -alongY
    const acrossY = alongX

    const half = size * (kind === 'open' ? OPEN_HALF_WIDTH : SOLID_HALF_WIDTH)
    const baseX = tipX - alongX * size
    const baseY = tipY - alongY * size

    const leftX = baseX + acrossX * half
    const leftY = baseY + acrossY * half
    const rightX = baseX - acrossX * half
    const rightY = baseY - acrossY * half

    if (kind === 'open') {
      group.openHeads.push([leftX, leftY, tipX, tipY, rightX, rightY])
      return
    }

    const notchX = tipX - alongX * size * HEAD_NOTCH
    const notchY = tipY - alongY * size * HEAD_NOTCH
    group.solidHeads.push([tipX, tipY, leftX, leftY, notchX, notchY, rightX, rightY])
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

/**
 * Cut a polyline where it passes through a box, returning the pieces outside it.
 *
 * Used for the gap behind an arrow's caption. A box rather than a radius because the
 * thing being avoided *is* a box: a line of type is much wider than it is tall, and a
 * circle big enough to clear the width would cut a vertical arrow to pieces.
 *
 * Clipped per segment with the slab method, not by classifying the vertices. The first
 * version tested whether each point was inside the box, which is correct for a finely
 * tessellated curve and silently wrong for the commonest case there is: a straight
 * arrow is two points, both far outside, with the whole caption sitting on the segment
 * between them. Nothing was ever cut and the line ran through the words.
 */
export function splitAroundBox(
  points: readonly number[],
  box: { minX: number; minY: number; maxX: number; maxY: number },
): number[][] {
  const pieces: number[][] = []
  let current: number[] = []

  const push = (x: number, y: number): void => {
    // Guard against emitting the same vertex twice where two segments meet.
    const last = current.length
    if (last >= 2 && current[last - 2] === x && current[last - 1] === y) return
    current.push(x, y)
  }

  const close = (): void => {
    if (current.length >= 4) pieces.push(current)
    current = []
  }

  for (let index = 0; index + 3 < points.length; index += 2) {
    const ax = points[index]
    const ay = points[index + 1]
    const bx = points[index + 2]
    const by = points[index + 3]

    const span = clipToBox(ax, ay, bx, by, box)
    if (span === null) {
      // Entirely outside: the whole segment survives.
      push(ax, ay)
      push(bx, by)
      continue
    }

    // The part before the box, if any.
    if (span.enter > 0) {
      push(ax, ay)
      push(ax + (bx - ax) * span.enter, ay + (by - ay) * span.enter)
    }
    close()

    // And the part after it, which begins the next piece.
    if (span.exit < 1) {
      push(ax + (bx - ax) * span.exit, ay + (by - ay) * span.exit)
      push(bx, by)
    }
  }

  close()
  return pieces
}

/**
 * The parametric interval of a segment that lies inside a box, or null if none does.
 *
 * Liang-Barsky: intersect the two axis slabs and keep the overlap. A segment parallel
 * to an axis has no bound on that one, which is the `direction === 0` branch - and it
 * still has to be rejected when it runs outside the slab entirely, which is the case
 * that a naive version drops.
 */
function clipToBox(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  box: { minX: number; minY: number; maxX: number; maxY: number },
): { enter: number; exit: number } | null {
  let enter = 0
  let exit = 1

  const slab = (origin: number, direction: number, lo: number, hi: number): boolean => {
    if (direction === 0) return origin >= lo && origin <= hi
    const first = (lo - origin) / direction
    const second = (hi - origin) / direction
    enter = Math.max(enter, Math.min(first, second))
    exit = Math.min(exit, Math.max(first, second))
    return enter <= exit
  }

  if (!slab(ax, bx - ax, box.minX, box.maxX)) return null
  if (!slab(ay, by - ay, box.minY, box.maxY)) return null
  if (enter > exit) return null

  return { enter: Math.max(0, enter), exit: Math.min(1, exit) }
}
