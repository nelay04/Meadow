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
import {
  type ObjectData,
  cylinderCap,
  parallelogramSlant,
  polygonSidesOf,
  trapezoidInset,
} from './objects'

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
function outlineScale(target: ObjectData, halfW: number, halfH: number, dx: number, dy: number): number {
  if (halfW <= 0 || halfH <= 0) return 0
  if (dx === 0 && dy === 0) return 0

  switch (target.type) {
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
    case 'triangle': {
      // Three half-planes: the base, and the two slanted edges. The centre of the box
      // is inside the triangle, so the ray leaves at whichever it reaches first.
      const base = dy > 0 ? halfH / dy : Infinity
      const right = 2 * halfH * dx - halfW * dy
      const left = 2 * halfH * -dx - halfW * dy
      return Math.min(
        base,
        right > 0 ? (halfW * halfH) / right : Infinity,
        left > 0 ? (halfW * halfH) / left : Infinity,
      )
    }
    case 'trapezoid': {
      // Four edges, and only the slanted pair needs working out. Their line runs from
      // (top, -halfH) to (halfW, +halfH), so its normal is (2*halfH, -inset).
      const inset = trapezoidInset(halfW * 2, halfH * 2)
      const top = halfW - inset
      const flat = dy === 0 ? Infinity : halfH / Math.abs(dy)
      const edge = 2 * halfH * top + inset * halfH
      const right = 2 * halfH * dx - inset * dy
      const left = 2 * halfH * -dx - inset * dy
      return Math.min(
        flat,
        right > 0 ? edge / right : Infinity,
        left > 0 ? edge / left : Infinity,
      )
    }
    case 'polygon': {
      // The same fold the renderer and the hit test use: in the box's normalised space
      // the shape is regular, and the ray leaves where its distance along the nearest
      // edge's normal reaches the apothem.
      const sides = polygonSidesOf(target.props)
      const nx = dx / halfW
      const ny = dy / halfH
      const sector = (Math.PI * 2) / sides
      const angle = Math.atan2(ny, nx) - (-Math.PI / 2 + sector / 2)
      const offset = angle - sector * Math.round(angle / sector)
      const reach = Math.hypot(nx, ny) * Math.cos(offset)
      return reach <= 0 ? 0 : Math.cos(Math.PI / sides) / reach
    }
    case 'cylinder': {
      // A union, so the ray leaves at the far side of whichever part reaches furthest:
      // the body between the cap centres, or the cap the ray is heading into.
      const cap = Math.max(cylinderCap(target.h), 1e-6)
      const body = Math.max(halfH - cap, 0)
      const tx = dx === 0 ? Infinity : halfW / Math.abs(dx)
      const ty = dy === 0 ? Infinity : body / Math.abs(dy)
      const box = Math.min(tx, ty)

      // The cap on the ray's own side, as an ellipse offset along y.
      const centre = dy >= 0 ? body : -body
      const a = (dx / halfW) ** 2 + (dy / cap) ** 2
      const b = (-2 * centre * dy) / cap ** 2
      const c = (centre / cap) ** 2 - 1
      const root = Math.sqrt(Math.max(b * b - 4 * a * c, 0))
      const ellipse = a === 0 ? 0 : (-b + root) / (2 * a)

      return Math.max(box, ellipse)
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
  const scale = outlineScale(target, halfW, halfH, local.x, local.y)

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

  if (routing === 'orthogonal') {
    return solveElbow(points, startTarget, startBinding, endTarget, endBinding, elbow)
  }

  // Aim each end at the far end's *pre-solve* position, so the two are symmetric and
  // the result does not depend on which one is computed first.
  const startPoint = { x: points[0], y: points[1] }
  const endPoint = { x: points[last], y: points[last + 1] }
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

  return points
}

export type Side = 'left' | 'right' | 'top' | 'bottom'

/** How far an elbow runs straight out of a shape before it may turn. */
export const ELBOW_STUB = 20

const NORMALS: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
}

type Bounds = { left: number; top: number; right: number; bottom: number }

const boundsOf = (o: ObjectData): Bounds => ({
  left: o.x,
  top: o.y,
  right: o.x + o.w,
  bottom: o.y + o.h,
})

const pointBounds = (p: Point): Bounds => ({ left: p.x, top: p.y, right: p.x, bottom: p.y })

function snapSide(vx: number, vy: number): Side {
  if (Math.abs(vx) >= Math.abs(vy)) return vx >= 0 ? 'right' : 'left'
  return vy >= 0 ? 'bottom' : 'top'
}

/**
 * The side of a box that faces another box or point.
 *
 * Decided on the gap between the two boxes, not between their centres. A wide shape
 * above a narrow one offset to its side has centres further apart across than down, but
 * the space between them is below it, and that is the side a connector belongs on.
 */
function facingSide(own: Bounds, other: Bounds): Side {
  const gapRight = other.left - own.right
  const gapLeft = own.left - other.right
  const gapDown = other.top - own.bottom
  const gapUp = own.top - other.bottom
  const across = Math.max(gapRight, gapLeft)
  const down = Math.max(gapDown, gapUp)
  if (across <= 0 && down <= 0) {
    return snapSide(
      (other.left + other.right - own.left - own.right) / 2,
      (other.top + other.bottom - own.top - own.bottom) / 2,
    )
  }
  if (across >= down) return gapRight >= gapLeft ? 'right' : 'left'
  return gapDown >= gapUp ? 'bottom' : 'top'
}

/**
 * The side an explicit anchor sits on: the nearest edge, and among a tie (a corner) the
 * one facing the other end. Turned with the shape, then snapped back to an axis, since
 * an elbow only runs horizontally and vertically.
 */
function anchorSide(target: ObjectData, anchor: { nx: number; ny: number }, other: Bounds): Side {
  const distance: Record<Side, number> = {
    left: anchor.nx,
    right: 1 - anchor.nx,
    top: anchor.ny,
    bottom: 1 - anchor.ny,
  }
  const nearest = Math.min(...Object.values(distance))
  const tied = (Object.keys(distance) as Side[]).filter((side) => distance[side] <= nearest + 0.01)
  const facing = facingSide(boundsOf(target), other)
  const side = tied.includes(facing) ? facing : tied[0]
  if (target.rotation === 0) return side
  const turned = rotate(NORMALS[side].x, NORMALS[side].y, target.rotation)
  return snapSide(turned.x, turned.y)
}

type Elbow = {
  point: Point
  /** The way the route leaves this end (start) or the way it came in reversed (end). */
  normal: Point
  stub: number
  bounds: Bounds | null
}

function solveElbow(
  current: readonly number[],
  startTarget: ObjectData | null,
  startBinding: Pick<BindingData, 'anchor' | 'gap'> | null,
  endTarget: ObjectData | null,
  endBinding: Pick<BindingData, 'anchor' | 'gap'> | null,
  at: number,
): number[] {
  const last = current.length - 2
  const rawStart = { x: current[0], y: current[1] }
  const rawEnd = { x: current[last], y: current[last + 1] }
  const startBound = startTarget !== null && startBinding !== null
  const endBound = endTarget !== null && endBinding !== null
  const startBox = startBound ? boundsOf(startTarget) : pointBounds(rawStart)
  const endBox = endBound ? boundsOf(endTarget) : pointBounds(rawEnd)

  const bound = (
    target: ObjectData,
    binding: Pick<BindingData, 'anchor' | 'gap'>,
    other: Bounds,
  ): Elbow => {
    const centreX = target.x + target.w / 2
    const centreY = target.y + target.h / 2
    if (isCentreAnchor(binding.anchor)) {
      const side = facingSide(boundsOf(target), other)
      const reach = target.w + target.h + 1
      const point = resolveBoundPoint(target, binding, {
        x: centreX + NORMALS[side].x * reach,
        y: centreY + NORMALS[side].y * reach,
      })
      return { point, normal: NORMALS[side], stub: ELBOW_STUB, bounds: boundsOf(target) }
    }
    const side = anchorSide(target, binding.anchor, other)
    const point = resolveBoundPoint(target, binding, { x: centreX, y: centreY })
    return { point, normal: NORMALS[side], stub: ELBOW_STUB, bounds: boundsOf(target) }
  }

  let start: Elbow | null = startBound ? bound(startTarget, startBinding, endBox) : null
  let end: Elbow | null = endBound ? bound(endTarget, endBinding, startBox) : null

  // A free end has no side of its own. It takes the axis the route travels on toward
  // it, with no stub, which for two free ends is the plain Z it always was.
  const startPoint = start?.point ?? rawStart
  const endPoint = end?.point ?? rawEnd
  if (start === null) {
    const side = snapSide(endPoint.x - startPoint.x, endPoint.y - startPoint.y)
    start = { point: startPoint, normal: NORMALS[side], stub: 0, bounds: null }
  }
  if (end === null) {
    const side = snapSide(startPoint.x - endPoint.x, startPoint.y - endPoint.y)
    end = { point: endPoint, normal: NORMALS[side], stub: 0, bounds: null }
  }

  return elbowRoute(start, end, at)
}

// Costs for choosing among candidate routes. A backtrack or a line through either
// shape is never worth a shorter path; among clean routes, fewer turns then shorter.
const COST_REVERSAL = 100_000
const COST_THROUGH_SHAPE = 10_000
const COST_BEND = 30
const COST_UNSTEERED = 0.5
const COST_WRONG_END = 1_000

function elbowRoute(start: Elbow, end: Elbow, at: number): number[] {
  const p0 = start.point
  const q0 = end.point
  const p1 = { x: p0.x + start.normal.x * start.stub, y: p0.y + start.normal.y * start.stub }
  const q1 = { x: q0.x + end.normal.x * end.stub, y: q0.y + end.normal.y * end.stub }
  const fraction = Math.min(0.98, Math.max(0.02, at))

  const between = (a: number, b: number, lo: number, hi: number): number =>
    Math.min(Math.max(a + (b - a) * fraction, Math.min(lo, hi)), Math.max(lo, hi))
  const midX = between(p0.x, q0.x, p1.x, q1.x)
  const midY = between(p0.y, q0.y, p1.y, q1.y)

  const boxes = [start.bounds, end.bounds].filter((box): box is Bounds => box !== null)
  const all = boxes.length === 0 ? [pointBounds(p1), pointBounds(q1)] : boxes
  const outer = {
    left: Math.min(p1.x, q1.x, ...all.map((b) => b.left)) - ELBOW_STUB,
    right: Math.max(p1.x, q1.x, ...all.map((b) => b.right)) + ELBOW_STUB,
    top: Math.min(p1.y, q1.y, ...all.map((b) => b.top)) - ELBOW_STUB,
    bottom: Math.max(p1.y, q1.y, ...all.map((b) => b.bottom)) + ELBOW_STUB,
  }

  const candidates: { via: Point[]; cost: number }[] = [
    { via: [{ x: midX, y: p1.y }, { x: midX, y: q1.y }], cost: 0 },
    { via: [{ x: p1.x, y: midY }, { x: q1.x, y: midY }], cost: 0 },
    { via: [{ x: p1.x, y: q1.y }], cost: COST_UNSTEERED },
    { via: [{ x: q1.x, y: p1.y }], cost: COST_UNSTEERED },
    ...[outer.top, outer.bottom].map((y) => ({
      via: [{ x: p1.x, y }, { x: q1.x, y }],
      cost: COST_UNSTEERED,
    })),
    ...[outer.left, outer.right].map((x) => ({
      via: [{ x, y: p1.y }, { x, y: q1.y }],
      cost: COST_UNSTEERED,
    })),
  ]

  let best: number[] | null = null
  let bestCost = Infinity
  for (const candidate of candidates) {
    const { route, reversals } = simplify([p0, p1, ...candidate.via, q1, q0])
    let cost = candidate.cost + reversals * COST_REVERSAL
    const bends = route.length / 2 - 2
    cost += Math.max(0, bends) * COST_BEND
    // Leaving and arriving the way each end faces. A bound end's stub already makes this
    // true; for a free end it keeps the plain Z, whose dogleg has a handle, over an L.
    const n = route.length
    if (!heads(route[0], route[1], route[2], route[3], start.normal)) cost += COST_WRONG_END
    if (!heads(route[n - 2], route[n - 1], route[n - 4], route[n - 3], end.normal)) {
      cost += COST_WRONG_END
    }
    for (let i = 0; i + 3 < route.length; i += 2) {
      cost += Math.abs(route[i + 2] - route[i]) + Math.abs(route[i + 3] - route[i + 1])
      for (const box of boxes) {
        if (segmentThrough(route[i], route[i + 1], route[i + 2], route[i + 3], box)) {
          cost += COST_THROUGH_SHAPE
        }
      }
    }
    if (cost < bestCost) {
      bestCost = cost
      best = route
    }
  }
  return best ?? [p0.x, p0.y, q0.x, q0.y]
}

/**
 * Drop zero-length segments and merge runs in one direction, counting every place the
 * path turns straight back on itself. A reversal is kept as a turn so it is visible to
 * the cost rather than hidden inside a merged line.
 */
function simplify(path: readonly Point[]): { route: number[]; reversals: number } {
  const kept: Point[] = [path[0]]
  let previous: Point | null = null
  let reversals = 0
  for (let i = 1; i < path.length; i += 1) {
    const from = kept[kept.length - 1]
    const to = path[i]
    const dx = to.x - from.x
    const dy = to.y - from.y
    if (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9) continue
    const direction = { x: Math.sign(dx), y: Math.sign(dy) }
    if (previous !== null && direction.x === previous.x && direction.y === previous.y) {
      kept[kept.length - 1] = to
      continue
    }
    if (previous !== null && direction.x === -previous.x && direction.y === -previous.y) {
      reversals += 1
    }
    kept.push(to)
    previous = direction
  }
  const route: number[] = []
  for (const point of kept) route.push(point.x, point.y)
  if (route.length === 2) route.push(route[0], route[1])
  return { route, reversals }
}

/** Whether a segment from one point to the next runs along a direction. */
function heads(x0: number, y0: number, x1: number, y1: number, normal: Point): boolean {
  return (x1 - x0) * normal.x + (y1 - y0) * normal.y > 1e-9
}

function segmentThrough(x0: number, y0: number, x1: number, y1: number, box: Bounds): boolean {
  const inset = 1
  return (
    Math.max(x0, x1) > box.left + inset &&
    Math.min(x0, x1) < box.right - inset &&
    Math.max(y0, y1) > box.top + inset &&
    Math.min(y0, y1) < box.bottom - inset
  )
}

/**
 * The segment an elbow's handle slides, and the axis it slides along.
 *
 * The middle segment of a route with an odd number of segments, which is the one the
 * elbow fraction positions. Read from the drawn points, so the handle, the cursor and
 * the drag agree with whatever route the solver chose.
 */
export function elbowSlide(
  route: readonly number[],
): { from: Point; to: Point; axis: 'x' | 'y' } | null {
  const segments = route.length / 2 - 1
  if (segments < 3 || segments % 2 === 0) return null
  const index = ((segments - 1) / 2) * 2
  const from = { x: route[index], y: route[index + 1] }
  const to = { x: route[index + 2], y: route[index + 3] }
  return { from, to, axis: Math.abs(to.x - from.x) < 1e-6 ? 'x' : 'y' }
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
export function elbowFor(
  start: Point,
  end: Point,
  through: Point,
  axis: 'x' | 'y' = elbowAxis(start, end),
): number {
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
