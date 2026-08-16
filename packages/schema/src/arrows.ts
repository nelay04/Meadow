/**
 * Arrows and lines. ARCHITECTURE 4 and 5.
 *
 * Points are stored **relative to the object's own x,y**, as a flat array, with `w`
 * and `h` holding their extent. Two consequences, both deliberate.
 *
 * Dragging an arrow is a change to `x` and `y` and nothing else, exactly like dragging
 * a rectangle, so selection, transform, snapping and undo need no arrow-specific path.
 * Absolute points would have made every one of those a special case.
 *
 * And `w`/`h` staying a real bounding box means the R-tree, culling, marquee selection
 * and the union box all keep working without knowing what an arrow is. The cost is
 * that points and bounds must be written together, which is why `arrowGeometry` exists
 * rather than callers computing either half themselves.
 *
 * A flat array rather than `{x,y}[]` because this is read once per visible arrow per
 * frame and the object allocation is pure waste at that rate. It also generalises to
 * the waypoints orthogonal routing needs, and to freedraw later.
 */

import { z } from 'zod'

import type { ObjectData, ObjectType } from './objects'

type Point2D = { x: number; y: number }

/** Line ends. A `line` is just an arrow with no heads, so it needs no separate type. */
export const ARROW_HEADS = ['none', 'triangle', 'open'] as const
export type ArrowHead = (typeof ARROW_HEADS)[number]

/**
 * How the path between the two endpoints is drawn.
 *
 * `straight` and `orthogonal` are *stored* routes: the solver writes their waypoints
 * into `points`, so what the document holds is what gets drawn. `curved` is a
 * *derived* route, and deliberately so. A quadratic bow has no waypoints to store,
 * only a signed curvature, and storing a flattened approximation of it would freeze
 * the curve at one tessellation and turn every zoom-in into a polygon.
 */
export const ARROW_ROUTING = ['straight', 'curved', 'orthogonal'] as const
export type ArrowRouting = (typeof ARROW_ROUTING)[number]

/** Types drawn by the arrow pass rather than the instanced shape batch. */
export const ARROW_LIKE = ['arrow', 'line'] as const

const ARROW_LIKE_SET: ReadonlySet<string> = new Set(ARROW_LIKE)

export function isArrowLike(type: ObjectType): boolean {
  return ARROW_LIKE_SET.has(type)
}

export const arrowProps = z.object({
  /** Flat [x0,y0,x1,y1,...], relative to the object's x,y. At least two points. */
  points: z.array(z.number()).default([0, 0, 120, 0]),
  routing: z.enum(ARROW_ROUTING).default('straight'),
  /**
   * How far a curved arrow bows at each end, as a fraction of the straight-line
   * distance between its endpoints. Signed: the sign is which side of the chord that
   * half of the curve leans towards.
   *
   * Two numbers rather than one, and this is the difference between a curve and a
   * bow. One number can only describe a C: the whole arrow leaning one way. Give each
   * half its own lean and opposite signs produce an S, which is what a connector
   * between two boxes on the same row actually wants to be - it leaves one shape
   * going right, arrives at the other going right, and inflects in the middle.
   *
   * They are fractions rather than distances so a curve keeps its shape when either
   * end moves. An absolute bow would flatten out as the arrow lengthened and coil up
   * as it shortened, which is what makes hand-tuned curves feel like they are
   * fighting you.
   */
  curvature: z.number().min(-8).max(8).default(0.3),
  curvatureEnd: z.number().min(-8).max(8).default(0.3),
  /**
   * Where an elbow's dogleg sits between the two ends, as a fraction of the distance
   * along the axis it turns on. 0.5 is the midpoint.
   *
   * A fraction, like the bows, so the route keeps its proportions when either end
   * moves. And a single number rather than stored waypoints: the waypoints are
   * regenerated on every solve, so storing them would give two sources for one shape
   * and let them disagree the moment an endpoint moved.
   */
  elbow: z.number().min(0.02).max(0.98).default(0.5),
  startHead: z.enum(ARROW_HEADS).default('none'),
  /*
   * Open, not filled. A whiteboard arrow ends in two strokes meeting at a point, in
   * the same weight as the line they belong to, so the head reads as part of the mark
   * rather than as a solid shape stuck on the end of it. `triangle` is still there for
   * a document that asks for it.
   */
  endHead: z.enum(ARROW_HEADS).default('open'),
  stroke: z.number().int().default(0x1f2a24),
  strokeAlpha: z.number().min(0).max(1).default(1),
  /*
   * Three, not two. A 2-unit connector is a hairline: at a device pixel ratio of 1 a
   * shallow diagonal gets one fully covered pixel and one half-covered one either
   * side, so the antialiasing has a single intermediate level to work with and the
   * line reads as stepped however good the coverage maths is. Three units gives the
   * ramp somewhere to go, and it is also simply what a connector on a whiteboard
   * looks like - the reference this was matched against is a heavy stroke, not a
   * pen line.
   */
  strokeWidth: z.number().min(0.5).max(32).default(3),
  /** Head length in world units. Width is derived from it. */
  headSize: z.number().min(2).max(64).default(11),
})

export type ArrowProps = z.infer<typeof arrowProps>

const DEFAULTS: ArrowProps = arrowProps.parse({})

/** Per-type overrides. A line is an arrow that grew no heads. */
const TYPE_DEFAULTS: Partial<Record<ObjectType, Partial<ArrowProps>>> = {
  line: { endHead: 'none' },
}

/**
 * Read arrow style without running the validator.
 *
 * Called once per visible arrow per frame. The `points` array is returned by reference
 * when it is already a number array, so the common path allocates nothing.
 */
export function resolveArrowProps(object: ObjectData): ArrowProps {
  const props = object.props
  const overrides = TYPE_DEFAULTS[object.type] ?? {}

  const number = (key: keyof ArrowProps, fallback: number): number => {
    const value = props[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }
  const literal = <T extends string>(key: keyof ArrowProps, allowed: readonly T[], fallback: T): T =>
    typeof props[key] === 'string' && (allowed as readonly string[]).includes(props[key] as string)
      ? (props[key] as T)
      : fallback

  const raw = props.points
  const points =
    Array.isArray(raw) && raw.length >= 4 && raw.every((value) => typeof value === 'number')
      ? (raw as number[])
      : DEFAULTS.points

  return {
    points,
    routing: literal('routing', ARROW_ROUTING, DEFAULTS.routing),
    curvature: number('curvature', DEFAULTS.curvature),
    curvatureEnd: number('curvatureEnd', DEFAULTS.curvatureEnd),
    elbow: number('elbow', DEFAULTS.elbow),
    startHead: literal('startHead', ARROW_HEADS, overrides.startHead ?? DEFAULTS.startHead),
    endHead: literal('endHead', ARROW_HEADS, overrides.endHead ?? DEFAULTS.endHead),
    stroke: number('stroke', DEFAULTS.stroke),
    strokeAlpha: number('strokeAlpha', DEFAULTS.strokeAlpha),
    strokeWidth: number('strokeWidth', DEFAULTS.strokeWidth),
    headSize: number('headSize', DEFAULTS.headSize),
  }
}

export type ArrowGeometry = {
  x: number
  y: number
  w: number
  h: number
  /** Relative to the returned x,y. */
  points: number[]
}

/**
 * The shape of a curve, for the two functions that have to agree about one.
 *
 * Passed rather than read off the object, because `arrowGeometry` is also called with
 * points that no object holds yet: mid-drag, by the tools, before anything is written.
 */
export type ArrowCurve = { routing: ArrowRouting; curvature: number; curvatureEnd: number }

/**
 * A partial change to how an arrow is routed. Every field is optional on purpose.
 *
 * Wider than `ArrowCurve` because `elbow` does not affect bounds - a right-angled route
 * stays inside the box its endpoints span however far along the dogleg sits - so it is
 * not something `arrowGeometry` needs, only something a caller can set.
 */
export type ArrowRoutingPatch = Partial<ArrowCurve> & { elbow?: number }

/**
 * Normalise absolute world points into an object origin plus relative points.
 *
 * The single place the two halves of the representation are produced, so they cannot
 * disagree. An arrow whose bounds did not match its points would be culled while
 * visible, or selectable in empty space.
 *
 * A degenerate arrow, one whose points are all coincident, still gets a non-zero box.
 * A zero-area entry in the R-tree is not returned by an intersection query, so a
 * zero-length arrow would become invisible to selection and impossible to delete.
 *
 * `curve` matters only for a derived route. A curved arrow bows *outside* the box its
 * two endpoints span, so measuring the box from the endpoints alone would cull it
 * while the bulge was still on screen, and leave the same bulge unclickable. Bounds
 * are measured over the drawn path; the stored points stay the endpoints.
 */
export function arrowGeometry(absolute: readonly number[], curve?: ArrowCurve): ArrowGeometry {
  const measured =
    curve === undefined || curve.routing !== 'curved'
      ? absolute
      : arrowPolyline(absolute, curve.routing, curve.curvature, curve.curvatureEnd)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (let index = 0; index + 1 < measured.length; index += 2) {
    const x = measured[index]
    const y = measured[index + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1, points: [...DEFAULTS.points] }

  const points: number[] = new Array(absolute.length)
  for (let index = 0; index + 1 < absolute.length; index += 2) {
    points[index] = absolute[index] - minX
    points[index + 1] = absolute[index + 1] - minY
  }

  return {
    x: minX,
    y: minY,
    w: Math.max(maxX - minX, 1),
    h: Math.max(maxY - minY, 1),
    points,
  }
}

/**
 * The path actually drawn, from the points the document stores.
 *
 * One function, three callers: the renderer, hit-testing, and the bounds above. They
 * have to produce the same curve or an arrow is drawn somewhere you cannot click it.
 *
 * `straight` and `orthogonal` already carry their own waypoints, so this returns them
 * untouched and allocates nothing on the common path. `curved` is a quadratic bow
 * flattened here, with the segment count passed in rather than fixed: the whole point
 * of deriving the curve is that it can be tessellated for the zoom it is being drawn
 * at, and a constant would either facet when zoomed in or waste segments when zoomed
 * out. Hit-testing takes the default, which is finer than an 8px tolerance can tell.
 */
export function arrowPolyline(
  points: readonly number[],
  routing: ArrowRouting,
  curvature: number,
  curvatureEnd: number,
  segments = 24,
): readonly number[] {
  if (routing !== 'curved' || points.length < 4) return points

  const control = curveControls(points, curvature, curvatureEnd)
  if (control === null) {
    const last = points.length - 2
    return [points[0], points[1], points[last], points[last + 1]]
  }

  const { x0, y0, x1, y1, x2, y2, x3, y3 } = control
  const count = Math.max(2, Math.min(256, Math.round(segments)))
  const out: number[] = new Array((count + 1) * 2)
  for (let step = 0; step <= count; step += 1) {
    const t = step / count
    const inverse = 1 - t
    const a = inverse * inverse * inverse
    const b = 3 * inverse * inverse * t
    const c = 3 * inverse * t * t
    const d = t * t * t
    out[step * 2] = a * x0 + b * x1 + c * x2 + d * x3
    out[step * 2 + 1] = a * y0 + b * y1 + c * y2 + d * y3
  }
  return out
}

type CubicControls = {
  x0: number
  y0: number
  /** First control point. */
  x1: number
  y1: number
  /** Second control point. */
  x2: number
  y2: number
  x3: number
  y3: number
}

/**
 * The cubic's four points, from the two endpoints and the two bows.
 *
 * Each control point sits a third of the way along the chord and then off it along
 * the chord's normal. Laying them out this way is what makes the two numbers mean
 * something a person can predict: same sign leans both halves the same way and gives
 * a C, opposite signs give an S, and zero on both gives back the straight line.
 *
 * Returns null for a degenerate arrow, where there is no chord to take a normal of.
 */
function curveControls(
  points: readonly number[],
  curvature: number,
  curvatureEnd: number,
): CubicControls | null {
  const last = points.length - 2
  const x0 = points[0]
  const y0 = points[1]
  const x3 = points[last]
  const y3 = points[last + 1]

  const dx = x3 - x0
  const dy = y3 - y0
  const length = Math.hypot(dx, dy)
  if (length < 1e-6 || (curvature === 0 && curvatureEnd === 0)) return null

  const normalX = -dy / length
  const normalY = dx / length

  return {
    x0,
    y0,
    x1: x0 + dx / 3 + normalX * curvature * length,
    y1: y0 + dy / 3 + normalY * curvature * length,
    x2: x0 + (dx * 2) / 3 + normalX * curvatureEnd * length,
    y2: y0 + (dy * 2) / 3 + normalY * curvatureEnd * length,
    x3,
    y3,
  }
}

/**
 * A point on the drawn path, at a fraction of the way along it.
 *
 * Used for the midpoint handle that sets the curvature and for placing an arrow's
 * label. Walks the flattened path by arc length rather than taking the Bezier at
 * t=0.5, because the parameter is not distance: on a strongly bowed curve t=0.5 sits
 * noticeably off the visual middle.
 */
export function pointAlongPath(path: readonly number[], fraction: number): Point2D {
  if (path.length < 4) return { x: path[0] ?? 0, y: path[1] ?? 0 }

  let total = 0
  for (let index = 0; index + 3 < path.length; index += 2) {
    total += Math.hypot(path[index + 2] - path[index], path[index + 3] - path[index + 1])
  }
  if (total === 0) return { x: path[0], y: path[1] }

  let remaining = total * Math.min(1, Math.max(0, fraction))
  for (let index = 0; index + 3 < path.length; index += 2) {
    const segment = Math.hypot(path[index + 2] - path[index], path[index + 3] - path[index + 1])
    if (segment >= remaining) {
      const t = segment === 0 ? 0 : remaining / segment
      return {
        x: path[index] + (path[index + 2] - path[index]) * t,
        y: path[index + 1] + (path[index + 3] - path[index + 1]) * t,
      }
    }
    remaining -= segment
  }

  const last = path.length - 2
  return { x: path[last], y: path[last + 1] }
}

/**
 * The two points on a curved arrow that can be dragged, and where they sit.
 *
 * At a third and two thirds of the way along the curve, which is where each control
 * point has most of its influence. Handles at those parameters mean a drag moves the
 * part of the line you actually grabbed, rather than the whole curve sliding under the
 * pointer the way it does when one handle drives both halves.
 */
export const CURVE_HANDLE_TS = [1 / 3, 2 / 3] as const

/** A point on the cubic at parameter `t`, given the endpoints and both bows. */
export function pointOnCurve(
  points: readonly number[],
  curvature: number,
  curvatureEnd: number,
  t: number,
): Point2D {
  const control = curveControls(points, curvature, curvatureEnd)
  const last = points.length - 2
  if (control === null) {
    return {
      x: points[0] + (points[last] - points[0]) * t,
      y: points[1] + (points[last + 1] - points[1]) * t,
    }
  }

  const inverse = 1 - t
  const a = inverse * inverse * inverse
  const b = 3 * inverse * inverse * t
  const c = 3 * inverse * t * t
  const d = t * t * t
  return {
    x: a * control.x0 + b * control.x1 + c * control.x2 + d * control.x3,
    y: a * control.y0 + b * control.y1 + c * control.y2 + d * control.y3,
  }
}

/**
 * The bow that would put the handle at `t` exactly under the pointer.
 *
 * Solved rather than nudged. At parameter `t` the curve's offset from the chord is
 * `(B1(t) * c0 + B2(t) * c1) * length`, where B1 and B2 are the two middle Bernstein
 * terms, so given the other bow this inverts to one division. Accumulating a delta
 * instead would drift away from the pointer over a long drag, and dragging a handle
 * that does not stay under the cursor is the thing that makes curve editing feel
 * broken.
 *
 * `which` picks the bow being solved for: 0 is the one near the start.
 */
export function curvatureAt(
  start: Point2D,
  end: Point2D,
  through: Point2D,
  t: number,
  which: 0 | 1,
  other: number,
): number {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return 0

  // Signed distance from the chord, along its normal.
  const offset = ((through.x - start.x) * -dy + (through.y - start.y) * dx) / (length * length)

  const inverse = 1 - t
  const b1 = 3 * inverse * inverse * t
  const b2 = 3 * inverse * t * t
  const mine = which === 0 ? b1 : b2
  const theirs = which === 0 ? b2 : b1
  if (Math.abs(mine) < 1e-6) return other

  return Math.max(-8, Math.min(8, (offset - theirs * other) / mine))
}

/** An arrow's points in world coordinates. Allocates, so not for the render loop. */
export function absolutePoints(object: ObjectData, props: ArrowProps): number[] {
  const out: number[] = new Array(props.points.length)
  for (let index = 0; index + 1 < props.points.length; index += 2) {
    out[index] = props.points[index] + object.x
    out[index + 1] = props.points[index + 1] + object.y
  }
  return out
}

/** First and last point of an arrow, in world coordinates. */
export function arrowEndpoints(
  object: ObjectData,
  props: ArrowProps,
): { start: { x: number; y: number }; end: { x: number; y: number } } {
  const points = props.points
  const last = points.length - 2
  return {
    start: { x: points[0] + object.x, y: points[1] + object.y },
    end: { x: points[last] + object.x, y: points[last + 1] + object.y },
  }
}
