/**
 * A picture of a glade, drawn from its document.
 *
 * An assistant that has only nodes and edges cannot tell that two boxes overlap or that
 * a label covers a line; a person glancing at the canvas can. This gives it the glance:
 * the same objects the canvas draws, drawn as SVG from the interchange file and turned
 * into a PNG by resvg (WebAssembly, no browser, no native addon).
 *
 * Faithful to geometry, not to pixels. Positions, shapes, arrow routes, heads and label
 * placement come from the same schema functions the canvas uses; colours come from the
 * canvas's own theme defaults. Glyph shaping is resvg's rather than the browser's and
 * rich text is reduced to headings, bullets and bold lines, so wrapping can differ by a
 * word. That is the right trade for checking a diagram.
 *
 * Security, since this is a new way to get content out:
 * - It reads only what the caller already read. The file comes from the room the MCP
 *   server joined through the ws-token handshake, so a snapshot is exactly as visible as
 *   `export_glade`, and nothing here talks to the network.
 * - The SVG is built from escaped text and finite numbers only. It has no `href`, no
 *   `url()`, no `<image>`, no `<foreignObject>` and no styles, so a label cannot turn
 *   into markup and the rasterizer is never asked to fetch anything. resvg is also given
 *   no system fonts.
 * - Bounded: a pixel ceiling, a cap on drawn objects, and a cap on characters per label,
 *   so one call cannot be used to make the server allocate without limit.
 * - The PNG is returned inline and never stored, cached or given a URL.
 * - Presence is not in the document, so nobody's cursor, name or selection is in it.
 */

import { readFile } from 'node:fs/promises'

import {
  type GladeFile,
  type GladeObject,
  type GladeRichNode,
  type ObjectData,
  absoluteInk,
  cylinderCap,
  isArrowLike,
  objectBounds,
  parallelogramSlant,
  pointAlongPath,
  polygonSidesOf,
  resolveArrowProps,
  resolveFreedrawProps,
  resolveTextProps,
  strokeOutline,
  trapezoidInset,
} from '@meadow/schema'
import { Resvg, initWasm } from '@resvg/resvg-wasm'

import type { SpecNodeType } from './mermaid'
import { drawnPoints } from './plan'
import { type Rect, rectsOverlap } from './route'
import { MIN_SIZES, edgeLabelSize, inscribed } from './sizing'

/** The widest and tallest a snapshot is ever rendered, whatever is asked for. */
export const MAX_SNAPSHOT_WIDTH = 4096
export const MAX_SNAPSHOT_HEIGHT = 4096
export const DEFAULT_SNAPSHOT_WIDTH = 1600
/** Objects drawn per snapshot before the rest are counted and left out. */
export const MAX_SNAPSHOT_OBJECTS = 5000
/** A label longer than this is cut. Nothing on a canvas needs more to be recognised. */
const MAX_LABEL_CHARS = 2000
/** Never zoom a small diagram past this, or two boxes become a blurry poster. */
const MAX_SCALE = 2
const PADDING = 40
/**
 * Text drawn smaller than this many pixels is left out. It cannot be read at that size,
 * and shaping it is most of the cost of rendering a large glade.
 */
const MIN_TEXT_PIXELS = 4

export type Theme = 'light' | 'dark'

export type SnapshotOptions = {
  region?: Rect
  ids?: readonly string[]
  maxWidth?: number
  maxObjects?: number
  theme?: Theme
}

export type Snapshot = {
  svg: string
  /** Pixel size the PNG will have. */
  width: number
  height: number
  /** Pixels per world unit. */
  scale: number
  /** The world rectangle shown. */
  bounds: Rect
  drawn: number
  skipped: number
  /** Ids of the objects drawn, so the graph returned beside the picture can match it. */
  ids: string[]
}

type Palette = {
  background: number
  ink: number
  shape: { fill: number; stroke: number }
  sticky: { fill: number; stroke: number }
  connector: number
}

// Mirrors `apps/web/src/canvas/style.ts` and the `--canvas-bg` / `--canvas-ink` tokens in
// `styles.css`. That module imports the WebGL renderer, so it cannot be imported here.
const THEMES: Record<Theme, Palette> = {
  light: {
    background: 0xfbf9f5,
    ink: 0x2a3340,
    shape: { fill: 0xffffff, stroke: 0x4e555f },
    sticky: { fill: 0xa8daff, stroke: 0x7cb4dd },
    connector: 0x76808c,
  },
  dark: {
    background: 0x12161b,
    ink: 0xc3cedd,
    shape: { fill: 0x262e3a, stroke: 0xb3bdcb },
    sticky: { fill: 0x1f4d73, stroke: 0x3d769f },
    connector: 0x8d97a5,
  },
}

const FAMILIES: Record<string, string> = {
  comic: 'Comic Neue',
  inter: 'Inter',
  mono: 'JetBrains Mono',
}

// --- safe output ----------------------------------------------------------------------

/** A number as SVG will read it. Anything not finite becomes 0 rather than `NaN` in markup. */
const n = (value: number): string =>
  Number.isFinite(value) ? String(Math.round(value * 100) / 100) : '0'

const hex = (value: unknown, fallback: number): string => {
  const colour = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return `#${(colour & 0xffffff).toString(16).padStart(6, '0')}`
}

const alpha = (value: unknown, fallback = 1): string => {
  const a = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return n(Math.min(1, Math.max(0, a)))
}

/** Text content escaped for SVG. Control characters other than tab and newline are dropped. */
export function escapeText(value: string): string {
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

const num = (props: Record<string, unknown>, key: string, fallback: number): number => {
  const value = props[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

const opacityOf = (object: ObjectData): number =>
  Number.isFinite(object.opacity) ? object.opacity : 1

// --- text ------------------------------------------------------------------------------

type Line = { text: string; bold: boolean; em: number }

/** Rich text as lines: a heading is bold and larger, a list item gets a bullet. */
function linesOf(nodes: readonly GladeRichNode[] | null): Line[] {
  if (nodes === null) return []
  const lines: Line[] = []
  let budget = MAX_LABEL_CHARS

  const runsOf = (list: readonly GladeRichNode[]): { text: string; bold: boolean } => {
    let text = ''
    let bold = true
    let seen = false
    const walk = (items: readonly GladeRichNode[]): void => {
      for (const item of items) {
        if ('text' in item) {
          for (const run of item.text) {
            text += run.insert
            seen = true
            if (run.attributes?.bold === undefined) bold = false
          }
        } else if (item.name === 'hardBreak') {
          text += '\n'
        } else {
          walk(item.children)
        }
      }
    }
    walk(list)
    return { text, bold: seen && bold }
  }

  const push = (text: string, bold: boolean, em: number): void => {
    for (const part of text.split('\n')) {
      if (budget <= 0) return
      const cut = part.slice(0, budget)
      budget -= cut.length
      lines.push({ text: cut, bold, em })
    }
  }

  const walk = (list: readonly GladeRichNode[], bullet: boolean): void => {
    for (const node of list) {
      if ('text' in node) {
        push(node.text.map((run) => run.insert).join(''), false, 1)
        continue
      }
      switch (node.name) {
        case 'heading': {
          const level = node.attributes?.level ?? '1'
          push(runsOf(node.children).text, true, level === '1' ? 1.6 : level === '2' ? 1.35 : 1.15)
          break
        }
        case 'bulletList':
        case 'orderedList':
          walk(node.children, true)
          break
        case 'listItem': {
          const { text, bold } = runsOf(node.children)
          push(`${bullet ? '• ' : ''}${text}`, bold, 1)
          break
        }
        case 'paragraph':
        case 'blockquote':
        case 'codeBlock': {
          const { text, bold } = runsOf(node.children)
          push(text, bold, 1)
          break
        }
        default:
          walk(node.children, bullet)
      }
    }
  }
  walk(nodes, false)
  while (lines.length > 0 && lines[lines.length - 1].text.trim() === '') lines.pop()
  return lines
}

/** Average glyph advance in ems, for wrapping. Under sizing's, which errs large on purpose. */
const GLYPH_EM = 0.5

function wrapLines(lines: readonly Line[], fontSize: number, width: number): Line[] {
  const out: Line[] = []
  for (const line of lines) {
    const room = Math.max(1, Math.floor(width / (fontSize * line.em * GLYPH_EM)))
    let current = ''
    for (const word of line.text.split(/(\s+)/)) {
      if ((current + word).length > room && current.trim() !== '') {
        out.push({ ...line, text: current.trimEnd() })
        current = word.trimStart()
      } else {
        current += word
      }
      // A single word longer than the line is broken where it runs out of room.
      while (current.length > room) {
        out.push({ ...line, text: current.slice(0, room) })
        current = current.slice(room)
      }
    }
    out.push({ ...line, text: current.trimEnd() })
  }
  return out
}

type TextStyle = {
  fontSize: number
  lineHeight: number
  align: string
  verticalAlign: string
  color: string
  family: string
}

function textBlock(lines: readonly Line[], box: Rect, style: TextStyle): string {
  if (lines.length === 0 || box.w <= 0 || box.h <= 0) return ''
  const wrapped = wrapLines(lines, style.fontSize, box.w)
  const heights = wrapped.map((line) => line.em * style.fontSize * style.lineHeight)
  const total = heights.reduce((sum, h) => sum + h, 0)
  let y =
    style.verticalAlign === 'middle'
      ? box.y + (box.h - total) / 2
      : style.verticalAlign === 'bottom'
        ? box.y + box.h - total
        : box.y
  const anchor = style.align === 'center' ? 'middle' : style.align === 'right' ? 'end' : 'start'
  const x =
    style.align === 'center' ? box.x + box.w / 2 : style.align === 'right' ? box.x + box.w : box.x

  let out = ''
  wrapped.forEach((line, index) => {
    const size = line.em * style.fontSize
    // The baseline sits a little below the middle of the line box, as the overlay's does.
    const baseline = y + heights[index] / 2 + size * 0.35
    y += heights[index]
    if (line.text === '') return
    out +=
      `<text x="${n(x)}" y="${n(baseline)}" font-family="${style.family}" font-size="${n(size)}"` +
      ` font-weight="${line.bold ? 700 : 400}" fill="${style.color}" text-anchor="${anchor}">` +
      `${escapeText(line.text)}</text>`
  })
  return out
}

// --- shapes ----------------------------------------------------------------------------

function outline(object: ObjectData, box: Rect, radius: number): string {
  const { x, y, w, h } = box
  const pts = (list: number[]): string => list.map(n).join(' ')
  switch (object.type) {
    case 'ellipse':
      return `<ellipse cx="${n(x + w / 2)}" cy="${n(y + h / 2)}" rx="${n(w / 2)}" ry="${n(h / 2)}"/>`
    case 'diamond':
      return `<polygon points="${pts([x + w / 2, y, x + w, y + h / 2, x + w / 2, y + h, x, y + h / 2])}"/>`
    case 'triangle':
      return `<polygon points="${pts([x + w / 2, y, x + w, y + h, x, y + h])}"/>`
    case 'parallelogram': {
      const s = parallelogramSlant(w, h)
      return `<polygon points="${pts([x + s, y, x + w, y, x + w - s, y + h, x, y + h])}"/>`
    }
    case 'trapezoid': {
      const i = trapezoidInset(w, h)
      return `<polygon points="${pts([x + i, y, x + w - i, y, x + w, y + h, x, y + h])}"/>`
    }
    case 'polygon': {
      const sides = polygonSidesOf(object.props)
      const list: number[] = []
      for (let k = 0; k < sides; k += 1) {
        const angle = -Math.PI / 2 + (k * Math.PI * 2) / sides
        list.push(x + w / 2 + (Math.cos(angle) * w) / 2, y + h / 2 + (Math.sin(angle) * h) / 2)
      }
      return `<polygon points="${pts(list)}"/>`
    }
    case 'cylinder': {
      const cap = cylinderCap(h)
      const rx = w / 2
      return (
        `<path d="M${n(x)} ${n(y + cap)} L${n(x)} ${n(y + h - cap)}` +
        ` A${n(rx)} ${n(cap)} 0 0 0 ${n(x + w)} ${n(y + h - cap)} L${n(x + w)} ${n(y + cap)}` +
        ` A${n(rx)} ${n(cap)} 0 0 0 ${n(x)} ${n(y + cap)} Z"/>` +
        `<ellipse cx="${n(x + rx)}" cy="${n(y + cap)}" rx="${n(rx)}" ry="${n(cap)}"/>`
      )
    }
    default:
      return (
        `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"` +
        ` rx="${n(Math.min(radius, w / 2, h / 2))}"/>`
      )
  }
}

function normalBox(object: ObjectData): Rect {
  return {
    x: Math.min(object.x, object.x + object.w),
    y: Math.min(object.y, object.y + object.h),
    w: Math.abs(object.w),
    h: Math.abs(object.h),
  }
}

/** Types this renderer does not draw. Each gets a labelled placeholder instead of nothing. */
const UNDRAWN = new Set(['image', 'table', 'chart', 'embed'])

function drawShape(object: GladeObject, theme: Palette, scale: number): string {
  const box = normalBox(object)
  const props = object.props
  const surface = object.type === 'sticky' ? theme.sticky : theme.shape
  const radius = num(props, 'cornerRadius', object.type === 'sticky' ? 2 : 4)
  const rotate =
    object.rotation === 0 || !Number.isFinite(object.rotation)
      ? ''
      : ` transform="rotate(${n((object.rotation * 180) / Math.PI)} ${n(box.x + box.w / 2)} ${n(box.y + box.h / 2)})"`

  let out = `<g${rotate} opacity="${alpha(opacityOf(object))}">`
  if (UNDRAWN.has(object.type)) {
    out +=
      `<rect x="${n(box.x)}" y="${n(box.y)}" width="${n(box.w)}" height="${n(box.h)}" fill="none"` +
      ` stroke="${hex(undefined, surface.stroke)}" stroke-dasharray="6 4" stroke-width="1.5"/>`
    out += textBlock([{ text: object.type, bold: false, em: 1 }], box, {
      fontSize: 14,
      lineHeight: 1.45,
      align: 'center',
      verticalAlign: 'middle',
      color: hex(undefined, theme.ink),
      family: 'Inter',
    })
    return `${out}</g>`
  }

  // A plain text object has no box of its own, as on the canvas.
  if (object.type !== 'text') {
    out +=
      `<g fill="${hex(props.fill, surface.fill)}" fill-opacity="${alpha(props.fillAlpha)}"` +
      ` stroke="${hex(props.stroke, surface.stroke)}" stroke-opacity="${alpha(props.strokeAlpha)}"` +
      ` stroke-width="${n(num(props, 'strokeWidth', 2))}">${outline(object, box, radius)}</g>`
  }

  const text = resolveTextProps(object)
  const lines = text.fontSize * scale < MIN_TEXT_PIXELS ? [] : linesOf(object.text)
  if (lines.length > 0) {
    const ratio =
      object.type in MIN_SIZES
        ? inscribed(object.type as SpecNodeType, box.w, box.h)
        : { x: 1, y: 1 }
    const inner = { w: box.w * ratio.x, h: box.h * ratio.y }
    const area: Rect = {
      x: box.x + (box.w - inner.w) / 2 + text.padding,
      y: box.y + (box.h - inner.h) / 2 + text.padding,
      w: inner.w - text.padding * 2,
      h: inner.h - text.padding * 2,
    }
    out += textBlock(lines, area, {
      fontSize: text.fontSize,
      lineHeight: text.lineHeight,
      align: text.align,
      verticalAlign: text.verticalAlign,
      color: hex(props.color, theme.ink),
      family: FAMILIES[text.fontFamily] ?? 'Comic Neue',
    })
  }
  return `${out}</g>`
}

type Head = { tip: [number, number]; from: [number, number]; kind: string; size: number }

function drawHead({ tip, from, kind, size }: Head, colour: string, width: number): string {
  if (kind === 'none') return ''
  const length = Math.hypot(tip[0] - from[0], tip[1] - from[1])
  if (length < 1e-6) return ''
  const ux = (tip[0] - from[0]) / length
  const uy = (tip[1] - from[1]) / length
  const half = size * 0.55
  const bx = tip[0] - ux * size
  const by = tip[1] - uy * size
  const points = [bx - uy * half, by + ux * half, tip[0], tip[1], bx + uy * half, by - ux * half]
  if (kind === 'triangle') {
    return `<polygon points="${points.map(n).join(' ')}" fill="${colour}" stroke="none"/>`
  }
  return (
    `<polyline points="${points.map(n).join(' ')}" fill="none" stroke="${colour}"` +
    ` stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"/>`
  )
}

function drawArrow(object: GladeObject, theme: Palette, scale: number): string {
  const props = resolveArrowProps(object)
  const points = drawnPoints(object)
  if (points.length < 4) return ''
  const colour = hex(object.props.stroke, theme.connector)
  const width = props.strokeWidth
  const last = points.length - 2
  let out =
    `<g opacity="${alpha(props.strokeAlpha * opacityOf(object))}">` +
    `<polyline points="${points.map(n).join(' ')}" fill="none" stroke="${colour}"` +
    ` stroke-width="${n(width)}" stroke-linecap="round" stroke-linejoin="round"/>`
  out += drawHead(
    {
      tip: [points[last], points[last + 1]],
      from: [points[last - 2], points[last - 1]],
      kind: props.endHead,
      size: props.headSize,
    },
    colour,
    width,
  )
  out += drawHead(
    {
      tip: [points[0], points[1]],
      from: [points[2], points[3]],
      kind: props.startHead,
      size: props.headSize,
    },
    colour,
    width,
  )

  const lines = 14 * scale < MIN_TEXT_PIXELS ? [] : linesOf(object.text)
  if (lines.length > 0) {
    const label = edgeLabelSize(lines.map((line) => line.text).join('\n'))
    const middle = pointAlongPath(points, 0.5)
    const plate: Rect = {
      x: middle.x - label.w / 2,
      y: middle.y - label.h / 2,
      w: label.w,
      h: label.h,
    }
    out +=
      `<rect x="${n(plate.x)}" y="${n(plate.y)}" width="${n(plate.w)}" height="${n(plate.h)}"` +
      ` rx="3" fill="${hex(undefined, theme.background)}"/>`
    out += textBlock(
      lines,
      { x: plate.x + 3, y: plate.y + 3, w: plate.w - 6, h: plate.h - 6 },
      {
        fontSize: 14,
        lineHeight: 1.45,
        align: 'center',
        verticalAlign: 'middle',
        color: hex(undefined, theme.ink),
        family: 'Comic Neue',
      },
    )
  }
  return `${out}</g>`
}

function drawInk(object: GladeObject): string {
  const props = resolveFreedrawProps(object)
  const pieces = strokeOutline(absoluteInk(object, props.points), props)
  if (pieces.length === 0) return ''
  let d = ''
  for (const piece of pieces) {
    for (let i = 0; i + 1 < piece.length; i += 2) {
      d += `${i === 0 ? 'M' : 'L'}${n(piece[i])} ${n(piece[i + 1])}`
    }
    d += 'Z'
  }
  return (
    `<path d="${d}" fill="${hex(props.stroke, 0x1f2a24)}"` +
    ` opacity="${alpha(props.strokeAlpha * opacityOf(object))}"/>`
  )
}

// --- the picture -----------------------------------------------------------------------

function boundsOf(object: GladeObject): Rect {
  if (isArrowLike(object.type)) {
    const points = drawnPoints(object)
    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    for (let i = 0; i + 1 < points.length; i += 2) {
      minX = Math.min(minX, points[i])
      maxX = Math.max(maxX, points[i])
      minY = Math.min(minY, points[i + 1])
      maxY = Math.max(maxY, points[i + 1])
    }
    if (!Number.isFinite(minX)) return { x: object.x, y: object.y, w: 1, h: 1 }
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
  }
  const b = objectBounds(object)
  return { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY }
}

function union(a: Rect | null, b: Rect): Rect {
  if (a === null) return b
  const x = Math.min(a.x, b.x)
  const y = Math.min(a.y, b.y)
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y }
}

const pad = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
})

export function renderSnapshot(file: GladeFile, options: SnapshotOptions = {}): Snapshot {
  const theme = THEMES[options.theme ?? 'light']
  const byId = new Map(file.objects.map((object) => [object.id, object]))
  // Bottom to top, as the canvas stacks them.
  const ordered: GladeObject[] = []
  const listed = new Set<string>()
  for (const id of file.order) {
    const object = byId.get(id)
    if (object !== undefined && !listed.has(id)) {
      ordered.push(object)
      listed.add(id)
    }
  }
  for (const object of file.objects) if (!listed.has(object.id)) ordered.push(object)
  const boxes = new Map(ordered.map((object) => [object.id, boundsOf(object)]))

  // What is shown: a region as given, the named objects with room around them, or all.
  let view: Rect | null = null
  if (options.region !== undefined) {
    view = options.region
  } else if (options.ids !== undefined && options.ids.length > 0) {
    for (const id of options.ids) {
      const box = boxes.get(id)
      if (box !== undefined) view = union(view, box)
    }
    view = view === null ? null : pad(view, 60)
  }

  const frame = view
  const inView =
    frame === null
      ? ordered
      : ordered.filter((object) => rectsOverlap(boxes.get(object.id)!, frame))
  const cap = Math.max(
    0,
    Math.min(options.maxObjects ?? MAX_SNAPSHOT_OBJECTS, MAX_SNAPSHOT_OBJECTS),
  )
  const shown = inView.slice(0, cap)

  if (view === null) {
    for (const object of shown) view = union(view, boxes.get(object.id)!)
    view = view === null ? { x: 0, y: 0, w: 400, h: 300 } : pad(view, PADDING)
  }
  const world = { x: view.x, y: view.y, w: Math.max(view.w, 1), h: Math.max(view.h, 1) }

  const wanted = Math.min(
    Math.max(options.maxWidth ?? DEFAULT_SNAPSHOT_WIDTH, 16),
    MAX_SNAPSHOT_WIDTH,
  )
  const scale = Math.min(wanted / world.w, MAX_SNAPSHOT_HEIGHT / world.h, MAX_SCALE)
  const width = Math.min(MAX_SNAPSHOT_WIDTH, Math.max(1, Math.round(world.w * scale)))
  const height = Math.min(MAX_SNAPSHOT_HEIGHT, Math.max(1, Math.round(world.h * scale)))

  let body = ''
  for (const object of shown) {
    if (isArrowLike(object.type)) body += drawArrow(object, theme, scale)
    else if (object.type === 'freedraw') body += drawInk(object)
    else body += drawShape(object, theme, scale)
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"` +
    ` viewBox="${n(world.x)} ${n(world.y)} ${n(world.w)} ${n(world.h)}">` +
    `<rect x="${n(world.x)}" y="${n(world.y)}" width="${n(world.w)}" height="${n(world.h)}"` +
    ` fill="${hex(undefined, theme.background)}"/>${body}</svg>`

  return {
    svg,
    width,
    height,
    scale: Math.round(scale * 1000) / 1000,
    bounds: {
      x: Math.round(world.x),
      y: Math.round(world.y),
      w: Math.round(world.w),
      h: Math.round(world.h),
    },
    drawn: shown.length,
    skipped: inView.length - shown.length,
    ids: shown.map((object) => object.id),
  }
}

// --- rasterizing -----------------------------------------------------------------------

const FONT_FILES = ['comic-neue-400.ttf', 'comic-neue-700.ttf', 'inter.ttf', 'jetbrains-mono.ttf']

let ready: Promise<Uint8Array[]> | null = null

/** Beside the bundle in `dist/assets`, or the package's own `assets/` when run from source. */
async function loadAssets(): Promise<Uint8Array[]> {
  const candidates = [new URL('./assets/', import.meta.url), new URL('../assets/', import.meta.url)]
  for (const base of candidates) {
    let wasm: Buffer
    try {
      wasm = await readFile(new URL('resvg.wasm', base))
    } catch {
      continue
    }
    const fonts = await Promise.all(
      FONT_FILES.map(
        async (name) => new Uint8Array(await readFile(new URL(`fonts/${name}`, base))),
      ),
    )
    await initWasm(wasm)
    return fonts
  }
  throw new Error('snapshot assets are missing: run `node assets.mjs` in packages/mcp, or rebuild')
}

/** Snapshots render one at a time: rasterizing is synchronous, and a queue bounds memory. */
let queue: Promise<unknown> = Promise.resolve()

export async function rasterize(snapshot: Snapshot): Promise<Uint8Array> {
  ready ??= loadAssets().catch((error: unknown) => {
    ready = null
    throw error
  })
  const fonts = await ready
  const run = queue.then(() => {
    const resvg = new Resvg(snapshot.svg, {
      fitTo: { mode: 'width', value: snapshot.width },
      font: { fontBuffers: fonts, loadSystemFonts: false, defaultFontFamily: 'Comic Neue' },
    })
    try {
      return resvg.render().asPng()
    } finally {
      resvg.free()
    }
  })
  queue = run.catch(() => undefined)
  return run
}
