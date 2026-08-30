/**
 * The CRDT object model. ARCHITECTURE 4.
 *
 * Two representations, deliberately:
 *
 * - `ObjectData`, plain fields. What validation, exports, tests, and the renderer
 *   work with. Cheap to construct, compare, and serialise.
 * - `Y.Map`, the live CRDT node. What is actually stored and synced.
 *
 * The accessors below are the only place the two meet. `ObjectData` is not the type
 * of the Y.Map, and code that treats it as one will read stale values, because a
 * snapshot taken from a Y.Map does not update when a peer edits it.
 *
 * The `objects` map is flat and reparenting is a `parentId` write, never a
 * delete-and-recreate: a nested tree would lose concurrent edits to the object being
 * moved.
 */

import * as Y from 'yjs'
import { z } from 'zod'

export const OBJECT_TYPES = [
  'text',
  'sticky',
  'rect',
  'ellipse',
  'diamond',
  'parallelogram',
  'triangle',
  'trapezoid',
  'polygon',
  'cylinder',
  'line',
  'arrow',
  'freedraw',
  'image',
  'table',
  'chart',
  'frame',
  'embed',
] as const

export type ObjectType = (typeof OBJECT_TYPES)[number]

/**
 * Types the instanced shape renderer can draw. Everything else needs its own path.
 *
 * All eight are one SDF branch each, which is the rule the renderer is built on: a
 * shape added as a Graphics costs a draw call per instance and gives up the
 * zoom-independent edge the batch gets for free. The two that look like exceptions are
 * not - a polygon folds its sector count into one distance function, and a cylinder is
 * the union of a box and two ellipses, which is a min of three.
 */
export const PRIMITIVE_SHAPES = [
  'rect',
  'ellipse',
  'diamond',
  'parallelogram',
  'triangle',
  'trapezoid',
  'polygon',
  'cylinder',
] as const
export type PrimitiveShape = (typeof PRIMITIVE_SHAPES)[number]

/**
 * The shapes a pen stroke may be snapped to, in the order they are tried.
 *
 * A subset of the primitives rather than all of them, because being drawable and being
 * recognisable are different questions. A hexagon and an ellipse drawn freehand are the
 * same stroke to within the tolerance, and nobody draws a cylinder in one pass, so
 * offering either as a candidate would only take strokes away from the shapes people do
 * mean.
 */
export const RECOGNISABLE_SHAPES = [
  'rect',
  'ellipse',
  'diamond',
  'parallelogram',
  'triangle',
  'trapezoid',
] as const
export type RecognisableShape = (typeof RECOGNISABLE_SHAPES)[number]

/**
 * Types that carry a `Y.XmlFragment`. Only these ever get one.
 *
 * The primitives joined in M6. A rectangle you cannot label is a rectangle nobody
 * wants: on a diagramming surface the box and its caption are one object, and keeping
 * them separate meant every labelled shape was two objects that had to be moved,
 * resized and deleted together by hand.
 *
 * So did arrows, for the same reason and with more force. Half of what a connector on
 * a diagram means is written on the connector: "yes", "no", "then", "owns". A floating
 * text object parked near an arrow is not that, because it does not move when the
 * arrow is re-routed. An arrow's label is positioned on the path rather than in the
 * object's box - see canvas/overlay/textLayer.ts - since an arrow's box can be a
 * single pixel tall.
 *
 * Additive, and safe for documents written before it. A shape created earlier simply
 * has no `text` key; `objectText` returns null for it and `ensureObjectFragment`
 * attaches one the first time somebody actually types into it, so nothing is
 * rewritten on load and no migration is needed.
 */
export const TEXT_BEARING = [
  'text',
  'sticky',
  'rect',
  'ellipse',
  'diamond',
  'parallelogram',
  'triangle',
  'trapezoid',
  'polygon',
  'cylinder',
  'arrow',
  'line',
] as const

// Set lookups rather than `Array.includes`. Both predicates run once per visible
// object per frame, so at 5,000 objects they are called 10,000 times inside the
// budget that has to fit in 16ms.
const PRIMITIVE_SET: ReadonlySet<string> = new Set(PRIMITIVE_SHAPES)
const TEXT_BEARING_SET: ReadonlySet<string> = new Set(TEXT_BEARING)

export function isPrimitiveShape(type: ObjectType): type is PrimitiveShape {
  return PRIMITIVE_SET.has(type)
}

export function isTextBearing(type: ObjectType): boolean {
  return TEXT_BEARING_SET.has(type)
}

/**
 * How far a parallelogram's top edge is pushed right of its box, in world units.
 *
 * The one definition of the shape's geometry. The renderer's SDF, hit-testing, the
 * arrow's stopping point and the label's box all read it from here, because four
 * places disagreeing by a few units is four bugs: a click that misses the shape it
 * landed on, an arrow that stops in the air beside it, a caption that runs out over
 * the slant.
 *
 * Proportional to the shorter side rather than to the width, so the lean is an angle
 * rather than a fraction of the box. Scaled off the width, a wide flowchart box would
 * be a sheared ribbon and a narrow one barely leaning at all; off the shorter side,
 * both keep the same slope. 0.3 is steep enough to read as deliberate at card size
 * and shallow enough to leave a usable line of text between the two edges.
 */
export const PARALLELOGRAM_SLANT = 0.3

export function parallelogramSlant(w: number, h: number): number {
  return Math.min(Math.abs(w), Math.abs(h)) * PARALLELOGRAM_SLANT
}

/**
 * How far a trapezoid's top edge is inset from each side, in world units.
 *
 * Same reasoning as the parallelogram's slant, and the same single definition read by
 * the SDF, the hit test, the arrow's stopping point and the label's box. Proportional
 * to the shorter side so the taper is an angle rather than a fraction of the box. 0.2
 * reads as deliberate without pinching the top edge so far in that a label has nowhere
 * to sit.
 */
export const TRAPEZOID_INSET = 0.2

export function trapezoidInset(w: number, h: number): number {
  return Math.min(Math.abs(w), Math.abs(h)) * TRAPEZOID_INSET
}

/**
 * The number of sides a polygon is drawn with, read from `props.polygonSides`.
 *
 * A number the author chose rather than a geometry constant, so unlike the slant and
 * the inset it lives in `props` and syncs: two people looking at the same polygon see
 * the same one. The default is 6 because a hexagon is what people reach for when they
 * want neither a rectangle nor a circle. Three is the floor because two sides is not a
 * shape, and twelve the ceiling because past it every polygon is the ellipse tool with
 * extra steps.
 */
export const DEFAULT_POLYGON_SIDES = 6
export const MIN_POLYGON_SIDES = 3
export const MAX_POLYGON_SIDES = 12

/**
 * The side count on an object's props, clamped and rounded.
 *
 * Reads raw props rather than a parsed snapshot: it is called per visible polygon per
 * frame by the renderer, and it has to survive whatever a peer wrote into the Y.Map.
 */
export function polygonSidesOf(props: Record<string, unknown>): number {
  const raw = props.polygonSides
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return Math.max(MIN_POLYGON_SIDES, Math.min(MAX_POLYGON_SIDES, Math.round(raw)))
  }
  return DEFAULT_POLYGON_SIDES
}

/**
 * The half-height of a cylinder's cap ellipse, as a fraction of the whole height.
 *
 * A cylinder is a box between two ellipses, and this is the only number that decides
 * how it looks. 0.1 of the height per cap leaves eight tenths of body, which reads as a
 * drum at card size and as a database at diagram size. Unlike the slant and the inset
 * it is a fraction of the height alone: the cap is an ellipse as wide as the box, and
 * tying its depth to the width would make a wide cylinder a pair of saucers.
 */
export const CYLINDER_CAP_RATIO = 0.1

export function cylinderCap(h: number): number {
  return Math.min(Math.abs(h) * CYLINDER_CAP_RATIO, Math.abs(h) / 2)
}

export const shapeProps = z.object({
  fill: z.number().int().default(0x9ec9b0),
  fillAlpha: z.number().min(0).max(1).default(1),
  stroke: z.number().int().default(0x1f2a24),
  strokeAlpha: z.number().min(0).max(1).default(1),
  strokeWidth: z.number().min(0).max(64).default(2),
  cornerRadius: z.number().min(0).default(0),
})

export type ShapeProps = z.infer<typeof shapeProps>

export const objectData = z.object({
  id: z.string().min(1),
  type: z.enum(OBJECT_TYPES),
  // Canvas coordinates, never screen. x/y is the top-left of the unrotated box.
  x: z.number(),
  y: z.number(),
  w: z.number(),
  h: z.number(),
  rotation: z.number().default(0),
  opacity: z.number().min(0).max(1).default(1),
  locked: z.boolean().default(false),
  parentId: z.string().nullable().default(null),
  createdBy: z.string().default(''),
  props: z.record(z.unknown()).default({}),
})

export type ObjectData = z.infer<typeof objectData>

/** Fields stored directly on the object's Y.Map, in the order they are written. */
const SCALAR_FIELDS = [
  'id',
  'type',
  'x',
  'y',
  'w',
  'h',
  'rotation',
  'opacity',
  'locked',
  'parentId',
  'createdBy',
] as const

/**
 * Build the live Y.Map for a new object.
 *
 * `props` is a nested Y.Map rather than a plain object so two users restyling the
 * same shape merge per-property instead of one overwriting the other's whole style.
 */
export function createObjectMap(data: ObjectData): Y.Map<unknown> {
  const map = new Y.Map<unknown>()

  for (const field of SCALAR_FIELDS) map.set(field, data[field])

  const props = new Y.Map<unknown>()
  for (const [key, value] of Object.entries(data.props)) props.set(key, value)
  map.set('props', props)

  if (isTextBearing(data.type)) map.set('text', new Y.XmlFragment())

  return map
}

function readProps(map: Y.Map<unknown>): Record<string, unknown> {
  const raw = map.get('props')
  if (raw instanceof Y.Map) return Object.fromEntries(raw.entries()) as Record<string, unknown>
  if (raw !== null && typeof raw === 'object') return { ...(raw as Record<string, unknown>) }
  return {}
}

/**
 * Snapshot a Y.Map as plain data.
 *
 * A snapshot, not a view: it does not track later changes. Re-read after any edit.
 */
export function readObject(map: Y.Map<unknown>): ObjectData {
  return {
    id: String(map.get('id') ?? ''),
    type: (map.get('type') ?? 'rect') as ObjectType,
    x: Number(map.get('x') ?? 0),
    y: Number(map.get('y') ?? 0),
    w: Number(map.get('w') ?? 0),
    h: Number(map.get('h') ?? 0),
    rotation: Number(map.get('rotation') ?? 0),
    opacity: Number(map.get('opacity') ?? 1),
    locked: Boolean(map.get('locked') ?? false),
    parentId: (map.get('parentId') as string | null) ?? null,
    createdBy: String(map.get('createdBy') ?? ''),
    props: readProps(map),
  }
}

/** Apply a partial update. Caller is responsible for wrapping this in a transaction. */
export function writeObject(map: Y.Map<unknown>, patch: Partial<ObjectData>): void {
  for (const field of SCALAR_FIELDS) {
    if (field in patch) map.set(field, patch[field])
  }

  if (patch.props !== undefined) {
    const props = map.get('props')
    // Per-key writes, so a concurrent change to a property this patch does not
    // mention survives. Replacing the whole map would discard it.
    if (props instanceof Y.Map) {
      for (const [key, value] of Object.entries(patch.props)) props.set(key, value)
    } else {
      const fresh = new Y.Map<unknown>()
      for (const [key, value] of Object.entries(patch.props)) fresh.set(key, value)
      map.set('props', fresh)
    }
  }
}

/** The text fragment for a text-bearing object, or null. */
export function objectText(map: Y.Map<unknown>): Y.XmlFragment | null {
  const text = map.get('text')
  return text instanceof Y.XmlFragment ? text : null
}

export function shapePropsOf(data: ObjectData): ShapeProps {
  return shapeProps.parse(data.props)
}

/** Axis-aligned bounds ignoring rotation. The spatial index stores these. */
export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** Bounds including rotation, which is what hit-testing and culling need. */
export function objectBounds(data: ObjectData): Bounds {
  if (data.rotation === 0) {
    return { minX: data.x, minY: data.y, maxX: data.x + data.w, maxY: data.y + data.h }
  }

  const halfW = data.w / 2
  const halfH = data.h / 2
  const centerX = data.x + halfW
  const centerY = data.y + halfH
  const cos = Math.abs(Math.cos(data.rotation))
  const sin = Math.abs(Math.sin(data.rotation))
  const extentX = halfW * cos + halfH * sin
  const extentY = halfW * sin + halfH * cos

  return {
    minX: centerX - extentX,
    minY: centerY - extentY,
    maxX: centerX + extentX,
    maxY: centerY + extentY,
  }
}
