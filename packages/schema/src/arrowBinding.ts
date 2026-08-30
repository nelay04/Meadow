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
import { type ObjectData, parallelogramSlant } from './objects'

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
    case 'parallelogram': {
      // Two slabs rather than four edges: the flat top and bottom, and the pair of
      // slanted sides. Shearing x by the slant turns the slanted pair into a vertical
      // one, and the ray leaves at whichever slab it reaches first.
      const skew = parallelogramSlant(halfW * 2, halfH * 2) / 2
      const sheared = dx + (skew / halfH) * dy
      const tx = sheared === 0 ? Infinity : (halfW - skew) / Math.abs(sheared)
      const ty = dy === 0 ? Infinity : halfH / Math.abs(dy)
      return Math.min(tx, ty)
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
  elbow = 0.5,
): number[] {
  const points = Array.from(current)
  const last = points.length - 2

  const startPoint = { x: points[0], y: points[1] }
  const endPoint = { x: points[last], y: points[last + 1] }

  /*
   * An elbow arrives square to an edge, so its endpoint is aimed square too.
   *
   * A centre anchor means "aim at the middle and stop at the outline", and aiming at
   * the far end is right for a line that actually travels that way. An orthogonal
   * route does not: its last segment is horizontal or vertical, so an endpoint solved
   * against the diagonal lands off to one side and the route arrives past the corner,
   * visibly floating beside the shape it is pointing at. Flattening the aim onto the
   * dominant axis puts it in the middle of the edge the route will approach from.
   *
   * Only for a centre anchor. An explicit one is a point the user chose, and it is
   * already square when it came from a connector dot.
   */
  const aim = (target: ObjectData, toward: Point): Point => {
    if (routing !== 'orthogonal') return toward
    const centreX = target.x + target.w / 2
    const centreY = target.y + target.h / 2
    return Math.abs(toward.x - centreX) >= Math.abs(toward.y - centreY)
      ? { x: toward.x, y: centreY }
      : { x: centreX, y: toward.y }
  }

  // Aim each end at the far end's *pre-solve* position, so the two are symmetric and
  // the result does not depend on which one is computed first.
  if (startTarget !== null && startBinding !== null) {
    const solved = resolveBoundPoint(startTarget, startBinding, aim(startTarget, endPoint))
    points[0] = solved.x
    points[1] = solved.y
  }
  if (endTarget !== null && endBinding !== null) {
    const solved = resolveBoundPoint(endTarget, endBinding, aim(endTarget, startPoint))
    points[last] = solved.x
    points[last + 1] = solved.y
  }

  if (routing === 'orthogonal') {
    const tail = points.length - 2
    return routeOrthogonal(
      { x: points[0], y: points[1] },
      { x: points[tail], y: points[tail + 1] },
      elbow,
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
 * A centre-anchored endpoint is aimed along the dominant axis rather than at the far
 * end, so the route meets the outline square instead of arriving past a corner. That
 * is not a full solve of the anchor against the route and the route against the
 * anchor - which is genuinely circular - but it covers the case that looked broken.
 */
export function routeOrthogonal(start: Point, end: Point, at = 0.5): number[] {
  const dx = end.x - start.x
  const dy = end.y - start.y

  // Already straight on one axis. A dogleg here would be a kink in a line that should
  // just be a line.
  if (Math.abs(dx) < 1 || Math.abs(dy) < 1) return [start.x, start.y, end.x, end.y]

  const fraction = Math.min(0.98, Math.max(0.02, at))

  if (Math.abs(dx) >= Math.abs(dy)) {
    const midX = start.x + dx * fraction
    return [start.x, start.y, midX, start.y, midX, end.y, end.x, end.y]
  }

  const midY = start.y + dy * fraction
  return [start.x, start.y, start.x, midY, end.x, midY, end.x, end.y]
}

/**
 * Which axis an elbow between two points turns on, and where its dogleg sits.
 *
 * The same decision `routeOrthogonal` makes, exposed so the tool that drags the dogleg
 * and the renderer that draws it cannot disagree about which way it runs. `at` is
 * returned as a fraction so a caller can invert it against a pointer position.
 */
export function elbowAxis(start: Point, end: Point): 'x' | 'y' {
  return Math.abs(end.x - start.x) >= Math.abs(end.y - start.y) ? 'x' : 'y'
}

/**
 * The fraction that would put an elbow's dogleg under a given point.
 *
 * Solved directly from the pointer rather than accumulated from a delta, for the same
 * reason the curve handles are: a drag that does not track the cursor exactly reads as
 * the shape fighting you, and over a long drag an accumulated offset drifts.
 */
export function elbowFor(start: Point, end: Point, through: Point): number {
  const axis = elbowAxis(start, end)
  const span = axis === 'x' ? end.x - start.x : end.y - start.y
  if (Math.abs(span) < 1e-6) return 0.5
  const travelled = axis === 'x' ? through.x - start.x : through.y - start.y
  return Math.min(0.98, Math.max(0.02, travelled / span))
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
