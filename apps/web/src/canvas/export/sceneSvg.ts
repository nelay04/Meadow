/**
 * The board's shapes, arrows and ink as SVG, for the image export.
 *
 * Vector rather than a capture of the WebGL canvas, and that is the whole point of the
 * export. A capture has a fixed number of pixels, so a large diagram either comes out
 * soft or comes out bigger than a browser will allocate; a path has no pixels at all
 * and is as sharp at a thousand times as it is at one.
 *
 * Faithful to the renderer rather than to a second idea of it. Every outline here is
 * the one the SDF branch in `renderers/shapeBatch.ts` evaluates, with the stroke
 * centred on the edge and painted over the fill as the shader paints it. Arrows come
 * from `arrowGeometry`, the function the arrow pass draws with, and ink from
 * `strokeOutline` and `placeInkOutline`, which the ink pass uses. Colours come in
 * resolved, from the same `resolveStyle` the batch is fed from, so the theme defaults
 * cannot drift between the screen and the file.
 *
 * Text is not here. It lives in the DOM overlay and is written by `textSvg.ts`.
 *
 * Everything that reaches the markup is either a finite number or a colour built from
 * one. Nothing a user typed is written by this module.
 */

import { type FreedrawProps, type ObjectData, strokeOutline } from '@meadow/schema'

import type { ResolvedStyle } from '../style'
import { type ArrowDraw, arrowGeometry } from '../renderers/arrowPass'
import { placeInkOutline } from '../renderers/inkPass'
import {
  SHAPE_CYLINDER,
  SHAPE_DIAMOND,
  SHAPE_ELLIPSE,
  SHAPE_PARALLELOGRAM,
  SHAPE_POLYGON,
  SHAPE_STICKY,
  SHAPE_TRAPEZOID,
  SHAPE_TRIANGLE,
} from '../renderers/shapeBatch'

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * A number as SVG will read it. Three places is a thousandth of a world unit, which
 * stays under a pixel until somebody zooms the file past a thousand times. Anything
 * not finite is 0 rather than `NaN` in the markup.
 */
export function num(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const rounded = Math.round(value * 1000) / 1000
  return Object.is(rounded, -0) ? '0' : String(rounded)
}

export function hex(colour: number): string {
  return `#${((colour >>> 0) & 0xffffff).toString(16).padStart(6, '0')}`
}

/** Text escaped for SVG content or a double-quoted attribute. Control characters are dropped. */
export function escapeXml(value: string): string {
  let out = ''
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0
    if ((code < 32 && code !== 9 && code !== 10) || code === 127) continue
    if (ch === '&') out += '&amp;'
    else if (ch === '<') out += '&lt;'
    else if (ch === '>') out += '&gt;'
    else if (ch === '"') out += '&quot;'
    else if (ch === "'") out += '&#39;'
    else out += ch
  }
  return out
}

const alpha = (value: number): string => num(Math.min(1, Math.max(0, value)))

/** Unique ids for the gradients and clips one document needs. */
export type IdSource = () => string

export function idSource(prefix = 'm'): IdSource {
  let next = 0
  return () => {
    next += 1
    return `${prefix}${next}`
  }
}

/** Grow a bounds by a point. Mutates and returns it, so a walk allocates nothing per point. */
export function extend(bounds: Bounds, x: number, y: number): Bounds {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return bounds
  if (x < bounds.minX) bounds.minX = x
  if (y < bounds.minY) bounds.minY = y
  if (x > bounds.maxX) bounds.maxX = x
  if (y > bounds.maxY) bounds.maxY = y
  return bounds
}

export const emptyBounds = (): Bounds => ({
  minX: Infinity,
  minY: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
})

// --- shapes ----------------------------------------------------------------------------

/** The note's own corner radius. A constant in the shader, so a constant here. */
const STICKY_CORNER = 2
const ROOT_HALF = Math.SQRT1_2

type Box = { x: number; y: number; w: number; h: number }

/** The fillet where a sticky's crease meets an edge: a quadratic with the sharp corner as its control. */
const creaseCorner = (cx: number, cy: number, t: number): string =>
  `Q${num(cx)} ${num(cy)} ${num(cx - t * ROOT_HALF)} ${num(cy + t * ROOT_HALF)}`

const points = (list: readonly number[]): string => list.map(num).join(' ')

/**
 * The silhouette of one shape, as a single element with no paint of its own.
 *
 * `geometry` is the batch's radius slot: a corner radius, or the slant, inset, side
 * count, cap or fold the shape's own geometry needs. See `geometryOf` in `style.ts`.
 */
export function shapeOutline(kind: number, box: Box, geometry: number): string {
  const { x, y, w, h } = box
  switch (kind) {
    case SHAPE_ELLIPSE:
      return `<ellipse cx="${num(x + w / 2)}" cy="${num(y + h / 2)}" rx="${num(w / 2)}" ry="${num(h / 2)}"/>`
    case SHAPE_DIAMOND:
      return `<polygon points="${points([x + w / 2, y, x + w, y + h / 2, x + w / 2, y + h, x, y + h / 2])}"/>`
    case SHAPE_TRIANGLE:
      // Apex centred on the top edge, base the full width: the box a rect would fill.
      return `<polygon points="${points([x + w / 2, y, x + w, y + h, x, y + h])}"/>`
    case SHAPE_PARALLELOGRAM: {
      // Top edge leaned right, as the shader's y flip leans it.
      const s = Math.min(Math.max(geometry, 0), w)
      return `<polygon points="${points([x + s, y, x + w, y, x + w - s, y + h, x, y + h])}"/>`
    }
    case SHAPE_TRAPEZOID: {
      // Narrow edge on top.
      const i = Math.min(Math.max(geometry, 0), w / 2)
      return `<polygon points="${points([x + i, y, x + w - i, y, x + w, y + h, x, y + h])}"/>`
    }
    case SHAPE_POLYGON: {
      // Vertices on the bounding ellipse, one at the top, as `sdPolygon` places them.
      const sides = Math.max(3, Math.round(geometry))
      const list: number[] = []
      for (let k = 0; k < sides; k += 1) {
        const angle = -Math.PI / 2 + (k * Math.PI * 2) / sides
        list.push(x + w / 2 + (Math.cos(angle) * w) / 2, y + h / 2 + (Math.sin(angle) * h) / 2)
      }
      return `<polygon points="${points(list)}"/>`
    }
    case SHAPE_CYLINDER: {
      const cap = Math.min(Math.max(geometry, 0), h / 2)
      const rx = w / 2
      return (
        `<path d="M${num(x)} ${num(y + cap)} L${num(x)} ${num(y + h - cap)}` +
        ` A${num(rx)} ${num(cap)} 0 0 0 ${num(x + w)} ${num(y + h - cap)} L${num(x + w)} ${num(y + cap)}` +
        ` A${num(rx)} ${num(cap)} 0 0 0 ${num(x)} ${num(y + cap)} Z"/>`
      )
    }
    case SHAPE_STICKY:
      return `<path d="${stickyPath(box, geometry)}"/>`
    default: {
      const r = Math.min(Math.max(geometry, 0), w / 2, h / 2)
      return `<rect x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}" rx="${num(r)}"/>`
    }
  }
}

/**
 * A note with its bottom-right corner turned over, so the corner is really gone from
 * the silhouette. The fillets are the shader's: `tip` rounds the two places the crease
 * runs out into the edges.
 */
function stickyPath(box: Box, fold: number): string {
  const { x, y, w, h } = box
  const f = Math.min(Math.max(fold, 0), w, h)
  const t = f * 0.12
  const r = Math.min(STICKY_CORNER, w / 2, h / 2)
  return (
    `M${num(x + r)} ${num(y)} L${num(x + w - r)} ${num(y)}` +
    ` A${num(r)} ${num(r)} 0 0 1 ${num(x + w)} ${num(y + r)}` +
    ` L${num(x + w)} ${num(y + h - f - t)} ${creaseCorner(x + w, y + h - f, t)}` +
    ` L${num(x + w - f + t * ROOT_HALF)} ${num(y + h - t * ROOT_HALF)}` +
    ` Q${num(x + w - f)} ${num(y + h)} ${num(x + w - f - t)} ${num(y + h)}` +
    ` L${num(x + r)} ${num(y + h)} A${num(r)} ${num(r)} 0 0 1 ${num(x)} ${num(y + h - r)}` +
    ` L${num(x)} ${num(y + r)} A${num(r)} ${num(r)} 0 0 1 ${num(x + r)} ${num(y)} Z`
  )
}

/** The triangle a note's corner lands on once it is turned over, inside the note. */
function stickyFlapPath(box: Box, fold: number): string {
  const f = Math.min(Math.max(fold, 0), box.w, box.h)
  const t = f * 0.12
  const free = Math.max(STICKY_CORNER, f * 0.18)
  const right = box.x + box.w
  const bottom = box.y + box.h
  const top = bottom - f
  const left = right - f
  return (
    `M${num(left + free)} ${num(top)} L${num(right - t)} ${num(top)}` +
    ` ${creaseCorner(right, top, t)}` +
    ` L${num(left + t * ROOT_HALF)} ${num(bottom - t * ROOT_HALF)}` +
    ` Q${num(left)} ${num(bottom)} ${num(left)} ${num(bottom - t)}` +
    ` L${num(left)} ${num(top + free)} Q${num(left)} ${num(top)} ${num(left + free)} ${num(top)} Z`
  )
}

/** `t` of the way from one packed colour to another, per channel. */
function mix(from: number, to: number, t: number): number {
  let out = 0
  for (let shift = 16; shift >= 0; shift -= 8) {
    const a = (from >> shift) & 0xff
    const b = (to >> shift) & 0xff
    out |= Math.round(a + (b - a) * t) << shift
  }
  return out
}

/**
 * The shader's paper colour at a given amount of fold: the note's fill run towards its
 * edge colour, and darkened by up to a tenth. Zero is flat paper, one is the crease.
 */
function foldShade(fill: number, stroke: number, fold: number): number {
  return mix(mix(fill, stroke, fold), 0x000000, 0.1 * fold)
}

/**
 * The turned-over corner, shaded as the shader shades it.
 *
 * The flap runs from the crease, which is the edge colour a tenth darker, to its free
 * corner, a little lighter; a gradient across it is that ramp exactly. Under the flap's
 * two free edges the note takes a narrow band of shadow, which the shader fades out
 * over a fifth of the fold. That fade is a stroke round the flap softened by a blur,
 * clipped to the note so nothing lands outside the paper, with the flap filled over
 * its inner half. A blur rather than stepped strokes: its deviation is in world units,
 * so it is the same smooth fade at any zoom, where steps show as bands once enlarged.
 */
function stickyFlap(box: Box, fold: number, style: ResolvedStyle, ids: IdSource): string {
  const f = Math.min(Math.max(fold, 0), box.w, box.h)
  if (f <= 0) return ''
  const right = box.x + box.w
  const bottom = box.y + box.h
  const flap = stickyFlapPath(box, f)
  const fillAlpha = alpha(style.fillAlpha)

  const clip = ids()
  const blur = ids()
  const shadow = hex(foldShade(style.fill, style.stroke, 0.4))
  let out =
    `<clipPath id="${clip}"><path d="${stickyPath(box, f)}"/></clipPath>` +
    `<filter id="${blur}" x="-50%" y="-50%" width="200%" height="200%">` +
    `<feGaussianBlur stdDeviation="${num(f * 0.05)}"/></filter>` +
    `<g clip-path="url(#${clip})">` +
    `<path d="${flap}" fill="none" stroke="${shadow}" stroke-width="${num(f * 0.2)}"` +
    ` stroke-linejoin="round" stroke-opacity="${fillAlpha}" filter="url(#${blur})"/></g>`

  const gradient = ids()
  out +=
    `<linearGradient id="${gradient}" gradientUnits="userSpaceOnUse"` +
    ` x1="${num(right - f / 2)}" y1="${num(bottom - f / 2)}" x2="${num(right - f)}" y2="${num(bottom - f)}">` +
    `<stop offset="0" stop-color="${hex(foldShade(style.fill, style.stroke, 1))}"/>` +
    `<stop offset="0.5" stop-color="${hex(foldShade(style.fill, style.stroke, 0.92))}"/>` +
    `<stop offset="1" stop-color="${hex(foldShade(style.fill, style.stroke, 0.84))}"/>` +
    `</linearGradient>` +
    `<path d="${flap}" fill="url(#${gradient})" fill-opacity="${fillAlpha}" stroke="none"/>`
  return out
}

/**
 * The front of a cylinder's top cap: the arc inside the silhouette that says
 * "cylinder" rather than "rounded box". The shader strokes it as a seam.
 */
function cylinderSeam(box: Box, geometry: number): string {
  const cap = Math.min(Math.max(geometry, 0), box.h / 2)
  return (
    `<path d="M${num(box.x)} ${num(box.y + cap)} A${num(box.w / 2)} ${num(cap)} 0 0 0` +
    ` ${num(box.x + box.w)} ${num(box.y + cap)}" fill="none"/>`
  )
}

function normalBox(object: ObjectData): Box {
  return {
    x: Math.min(object.x, object.x + object.w),
    y: Math.min(object.y, object.y + object.h),
    w: Math.abs(object.w),
    h: Math.abs(object.h),
  }
}

function rotation(object: ObjectData, box: Box): string {
  if (object.rotation === 0 || !Number.isFinite(object.rotation)) return ''
  return ` transform="rotate(${num((object.rotation * 180) / Math.PI)} ${num(box.x + box.w / 2)} ${num(box.y + box.h / 2)})"`
}

/** The four corners of an object's box after its rotation, into `bounds`. */
export function extendByBox(bounds: Bounds, object: ObjectData, pad = 0): void {
  const box = normalBox(object)
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const cos = Math.cos(object.rotation || 0)
  const sin = Math.sin(object.rotation || 0)
  const hw = box.w / 2 + pad
  const hh = box.h / 2 + pad
  for (const [dx, dy] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ]) {
    extend(bounds, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
  }
}

/** One shape from the batch, as the shader would paint it. Empty for one with no paint. */
export function shapeSvg(object: ObjectData, style: ResolvedStyle, ids: IdSource): string {
  const box = normalBox(object)
  if (box.w <= 0 || box.h <= 0) return ''

  const hasFill = style.fillAlpha > 0
  const hasStroke = style.strokeWidth > 0 && style.strokeAlpha > 0
  if (!hasFill && !hasStroke) return ''

  const paint =
    `fill="${hasFill ? hex(style.fill) : 'none'}"` +
    (hasFill && style.fillAlpha < 1 ? ` fill-opacity="${alpha(style.fillAlpha)}"` : '') +
    ` stroke="${hasStroke ? hex(style.stroke) : 'none'}"` +
    (hasStroke
      ? ` stroke-width="${num(style.strokeWidth)}"` +
        (style.strokeAlpha < 1 ? ` stroke-opacity="${alpha(style.strokeAlpha)}"` : '')
      : '')

  // The flap sits between the fill and the outline, so the paint is split for a note:
  // fill first, then the fold, then the outline over both, as the shader composes it.
  if (style.kind === SHAPE_STICKY) {
    const outline = shapeOutline(style.kind, box, style.radius)
    let out = `<g${rotation(object, box)}>`
    if (hasFill) {
      out +=
        `<g fill="${hex(style.fill)}" stroke="none"` +
        (style.fillAlpha < 1 ? ` fill-opacity="${alpha(style.fillAlpha)}"` : '') +
        `>${outline}</g>` +
        stickyFlap(box, style.radius, style, ids)
    }
    if (hasStroke) {
      out +=
        `<g fill="none" stroke="${hex(style.stroke)}" stroke-width="${num(style.strokeWidth)}"` +
        (style.strokeAlpha < 1 ? ` stroke-opacity="${alpha(style.strokeAlpha)}"` : '') +
        `>${outline}</g>`
    }
    return `${out}</g>`
  }

  let body = shapeOutline(style.kind, box, style.radius)
  if (style.kind === SHAPE_CYLINDER && hasStroke) body += cylinderSeam(box, style.radius)
  return `<g${rotation(object, box)} ${paint}>${body}</g>`
}

// --- arrows ----------------------------------------------------------------------------

const polyline = (path: readonly number[]): string => {
  let d = ''
  for (let i = 0; i + 1 < path.length; i += 2) {
    d += `${i === 0 ? 'M' : 'L'}${num(path[i])} ${num(path[i + 1])}`
  }
  return d
}

/**
 * One arrow, from the same paths the arrow pass strokes and fills.
 *
 * Opacity on the group rather than on each path, so where a head meets its shaft the
 * overlap is not painted twice and a translucent arrow does not get dark joints.
 */
export function arrowSvg(arrow: ArrowDraw, bounds?: Bounds): string {
  const geometry = arrowGeometry(arrow)
  if (geometry === null || arrow.strokeAlpha <= 0) return ''

  const colour = hex(arrow.stroke)
  let stroked = ''
  for (const path of geometry.shafts) stroked += polyline(path)
  for (const path of geometry.openHeads) stroked += polyline(path)
  let filled = ''
  for (const path of geometry.solidHeads) filled += `${polyline(path)}Z`

  if (bounds !== undefined) {
    const reach = arrow.strokeWidth / 2
    for (const list of [geometry.shafts, geometry.openHeads, geometry.solidHeads]) {
      for (const path of list) {
        for (let i = 0; i + 1 < path.length; i += 2) {
          extend(bounds, path[i] - reach, path[i + 1] - reach)
          extend(bounds, path[i] + reach, path[i + 1] + reach)
        }
      }
    }
  }

  let out = `<g${arrow.strokeAlpha < 1 ? ` opacity="${alpha(arrow.strokeAlpha)}"` : ''}>`
  if (stroked !== '') {
    out +=
      `<path d="${stroked}" fill="none" stroke="${colour}" stroke-width="${num(arrow.strokeWidth)}"` +
      ` stroke-linecap="round" stroke-linejoin="round"/>`
  }
  if (filled !== '') out += `<path d="${filled}" fill="${colour}" stroke="none"/>`
  return `${out}</g>`
}

// --- ink -------------------------------------------------------------------------------

/**
 * One pen stroke, as the filled outline the ink pass tessellates.
 *
 * The outline is a run of convex pieces, which is how `strokeOutline` keeps a
 * self-crossing stroke from filling its own loops. One path with the nonzero rule
 * paints their union, so a translucent highlighter does not darken where two pieces
 * overlap.
 */
export function inkSvg(
  object: ObjectData,
  props: FreedrawProps,
  colour: number,
  opacity: number,
  bounds?: Bounds,
): string {
  if (opacity <= 0) return ''
  const pieces = strokeOutline(props.points, props)
  const place = {
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    halfW: object.w / 2,
    halfH: object.h / 2,
  }
  let d = ''
  for (const piece of pieces) {
    if (piece.length < 6) continue
    const placed = placeInkOutline(piece, place)
    d += `${polyline(placed)}Z`
    if (bounds !== undefined) {
      for (let i = 0; i + 1 < placed.length; i += 2) extend(bounds, placed[i], placed[i + 1])
    }
  }
  if (d === '') return ''
  return (
    `<path d="${d}" fill="${hex(colour)}" fill-rule="nonzero"` +
    (opacity < 1 ? ` fill-opacity="${alpha(opacity)}"` : '') +
    '/>'
  )
}

// --- the document ----------------------------------------------------------------------

/**
 * Wrap drawn layers into one standalone SVG document.
 *
 * `width` and `height` are the file's natural size in CSS pixels, one per world unit,
 * which is what a viewer opens it at. The viewBox is the world rectangle, so the
 * markup inside keeps world coordinates and nothing had to be transformed to write it.
 */
export function svgDocument(options: {
  view: { x: number; y: number; w: number; h: number }
  background: string | null
  defs: string
  body: string
  title: string
}): string {
  const { view } = options
  const background =
    options.background === null
      ? ''
      : `<rect x="${num(view.x)}" y="${num(view.y)}" width="${num(view.w)}" height="${num(view.h)}"` +
        ` fill="${escapeXml(options.background)}"/>`
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(view.w)}" height="${num(view.h)}"` +
    ` viewBox="${num(view.x)} ${num(view.y)} ${num(view.w)} ${num(view.h)}">` +
    `<title>${escapeXml(options.title)}</title>` +
    (options.defs === '' ? '' : `<defs>${options.defs}</defs>`) +
    background +
    options.body +
    '</svg>'
  )
}
