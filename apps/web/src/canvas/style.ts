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

/*
 * Object fills.
 *
 * Tuned against the app palette: the same soft, slightly desaturated family, so a
 * board full of shapes sits inside the chrome rather than shouting over it. Saturated
 * primaries are what make a whiteboard look like a toy at any real object count.
 */
const DEFAULT_FILL: Partial<Record<ObjectType, number>> = {
  rect: 0xbcd6f5,
  ellipse: 0xb6e3e0,
  diamond: 0xf3d9a4,
  sticky: 0xfdeeb0,
  frame: 0xf1eee9,
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
    stroke: numberProp(props, 'stroke', 0x2a3340),
    strokeAlpha: numberProp(props, 'strokeAlpha', bare ? 0 : 1) * object.opacity,
    strokeWidth: numberProp(props, 'strokeWidth', bare ? 0 : 2),
    // Softly rounded by default. A hard 90-degree corner is the other half of why an
    // unstyled shape reads as a wireframe rather than as a finished object.
    radius: numberProp(props, 'cornerRadius', object.type === 'sticky' ? 8 : 4),
  }
}

/*
 * Canvas chrome, matched to the app's accent so the selection box and the primary
 * button are recognisably the same blue. These are read at 60fps, so they are
 * constants rather than a CSS lookup; only the background below has to follow the
 * theme, because it is the one colour that fills the screen.
 */
export const SELECTION_COLOR = 0x3f86f0
/** The highlight on a shape an arrow end would attach to. */
export const BINDING_COLOR = 0xe05c8a
export const GUIDE_COLOR = 0xe05c8a
export const MARQUEE_FILL = 0x3f86f0

/** Fallback if the host element has no resolved ink yet. */
const INK_FALLBACK = 0x2a3340

function parseCssColor(value: string, fallback: number): number {
  const match = /rgba?\(([^)]+)\)/.exec(value)
  if (match === null) return fallback

  const parts = match[1].split(/[,\s/]+/).filter((piece) => piece !== '')
  if (parts.length < 3) return fallback

  const [r, g, b] = parts.map((piece) => Math.max(0, Math.min(255, Math.round(Number(piece)))))
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return fallback

  return (r << 16) | (g << 8) | b
}

/**
 * The theme's ink for strokes drawn straight onto the board.
 *
 * Only ever a *default*. An arrow whose document says it is red stays red in both
 * themes; this is what an arrow that never chose a colour gets, and it is the
 * difference between a dark board with connectors on it and a dark board that looks
 * empty.
 */
export function readCanvasInk(element: HTMLElement): number {
  if (typeof getComputedStyle !== 'function') return INK_FALLBACK
  return parseCssColor(getComputedStyle(element).color, INK_FALLBACK)
}
