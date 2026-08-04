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

/** Line ends. A `line` is just an arrow with no heads, so it needs no separate type. */
export const ARROW_HEADS = ['none', 'triangle', 'open'] as const
export type ArrowHead = (typeof ARROW_HEADS)[number]

export const ARROW_ROUTING = ['straight', 'orthogonal'] as const
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
  startHead: z.enum(ARROW_HEADS).default('none'),
  endHead: z.enum(ARROW_HEADS).default('triangle'),
  stroke: z.number().int().default(0x1f2a24),
  strokeAlpha: z.number().min(0).max(1).default(1),
  strokeWidth: z.number().min(0.5).max(32).default(2),
  /** Head length in world units. Width is derived from it. */
  headSize: z.number().min(2).max(64).default(12),
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
 * Normalise absolute world points into an object origin plus relative points.
 *
 * The single place the two halves of the representation are produced, so they cannot
 * disagree. An arrow whose bounds did not match its points would be culled while
 * visible, or selectable in empty space.
 *
 * A degenerate arrow, one whose points are all coincident, still gets a non-zero box.
 * A zero-area entry in the R-tree is not returned by an intersection query, so a
 * zero-length arrow would become invisible to selection and impossible to delete.
 */
export function arrowGeometry(absolute: readonly number[]): ArrowGeometry {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (let index = 0; index + 1 < absolute.length; index += 2) {
    const x = absolute[index]
    const y = absolute[index + 1]
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
