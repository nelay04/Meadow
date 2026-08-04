/**
 * Where a bound arrow endpoint actually lands. ARCHITECTURE 4.
 *
 * A binding stores a normalised anchor inside the target's bounds, not a position. The
 * arrow follows when the target moves, and survives a resize because the anchor is a
 * fraction rather than an offset.
 *
 * The interesting case is the default anchor, dead centre. Nobody wants an arrow drawn
 * to the middle of a box and hidden underneath it; they want it to stop at the edge,
 * pointing at the middle. So a centre anchor means "aim at the centre and stop at the
 * boundary", and the boundary is the shape's real outline, not its bounding box. An
 * arrow into an ellipse that stopped at the ellipse's box would float in the corner
 * gap, which is the sort of detail that makes connectors look broken.
 *
 * Pure geometry over plain snapshots. It reads no document and writes none, which is
 * why it lives in the schema package rather than in the engine: the solver in
 * doc/mutations, the arrow tool, and the tests all need exactly this and none of them
 * should have to reach into src/canvas to get it.
 */

import type { ArrowRouting } from './arrows'
import type { BindingData } from './bindings'
import type { ObjectData } from './objects'

export type Point = { x: number; y: number }

/** How close to the centre an anchor must be to count as "aim at the middle". */
const CENTRE_EPSILON = 0.02

export function isCentreAnchor(anchor: { nx: number; ny: number }): boolean {
  return Math.abs(anchor.nx - 0.5) < CENTRE_EPSILON && Math.abs(anchor.ny - 0.5) < CENTRE_EPSILON
}

/** Rotate a point about the origin. */
function rotate(x: number, y: number, angle: number): Point {
  if (angle === 0) return { x, y }
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  return { x: x * cos - y * sin, y: x * sin + y * cos }
}

/**
 * How far from the centre the shape's outline is, along a direction, in local space.
 *
 * `dx`/`dy` need not be normalised. Returns the scale factor `t` such that
 * `(t*dx, t*dy)` sits on the outline. Each branch is the analytic ray-shape
 * intersection for that type, which is exact and far cheaper than marching.
 */
function outlineScale(type: ObjectData['type'], halfW: number, halfH: number, dx: number, dy: number): number {
  if (halfW <= 0 || halfH <= 0) return 0
  if (dx === 0 && dy === 0) return 0

  switch (type) {
    case 'ellipse': {
      // (t*dx/halfW)^2 + (t*dy/halfH)^2 = 1
      const nx = dx / halfW
      const ny = dy / halfH
      return 1 / Math.hypot(nx, ny)
    }
    case 'diamond': {
      // |t*dx|/halfW + |t*dy|/halfH = 1
      return 1 / (Math.abs(dx) / halfW + Math.abs(dy) / halfH)
    }
    default: {
      // The box: whichever axis is hit first bounds the ray.
      const tx = dx === 0 ? Infinity : halfW / Math.abs(dx)
      const ty = dy === 0 ? Infinity : halfH / Math.abs(dy)
      return Math.min(tx, ty)
    }
  }
}

/**
 * The world point an arrow end should sit at, given its binding and the target.
 *
 * `toward` is the arrow's other endpoint, which is what makes a centre anchor
 * directional. Callers pass the far end of the arrow; for a two-point arrow that is
 * simply the opposite end.
 */
export function resolveBoundPoint(
  target: ObjectData,
  binding: Pick<BindingData, 'anchor' | 'gap'>,
  toward: Point,
): Point {
  const halfW = target.w / 2
  const halfH = target.h / 2
  const centreX = target.x + halfW
  const centreY = target.y + halfH

  if (!isCentreAnchor(binding.anchor)) {
    // An explicit anchor is a point the user chose. Honour it exactly, and push it
    // outwards along the direction from the centre so the gap still applies.
    const localX = (binding.anchor.nx - 0.5) * target.w
    const localY = (binding.anchor.ny - 0.5) * target.h
    const world = rotate(localX, localY, target.rotation)

    const outX = world.x
    const outY = world.y
    const length = Math.hypot(outX, outY)
    const push = length === 0 ? { x: 0, y: 0 } : { x: (outX / length) * binding.gap, y: (outY / length) * binding.gap }

    return { x: centreX + world.x + push.x, y: centreY + world.y + push.y }
  }

  // Centre anchor. Aim from the target's centre at the arrow's other end, and stop
  // where that ray leaves the outline, plus the standoff.
  const local = rotate(toward.x - centreX, toward.y - centreY, -target.rotation)
  const scale = outlineScale(target.type, halfW, halfH, local.x, local.y)

  const length = Math.hypot(local.x, local.y)
  if (length === 0 || scale === 0) return { x: centreX, y: centreY }

  // The gap is a world distance, so it is applied along the unit direction rather than
  // folded into the scale, which would make it depend on the shape's size.
  const edgeX = local.x * scale
  const edgeY = local.y * scale
  const withGap = rotate(
    edgeX + (local.x / length) * binding.gap,
    edgeY + (local.y / length) * binding.gap,
    target.rotation,
  )

  return { x: centreX + withGap.x, y: centreY + withGap.y }
}

/**
 * Recompute both endpoints of an arrow from whatever bindings it has.
 *
 * Returns absolute world points. A null target, meaning a free endpoint or one whose
 * target was deleted, leaves that end exactly where it was, which is what makes an
 * arrow survive its target's deletion as a loose end rather than collapsing.
 *
 * Both ends are solved against the *current* other end rather than iterating to a
 * fixed point. Two centre-anchored ends pointing at each other would otherwise chase
 * each other slightly on every frame, and the visual difference is nil.
 */
export function solveArrowEnds(
  current: readonly number[],
  startTarget: ObjectData | null,
  startBinding: Pick<BindingData, 'anchor' | 'gap'> | null,
  endTarget: ObjectData | null,
  endBinding: Pick<BindingData, 'anchor' | 'gap'> | null,
  routing: ArrowRouting = 'straight',
): number[] {
  const points = Array.from(current)
  const last = points.length - 2

  const startPoint = { x: points[0], y: points[1] }
  const endPoint = { x: points[last], y: points[last + 1] }

  // Aim each end at the far end's *pre-solve* position, so the two are symmetric and
  // the result does not depend on which one is computed first.
  if (startTarget !== null && startBinding !== null) {
    const solved = resolveBoundPoint(startTarget, startBinding, endPoint)
    points[0] = solved.x
    points[1] = solved.y
  }
  if (endTarget !== null && endBinding !== null) {
    const solved = resolveBoundPoint(endTarget, endBinding, startPoint)
    points[last] = solved.x
    points[last + 1] = solved.y
  }

  if (routing === 'orthogonal') {
    const tail = points.length - 2
    return routeOrthogonal(
      { x: points[0], y: points[1] },
      { x: points[tail], y: points[tail + 1] },
    )
  }

  return points
}

/**
 * A right-angled path between two points.
 *
 * Leaves along the dominant axis and turns once at the midpoint, giving the Z shape
 * every diagramming tool produces for this. Waypoints are regenerated on every solve
 * rather than stored and adjusted, so a route cannot drift out of step with the
 * endpoints it connects.
 *
 * Deliberately not obstacle-aware. Routing around intervening shapes is a genuinely
 * hard problem, it is the part of arrows that matters least when missing, and a route
 * that reshuffles itself as unrelated objects move is worse than one that runs
 * straight through them.
 *
 * The endpoints are still aimed at each other in a straight line by the solver above,
 * so on a centre-anchored binding the very first segment can leave the shape at a
 * slight angle to the edge. Fixing that means solving the anchor against the route and
 * the route against the anchor, and it is not worth the circularity.
 */
export function routeOrthogonal(start: Point, end: Point): number[] {
  const dx = end.x - start.x
  const dy = end.y - start.y

  // Already straight on one axis. A dogleg here would be a kink in a line that should
  // just be a line.
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return [start.x, start.y, end.x, end.y]

  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = start.x + dx / 2
    return [start.x, start.y, midX, start.y, midX, end.y, end.x, end.y]
  }

  const midY = start.y + dy / 2
  return [start.x, start.y, start.x, midY, end.x, midY, end.x, end.y]
}

/**
 * The normalised anchor for a point inside a target, for the arrow tool.
 *
 * Dropping an endpoint near the middle should bind to the centre and behave
 * directionally; dropping it near an edge should pin there. The threshold is what
 * makes "just drop it on the shape" do the right thing without a modifier key.
 */
export function anchorFor(target: ObjectData, point: Point, centreRadius = 0.3): BindingData['anchor'] {
  if (target.w <= 0 || target.h <= 0) return { nx: 0.5, ny: 0.5 }

  const local = rotate(
    point.x - (target.x + target.w / 2),
    point.y - (target.y + target.h / 2),
    -target.rotation,
  )
  const nx = local.x / target.w + 0.5
  const ny = local.y / target.h + 0.5

  const insideCentre =
    Math.abs(nx - 0.5) < centreRadius && Math.abs(ny - 0.5) < centreRadius
  if (insideCentre) return { nx: 0.5, ny: 0.5 }

  return { nx: Math.min(1, Math.max(0, nx)), ny: Math.min(1, Math.max(0, ny)) }
}
