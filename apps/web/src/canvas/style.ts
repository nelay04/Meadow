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

/**
 * Neutral by default, and legible against the board rather than decorative.
 *
 * A new shape gets no colour at all: a solid surface a step away from the board, with
 * a definite outline. Colour on a diagram should mean something the author chose, and
 * a palette assigned by shape type means a rectangle is blue for no reason anyone can
 * explain. It also stops a board reading as a bag of sweets at any real object count.
 *
 * Both themes, because these are painted straight onto the board surface: a light
 * card on a dark board is as wrong as a dark one on a light board.
 */
type SurfaceDefaults = { fill: number; stroke: number }

const SHAPE_DEFAULTS: Record<'light' | 'dark', SurfaceDefaults> = {
  light: { fill: 0xffffff, stroke: 0x4e555f },
  dark: { fill: 0x262e3a, stroke: 0xb3bdcb },
}

/**
 * The default ink for a connector, which is deliberately *lighter* than a shape's
 * outline rather than darker.
 *
 * The first version had this the other way round, reading the board's text colour for
 * arrows and giving shapes a pale outline, and a diagram drawn that way inverts its
 * own hierarchy: the connectors shout and the boxes they connect recede. A box is the
 * thing being said; an arrow is the relation between two of them, and it should read
 * as one weight quieter. It is also what every diagram worth copying does.
 *
 * Only ever a default. An arrow whose document carries an explicit `stroke` keeps it,
 * in both themes, which is why this is not simply folded into the theme's ink.
 */
const CONNECTOR_INK: Record<'light' | 'dark', number> = {
  light: 0x76808c,
  dark: 0x8d97a5,
}

export function connectorInk(dark: boolean): number {
  return CONNECTOR_INK[dark ? 'dark' : 'light']
}

/**
 * A sticky carries a colour of its own. That is not decoration: the whole point of a
 * note is that it reads as a thing dropped on the board rather than drawn on it.
 *
 * The dark variant is a deep blue rather than the same pale one. Text on a sticky
 * follows the theme's ink, which is light on a dark board, so a pale card would be
 * light type on a light field. Same hue, opposite end of it.
 */
const STICKY_FILL: Record<'light' | 'dark', SurfaceDefaults> = {
  light: { fill: 0xa8daff, stroke: 0x7cb4dd },
  dark: { fill: 0x1f4d73, stroke: 0x3d769f },
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
 * Types the batch cannot draw. Irregular paths are not signed distance fields, so
 * arrows and lines go through the arrow pass and freehand ink through the ink pass;
 * triangle needs another SDF branch and has not been given one. Returning null skips
 * them rather than drawing a misleading rectangle in their place.
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

/**
 * Read style off an object without running a validator. Called once per visible object
 * per frame.
 *
 * `dark` picks the theme's defaults. It is only ever consulted for a property the
 * document does not carry: a shape whose author chose a fill keeps it in both themes.
 */
export function resolveStyle(object: ObjectData, kind: ShapeKind, dark = false): ResolvedStyle {
  const props = object.props
  const bare = TRANSPARENT_BOX.has(object.type)
  const theme = dark ? 'dark' : 'light'
  const surface = object.type === 'sticky' ? STICKY_FILL[theme] : SHAPE_DEFAULTS[theme]
  return {
    kind,
    fill: numberProp(props, 'fill', surface.fill),
    fillAlpha: numberProp(props, 'fillAlpha', bare ? 0 : 1) * object.opacity,
    stroke: numberProp(props, 'stroke', surface.stroke),
    strokeAlpha: numberProp(props, 'strokeAlpha', bare ? 0 : 1) * object.opacity,
    strokeWidth: numberProp(props, 'strokeWidth', bare ? 0 : 2),
    // Softly rounded by default. A hard 90-degree corner is the other half of why an
    // unstyled shape reads as a wireframe rather than as a finished object. A sticky
    // is the exception and gets a tighter one: a note is a cut square of paper, and
    // the more its corners are rounded the more it reads as a button.
    radius: numberProp(props, 'cornerRadius', object.type === 'sticky' ? 2 : 4),
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
const SURFACE_FALLBACK = 0xfbf9f5

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

/**
 * Is the board dark?
 *
 * Answered from the board's own luminance rather than from a third CSS variable or a
 * copy of the theme setting. There is exactly one thing that decides which defaults
 * are right - what colour the surface underneath actually is - and this reads it.
 */
export function isDarkSurface(element: HTMLElement): boolean {
  if (typeof getComputedStyle !== 'function') return false

  const declared = getComputedStyle(element).backgroundColor
  // A transparent background is "no answer", not "black". Reading it as black is how
  // the dev harness - which has no background of its own - ended up with dark-theme
  // shapes on a white page. Fall back rather than guess from a colour that is not
  // being painted.
  if (/rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(declared) || declared === 'transparent') {
    return false
  }

  const surface = parseCssColor(declared, SURFACE_FALLBACK)
  const r = (surface >> 16) & 0xff
  const g = (surface >> 8) & 0xff
  const b = surface & 0xff
  // Rec. 601 luma, which is plenty for a light-or-dark question.
  return 0.299 * r + 0.587 * g + 0.114 * b < 128
}
