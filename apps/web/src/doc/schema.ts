/**
 * Re-export of the shared CRDT schema.
 *
 * The types moved to `packages/schema` in M2, once the canvas engine, the doc layer,
 * and the renderer all needed them. This file stays as the app-facing entry point so
 * imports read as document concerns rather than package plumbing.
 */

import { PRIMITIVE_SHAPES } from '@meadow/schema'

export {
  OBJECT_TYPES,
  PRIMITIVE_SHAPES,
  ROOT_BINDINGS,
  ROOT_META,
  ROOT_OBJECTS,
  ROOT_ORDER,
  type Bounds,
  type ObjectData,
  type ObjectType,
  type PrimitiveShape,
  type ShapeProps,
  docRoots,
  isPrimitiveShape,
  isTextBearing,
  nanoid,
  objectBounds,
  readObject,
} from '@meadow/schema'

/** Legacy alias. `ObjectData` is the name to use in new code. */
export type { ObjectData as CanvasObject } from '@meadow/schema'

/**
 * The subset of types the shape rail can create.
 *
 * The primitives, which is the same list by definition rather than by coincidence: a
 * shape the batch can draw is a shape the rail can offer, and keeping a second hand
 * written copy here is how one of them ends up missing a shape.
 */
export const CREATABLE_TYPES = PRIMITIVE_SHAPES
