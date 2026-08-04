/**
 * Default fills for object types the batch renderer draws.
 *
 * Style lives in `props` on each object so it syncs, but a freshly created object has
 * no explicit style, and reading a missing property must not cost a validator call in
 * the render loop.
 */

import type { ObjectData, ObjectType } from '@meadow/schema'
import { SHAPE_DIAMOND, SHAPE_ELLIPSE, SHAPE_RECT, type ShapeKind } from './renderers/shapeBatch'

export type ResolvedStyle = {
  kind: ShapeKind
  fill: number
  fillAlpha: number
  stroke: number
  strokeAlpha: number
  strokeWidth: number
  radius: number
}

const DEFAULT_FILL: Partial<Record<ObjectType, number>> = {
  rect: 0x9ec9b0,
  ellipse: 0xa8c8e8,
  diamond: 0xe8c468,
  sticky: 0xf5e6a3,
  frame: 0xf0f0ee,
  text: 0xffffff,
}

const KINDS: Partial<Record<ObjectType, ShapeKind>> = {
  rect: SHAPE_RECT,
  ellipse: SHAPE_ELLIPSE,
  diamond: SHAPE_DIAMOND,
  sticky: SHAPE_RECT,
  frame: SHAPE_RECT,
  text: SHAPE_RECT,
  image: SHAPE_RECT,
  table: SHAPE_RECT,
  chart: SHAPE_RECT,
  embed: SHAPE_RECT,
}

/**
 * Types the batch cannot draw yet. Arrows, lines and freedraw are irregular paths and
 * get their own Graphics pass in M4; triangle needs another SDF branch. Returning null
 * skips them rather than drawing a misleading rectangle in their place.
 */
export function shapeKindFor(type: ObjectType): ShapeKind | null {
  return KINDS[type] ?? null
}

function numberProp(props: Record<string, unknown>, key: string, fallback: number): number {
  const value = props[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * A plain text object has no box of its own.
 *
 * It is drawn by the batch only so it has a hit target and so a selection rectangle
 * has something to sit on. Painting a white card behind every caption would make a
 * board of annotations look like a board of index cards.
 */
const TRANSPARENT_BOX = new Set<ObjectType>(['text'])

/** Read style off an object without running a validator. Called once per visible object per frame. */
export function resolveStyle(object: ObjectData, kind: ShapeKind): ResolvedStyle {
  const props = object.props
  const bare = TRANSPARENT_BOX.has(object.type)
  return {
    kind,
    fill: numberProp(props, 'fill', DEFAULT_FILL[object.type] ?? 0x9ec9b0),
    fillAlpha: numberProp(props, 'fillAlpha', bare ? 0 : 1) * object.opacity,
    stroke: numberProp(props, 'stroke', 0x1f2a24),
    strokeAlpha: numberProp(props, 'strokeAlpha', bare ? 0 : 1) * object.opacity,
    strokeWidth: numberProp(props, 'strokeWidth', bare ? 0 : 2),
    radius: numberProp(props, 'cornerRadius', object.type === 'sticky' ? 6 : 0),
  }
}

export const SELECTION_COLOR = 0x2f7d4f
export const GUIDE_COLOR = 0xd8456b
export const MARQUEE_FILL = 0x2f7d4f
