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
  'triangle',
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

/** Types the instanced shape renderer can draw. Everything else needs its own path. */
export const PRIMITIVE_SHAPES = ['rect', 'ellipse', 'diamond'] as const
export type PrimitiveShape = (typeof PRIMITIVE_SHAPES)[number]

/** Types that carry a `Y.XmlFragment`. Only these ever get one. */
export const TEXT_BEARING = ['text', 'sticky'] as const

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
