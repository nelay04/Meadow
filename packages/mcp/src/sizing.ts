/**
 * How big a node has to be to hold its label.
 *
 * A shape's label is centred inside it and the shape does not grow to fit (`autoHeight`
 * is off for shapes, see `text.ts` in the schema), so a box sized without looking at its
 * text is a box the text spills out of. The server has no DOM to measure with, so this
 * estimates: an average glyph width per font size, word wrapping at a chosen width, and
 * the same line height, paragraph spacing and padding the overlay uses. It errs large,
 * because a little air around a label is fine and a clipped one is not.
 *
 * Shapes that are not rectangles hold less text than their box. The overlay lays a label
 * out in the largest centred rectangle inside the shape (`INSCRIBED` in textLayer.ts),
 * and the ratios here are the same ones, so a diamond sized here fits what it says.
 */

import {
  PARALLELOGRAM_SLANT,
  TRAPEZOID_INSET,
  type ObjectType,
  resolveTextProps,
  objectData,
} from '@meadow/schema'

import type { SpecNodeType } from './mermaid'

export type Size = { w: number; h: number }

/** Average advance of a glyph, in ems. Comic Neue and Inter both sit near 0.5; a margin on top. */
const GLYPH_EM = 0.56
/** How far a bullet list is indented, in ems, bullet included. */
const BULLET_EM = 1.6
/** Heading sizes as the overlay's prose styles have them, in ems of the body size. */
const HEADING_EM: Record<number, number> = { 1: 1.6, 2: 1.35, 3: 1.15 }

/** The smallest box each type is drawn at, whatever its label. */
export const MIN_SIZES: Record<SpecNodeType, Size> = {
  rect: { w: 180, h: 80 },
  ellipse: { w: 150, h: 90 },
  diamond: { w: 170, h: 110 },
  parallelogram: { w: 190, h: 80 },
  triangle: { w: 140, h: 110 },
  trapezoid: { w: 180, h: 80 },
  polygon: { w: 150, h: 110 },
  cylinder: { w: 140, h: 110 },
  sticky: { w: 180, h: 195 },
  text: { w: 220, h: 32 },
}

/** The widest a label is allowed to make its text area before it wraps instead. */
const MAX_TEXT_WIDTH = 240

/** Fraction of the box a label may use on each axis. Mirrors `INSCRIBED` in textLayer.ts. */
function inscribed(type: SpecNodeType, w: number, h: number): { x: number; y: number } {
  const short = Math.min(w, h)
  switch (type) {
    case 'diamond':
    case 'triangle':
      return { x: 0.5, y: 0.5 }
    case 'ellipse':
      return { x: Math.SQRT1_2, y: Math.SQRT1_2 }
    case 'parallelogram':
      return { x: (w - 2 * short * PARALLELOGRAM_SLANT) / w, y: 1 }
    case 'trapezoid':
      return { x: (w - 2 * short * TRAPEZOID_INSET) / w, y: 1 }
    case 'polygon':
      return { x: Math.cos(Math.PI / 6), y: Math.cos(Math.PI / 6) }
    case 'cylinder':
      return { x: 0.9, y: Math.max((h - 0.4 * h) / h, 0.3) }
    default:
      return { x: 1, y: 1 }
  }
}

type Line = { chars: number; em: number; indent: number; gapAfter: boolean }

/** The label as lines the way `textToRich` will build it: headings, bullets, paragraphs. */
function readLines(label: string): Line[] {
  const raw = label.replace(/\r\n?/g, '\n').replace(/\n+$/, '').split('\n')
  return raw.map((text, index) => {
    const next = raw[index + 1]
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(text)
    const heading = /^(#{1,3})\s+(.*)$/.exec(text)
    // Marks cost no width, so they are not counted as characters.
    const plain = (value: string): number =>
      value.replace(/\*\*|__|~~|`/g, '').replace(/(^|\s)[*_]|[*_](\s|$)/g, '$1$2').length
    if (bullet !== null) {
      const listContinues = next !== undefined && /^\s*[-*+]\s+/.test(next)
      return { chars: plain(bullet[1]), em: 1, indent: BULLET_EM, gapAfter: !listContinues }
    }
    if (heading !== null) {
      return {
        chars: plain(heading[2]),
        em: HEADING_EM[heading[1].length],
        indent: 0,
        gapAfter: true,
      }
    }
    return { chars: plain(text), em: 1, indent: 0, gapAfter: next !== undefined }
  })
}

/** Rendered lines once each is wrapped at `width`, and the widest one. */
function wrap(
  lines: readonly Line[],
  fontSize: number,
  width: number,
): { rows: number[]; widest: number } {
  const rows: number[] = []
  let widest = 0
  for (const line of lines) {
    const glyph = fontSize * line.em * GLYPH_EM
    const indent = fontSize * line.indent
    const room = Math.max(1, Math.floor((width - indent) / glyph))
    const count = Math.max(1, Math.ceil(line.chars / room))
    for (let row = 0; row < count; row += 1) rows.push(line.em)
    widest = Math.max(widest, indent + Math.min(line.chars, room) * glyph)
  }
  return { rows, widest }
}

function textHeight(lines: readonly Line[], rows: readonly number[], fontSize: number): number {
  const props = resolveTextProps(
    objectData.parse({ id: 'x', type: 'rect', x: 0, y: 0, w: 1, h: 1 }),
  )
  const lineBox = rows.reduce((sum, em) => sum + em * fontSize * props.lineHeight, 0)
  const gaps = lines.filter((line) => line.gapAfter).length
  return lineBox + gaps * fontSize * props.paragraphSpacing
}

/**
 * The box a node needs: at least its type's minimum, grown to fit the label. A requested
 * width or height is kept as asked; only the side left out is fitted.
 */
export function fitNodeSize(
  type: SpecNodeType,
  label: string | undefined,
  options: { w?: number; h?: number; fontSize?: number } = {},
): Size {
  const min = MIN_SIZES[type]
  if (options.w !== undefined && options.h !== undefined) return { w: options.w, h: options.h }
  const text = label ?? ''
  if (text.trim() === '' || type === 'text' || type === 'sticky') {
    return { w: options.w ?? min.w, h: options.h ?? min.h }
  }

  const probe = objectData.parse({ id: 'x', type: type as ObjectType, x: 0, y: 0, w: 1, h: 1 })
  const props = resolveTextProps(probe)
  const fontSize = options.fontSize ?? props.fontSize
  const pad = props.padding * 2
  const lines = readLines(text)

  // Width first: as wide as the longest line needs, up to the cap, then wrap to that.
  const fitW = (w: number): number => {
    const ratio = inscribed(type, w, min.h).x
    return w * ratio - pad
  }
  let w = options.w ?? min.w
  if (options.w === undefined) {
    const natural = wrap(lines, fontSize, MAX_TEXT_WIDTH).widest
    while (fitW(w) < natural && w < 900) w += 10
  }

  const { rows } = wrap(lines, fontSize, Math.max(fitW(w), fontSize))
  const needed = textHeight(lines, rows, fontSize) + pad
  let h = options.h ?? min.h
  if (options.h === undefined) {
    while (h * inscribed(type, w, h).y < needed && h < 900) h += 10
  }
  // Shapes whose inset depends on both sides may need the width looked at again.
  if (options.w === undefined) {
    const again = wrap(lines, fontSize, MAX_TEXT_WIDTH).widest
    while (w * inscribed(type, w, h).x - pad < again && w < 900) w += 10
  }
  return { w: Math.round(w), h: Math.round(h) }
}

/** An arrow label's plate: the overlay gives it 180 wide and wraps inside that. */
export const EDGE_LABEL_MAX = { w: 180, h: 44 }
const EDGE_FONT = 14

export function edgeLabelSize(label: string | undefined): Size {
  if (label === undefined || label.trim() === '') return { w: 0, h: 0 }
  const lines = label.split('\n')
  const glyph = EDGE_FONT * GLYPH_EM
  const inner = EDGE_LABEL_MAX.w - 6
  let rows = 0
  let widest = 0
  for (const line of lines) {
    const room = Math.floor(inner / glyph)
    rows += Math.max(1, Math.ceil(line.length / room))
    widest = Math.max(widest, Math.min(line.length, room) * glyph)
  }
  return { w: Math.round(widest + 10), h: Math.round(rows * EDGE_FONT * 1.45 + 6) }
}
