/**
 * The overlay's text as SVG `<text>`, placed where the browser laid it out.
 *
 * Text on the canvas is DOM, so the only layout that is right is the browser's. This
 * does not lay anything out itself. It reads a laid-out overlay element back, one line
 * of glyphs at a time, and writes each line as a `<text>` at the position the browser
 * gave its first glyph and with the width the browser gave the whole line. The file's
 * line breaks are the canvas's line breaks because they were measured off it.
 *
 * Real text, not outlines and not `<foreignObject>`. Text stays selectable and
 * searchable in the file, it is as sharp at any zoom as the shapes are, and it opens
 * in viewers that would show a `<foreignObject>` as nothing at all. The faces it uses
 * are embedded (`embedFonts`), so the file draws in the same type wherever it is opened.
 *
 * `textLength` pins each line to the width it measured. Where the viewer has the
 * embedded face that changes nothing, and where it has not, the line is fitted to its
 * box rather than running out over the edge of the shape it belongs to.
 *
 * What the editor can write is a short list (`MARK_TAGS` and `BLOCK_TAGS` in
 * document-core): paragraphs, three heading levels, lists, a quote, preformatted text,
 * and bold, italic, underline, strike and code. All of them are carried by computed
 * style, except a list's marker, which is a pseudo-element with no text node and is
 * written here from the list's own style type.
 */

import { type Bounds, escapeXml, extend, num } from './sceneSvg'

/** Everything a line of text needs from its element's computed style. */
type RunStyle = {
  family: string
  size: number
  weight: string
  style: string
  colour: string
  font: string
}

/** Characters each font family was asked to draw, for picking the faces to embed. */
export type FontUse = Map<string, Set<number>>

const segmenter =
  typeof Intl !== 'undefined' && 'Segmenter' in Intl
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null

/**
 * Graphemes with their offsets. A line is never split inside one: an Indic conjunct
 * cut in half shapes as two broken glyphs.
 */
function graphemes(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = []
  if (segmenter !== null) {
    for (const part of segmenter.segment(text)) {
      out.push({ start: part.index, end: part.index + part.segment.length, text: part.segment })
    }
    return out
  }
  let index = 0
  for (const ch of text) {
    out.push({ start: index, end: index + ch.length, text: ch })
    index += ch.length
  }
  return out
}

/** The family names in a CSS font-family list, unquoted and lowercased. */
export function familiesOf(stack: string): string[] {
  return stack
    .split(',')
    .map((part) => part.trim().replace(/^["']|["']$/g, '').toLowerCase())
    .filter((part) => part !== '')
}

let metricsContext: CanvasRenderingContext2D | null = null
const ascents = new Map<string, number>()

/**
 * Distance from the top of a glyph's box to its baseline, for a font.
 *
 * A range's client rect is the glyph's inline box, which is the font's ascent above
 * the baseline and its descent below. Canvas reports the same two metrics for the
 * same font string, so the baseline is the rect's top plus this.
 */
function ascentOf(style: RunStyle): number {
  const cached = ascents.get(style.font)
  if (cached !== undefined) return cached
  metricsContext ??= document.createElement('canvas').getContext('2d')
  let ascent = style.size * 0.8
  if (metricsContext !== null) {
    metricsContext.font = style.font
    const metrics = metricsContext.measureText('Hg')
    if (Number.isFinite(metrics.fontBoundingBoxAscent)) ascent = metrics.fontBoundingBoxAscent
  }
  ascents.set(style.font, ascent)
  return ascent
}

function runStyle(element: Element): RunStyle {
  const computed = getComputedStyle(element)
  const size = Number.parseFloat(computed.fontSize) || 16
  return {
    family: computed.fontFamily,
    size,
    weight: computed.fontWeight,
    style: computed.fontStyle,
    colour: computed.color,
    font: `${computed.fontStyle} ${computed.fontWeight} ${size}px ${computed.fontFamily}`,
  }
}

/** A colour from computed style that would paint nothing. */
function invisible(colour: string): boolean {
  return colour === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\s*\)$/.test(colour)
}

type Walk = {
  origin: { x: number; y: number }
  out: string[]
  fonts: FontUse
  bounds: Bounds
}

type Rect = { left: number; top: number; right: number; bottom: number }

/**
 * One text node, as one `<text>` per line it occupies.
 *
 * Each grapheme is measured with a range and the run is cut wherever the next one
 * starts a new line. Measuring per grapheme is the cost of honesty: the browser does
 * not report where it wrapped, only where it put things.
 */
function writeTextNode(
  node: Text,
  opacity: number,
  decoration: string,
  clip: Rect | null,
  walk: Walk,
): void {
  const content = node.data
  if (content === '' || node.parentElement === null) return
  const style = runStyle(node.parentElement)
  if (invisible(style.colour)) return

  const range = document.createRange()
  type Line = { text: string; left: number; right: number; top: number; inkRight: number }
  const lines: Line[] = []
  let line: Line | null = null

  for (const part of graphemes(content)) {
    if (part.text === '\n' || part.text === '\r\n') {
      line = null
      continue
    }
    range.setStart(node, part.start)
    range.setEnd(node, part.end)
    const rects = range.getClientRects()
    if (rects.length === 0) continue
    const rect = rects[0]
    if (rect.width === 0 && rect.height === 0) continue
    if (
      clip !== null &&
      (rect.left < clip.left - 0.5 || rect.right > clip.right + 0.5 || rect.top < clip.top - 0.5)
    ) {
      continue
    }

    // A new line is a new top, or a jump backwards along the same one.
    if (line === null || Math.abs(rect.top - line.top) > 0.5 || rect.left < line.right - 1) {
      line = { text: '', left: rect.left, right: rect.right, top: rect.top, inkRight: rect.left }
      lines.push(line)
    }
    line.text += part.text
    line.right = rect.right
    if (part.text.trim() !== '') line.inkRight = rect.right
  }
  range.detach()

  const used = walk.fonts
  for (const family of familiesOf(style.family)) {
    let set = used.get(family)
    if (set === undefined) {
      set = new Set()
      used.set(family, set)
    }
    for (const ch of content) set.add(ch.codePointAt(0) ?? 0)
  }

  const ascent = ascentOf(style)
  const { x: ox, y: oy } = walk.origin
  for (const piece of lines) {
    // Trailing spaces hang past the line in the browser and are not drawn; leading
    // ones are an indent somebody typed and are kept.
    const text = piece.text.replace(/\s+$/u, '')
    if (text === '') continue
    const x = piece.left - ox
    const top = piece.top - oy
    const width = piece.inkRight - piece.left
    extend(walk.bounds, x, top)
    extend(walk.bounds, x + width, top + style.size * 1.3)
    walk.out.push(
      `<text x="${num(x)}" y="${num(top + ascent)}"` +
        (width > 0 ? ` textLength="${num(width)}" lengthAdjust="spacing"` : '') +
        ` font-family="${escapeXml(style.family)}" font-size="${num(style.size)}"` +
        (style.weight !== '400' ? ` font-weight="${escapeXml(style.weight)}"` : '') +
        (style.style !== 'normal' ? ` font-style="${escapeXml(style.style)}"` : '') +
        ` fill="${escapeXml(style.colour)}"` +
        (decoration !== '' ? ` text-decoration="${escapeXml(decoration)}"` : '') +
        (opacity < 1 ? ` opacity="${num(opacity)}"` : '') +
        ` xml:space="preserve">${escapeXml(text)}</text>`,
    )
  }
}

const SYMBOL_MARKERS: Record<string, 'disc' | 'circle' | 'square'> = {
  disc: 'disc',
  circle: 'circle',
  square: 'square',
}

/**
 * The marker text `list-style-type` would draw for item `index` (1-based). The symbol
 * markers are not text and are drawn as shapes; see `SYMBOL_MARKERS`.
 */
function markerText(type: string, index: number): string | null {
  switch (type) {
    case 'none':
      return null
    case 'lower-alpha':
    case 'lower-latin':
      return `${String.fromCharCode(96 + (((index - 1) % 26) + 1))}. `
    case 'upper-alpha':
    case 'upper-latin':
      return `${String.fromCharCode(64 + (((index - 1) % 26) + 1))}. `
    default:
      return `${index}. `
  }
}

/** The first glyph inside an element, for the line its list marker sits on. */
function firstGlyph(element: Element): DOMRect | null {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const range = document.createRange()
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node as Text
    if (text.data.trim() === '') continue
    range.selectNodeContents(text)
    const rect = range.getClientRects()[0]
    if (rect !== undefined) return rect
  }
  return null
}

/**
 * A list item's marker. The browser draws it outside the item, ending at the item's
 * start edge, on the baseline of the item's first line. So does this.
 */
function writeMarker(item: HTMLElement, opacity: number, walk: Walk): void {
  const computed = getComputedStyle(item)
  if (computed.listStylePosition !== 'outside') return
  const list = item.parentElement
  let index = 1
  if (list !== null && list.tagName === 'OL') {
    const start = Number.parseInt(list.getAttribute('start') ?? '1', 10)
    index = Number.isFinite(start) ? start : 1
  }
  for (let sibling = item.previousElementSibling; sibling !== null; ) {
    if (sibling.tagName === 'LI') index += 1
    sibling = sibling.previousElementSibling
  }
  const style = runStyle(item)
  const box = item.getBoundingClientRect()
  const glyph = firstGlyph(item)
  const top = glyph?.top ?? box.top
  const { x: ox, y: oy } = walk.origin

  // The three symbol markers are drawn by the browser as shapes, not as a glyph from
  // the face: a third of an em across, centred on the middle of the x-height and about
  // three quarters of an em before the item. Comic Neue's own bullet is a speck by
  // comparison, so writing the character would not be the marker the canvas shows.
  const shape = SYMBOL_MARKERS[computed.listStyleType]
  if (shape !== undefined) {
    const r = style.size * 0.17
    const cx = box.left - ox - style.size * 0.78
    const cy = top - oy + ascentOf(style) - style.size * 0.3
    const fade = opacity < 1 ? ` opacity="${num(opacity)}"` : ''
    const colour = escapeXml(style.colour)
    walk.out.push(
      shape === 'square'
        ? `<rect x="${num(cx - r)}" y="${num(cy - r)}" width="${num(r * 2)}" height="${num(r * 2)}" fill="${colour}"${fade}/>`
        : shape === 'circle'
          ? `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r * 0.85)}" fill="none" stroke="${colour}" stroke-width="${num(r * 0.3)}"${fade}/>`
          : `<circle cx="${num(cx)}" cy="${num(cy)}" r="${num(r)}" fill="${colour}"${fade}/>`,
    )
    return
  }

  const text = markerText(computed.listStyleType, index)
  if (text === null) return
  for (const ch of text) {
    for (const family of familiesOf(style.family)) {
      let set = walk.fonts.get(family)
      if (set === undefined) {
        set = new Set()
        walk.fonts.set(family, set)
      }
      set.add(ch.codePointAt(0) ?? 0)
    }
  }
  walk.out.push(
    `<text x="${num(box.left - ox)}" y="${num(top - oy + ascentOf(style))}" text-anchor="end"` +
      ` font-family="${escapeXml(style.family)}" font-size="${num(style.size)}"` +
      (style.weight !== '400' ? ` font-weight="${escapeXml(style.weight)}"` : '') +
      ` fill="${escapeXml(style.colour)}"` +
      (opacity < 1 ? ` opacity="${num(opacity)}"` : '') +
      ` xml:space="preserve">${escapeXml(text)}</text>`,
  )
}

/**
 * An element's painted box: a background and the four borders. The editor's own
 * styles only use the left border, on a quote, but reading all four costs nothing
 * and keeps a future style from silently missing from the file.
 */
function writeBox(element: HTMLElement, opacity: number, walk: Walk): void {
  const computed = getComputedStyle(element)
  const { x: ox, y: oy } = walk.origin
  const paint = (rect: Rect, fill: string): void => {
    walk.out.push(
      `<rect x="${num(rect.left - ox)}" y="${num(rect.top - oy)}"` +
        ` width="${num(rect.right - rect.left)}" height="${num(rect.bottom - rect.top)}"` +
        ` fill="${escapeXml(fill)}"${opacity < 1 ? ` opacity="${num(opacity)}"` : ''}/>`,
    )
  }

  if (!invisible(computed.backgroundColor)) {
    for (const rect of Array.from(element.getClientRects())) paint(rect, computed.backgroundColor)
  }

  const box = element.getBoundingClientRect()
  const sides = [
    ['Left', (w: number) => ({ ...rectOf(box), right: box.left + w })],
    ['Right', (w: number) => ({ ...rectOf(box), left: box.right - w })],
    ['Top', (w: number) => ({ ...rectOf(box), bottom: box.top + w })],
    ['Bottom', (w: number) => ({ ...rectOf(box), top: box.bottom - w })],
  ] as const
  for (const [side, area] of sides) {
    const width = Number.parseFloat(computed.getPropertyValue(`border-${side.toLowerCase()}-width`))
    const kind = computed.getPropertyValue(`border-${side.toLowerCase()}-style`)
    const colour = computed.getPropertyValue(`border-${side.toLowerCase()}-color`)
    if (!(width > 0) || kind === 'none' || kind === 'hidden' || invisible(colour)) continue
    paint(area(width), colour)
  }
}

const rectOf = (rect: DOMRect): Rect => ({
  left: rect.left,
  top: rect.top,
  right: rect.right,
  bottom: rect.bottom,
})

/**
 * Decorations are not inherited in CSS, they propagate: the `<strong>` inside a `<u>`
 * computes to no underline and is drawn underlined anyway. So the walk carries what
 * every ancestor has asked for down to the text.
 */
function addDecoration(inherited: string, own: string): string {
  if (own === 'none' || own === '') return inherited
  const all = new Set([...inherited.split(' '), ...own.split(' ')].filter((part) => part !== ''))
  return Array.from(all).join(' ')
}

function walkElement(
  element: HTMLElement,
  opacity: number,
  decoration: string,
  clip: Rect | null,
  walk: Walk,
): void {
  const computed = getComputedStyle(element)
  if (computed.display === 'none' || computed.visibility === 'collapse') return
  const own = opacity * (Number.parseFloat(computed.opacity) || 0)
  if (own <= 0) return
  const lines = addDecoration(decoration, computed.textDecorationLine)

  const clips = computed.overflowX !== 'visible' || computed.overflowY !== 'visible'
  const nextClip = clips ? rectOf(element.getBoundingClientRect()) : clip

  writeBox(element, own, walk)
  if (element.tagName === 'LI') writeMarker(element, own, walk)

  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) writeTextNode(child as Text, own, lines, nextClip, walk)
    else if (child instanceof HTMLElement) walkElement(child, own, lines, nextClip, walk)
  }
}

/**
 * One overlay box, as SVG.
 *
 * `origin` is the client position of world (0, 0), so a client rect minus it is a
 * world coordinate. A rotated box is measured unrotated, then wrapped in the same
 * rotation about the same centre the overlay gives it; measuring it rotated would
 * report the bounding boxes of tilted glyphs, which are not where the glyphs are.
 */
export function boxSvg(
  element: HTMLElement,
  rotation: number,
  origin: { x: number; y: number },
  fonts: FontUse,
  bounds: Bounds,
): string {
  const transform = element.style.transform
  if (rotation !== 0) element.style.transform = ''
  const out: string[] = []
  const local: Bounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  try {
    walkElement(element, 1, '', null, { origin, out, fonts, bounds: local })
  } finally {
    if (rotation !== 0) element.style.transform = transform
  }
  if (out.length === 0) return ''

  if (rotation === 0) {
    if (Number.isFinite(local.minX)) {
      extend(bounds, local.minX, local.minY)
      extend(bounds, local.maxX, local.maxY)
    }
    return out.join('')
  }

  const box = element.getBoundingClientRect()
  // Read with the rotation back on: the centre of a box does not move when it turns.
  const cx = (box.left + box.right) / 2 - origin.x
  const cy = (box.top + box.bottom) / 2 - origin.y
  if (Number.isFinite(local.minX)) {
    const cos = Math.cos(rotation)
    const sin = Math.sin(rotation)
    for (const [px, py] of [
      [local.minX, local.minY],
      [local.maxX, local.minY],
      [local.maxX, local.maxY],
      [local.minX, local.maxY],
    ]) {
      const dx = px - cx
      const dy = py - cy
      extend(bounds, cx + dx * cos - dy * sin, cy + dx * sin + dy * cos)
    }
  }
  return `<g transform="rotate(${num((rotation * 180) / Math.PI)} ${num(cx)} ${num(cy)})">${out.join('')}</g>`
}

// --- fonts -----------------------------------------------------------------------------

type Face = {
  family: string
  css: string
  url: string
  ranges: [number, number][] | null
}

/** `U+0000-00FF, U+0131, U+4??` as inclusive code point ranges. */
export function parseUnicodeRange(value: string): [number, number][] | null {
  const trimmed = value.trim()
  if (trimmed === '') return null
  const out: [number, number][] = []
  for (const raw of trimmed.split(',')) {
    const part = raw.trim().replace(/^u\+/i, '')
    if (part === '') continue
    if (part.includes('?')) {
      out.push([
        Number.parseInt(part.replace(/\?/g, '0'), 16),
        Number.parseInt(part.replace(/\?/g, 'F'), 16),
      ])
      continue
    }
    const [from, to] = part.split('-')
    const start = Number.parseInt(from, 16)
    const end = to === undefined ? start : Number.parseInt(to, 16)
    if (Number.isFinite(start) && Number.isFinite(end)) out.push([start, end])
  }
  return out.length === 0 ? null : out
}

function collectFaces(rules: CSSRuleList, base: string, out: Face[]): void {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSImportRule) {
      const sheet = rule.styleSheet
      if (sheet === null) continue
      let nested: CSSRuleList
      try {
        nested = sheet.cssRules
      } catch {
        continue
      }
      collectFaces(nested, sheet.href ?? base, out)
      continue
    }
    if (!(rule instanceof CSSFontFaceRule)) continue
    const style = rule.style
    const family = style.getPropertyValue('font-family').trim().replace(/^["']|["']$/g, '')
    const src = style.getPropertyValue('src')
    // The first woff2 or woff source. Anything else is a local() lookup, which a file
    // opened on another machine cannot resolve to the same face anyway.
    const match = /url\(\s*(["']?)([^"')]+)\1\s*\)/.exec(src)
    if (match === null || family === '') continue
    out.push({
      family: family.toLowerCase(),
      css: rule.cssText,
      url: new URL(match[2], base).href,
      ranges: parseUnicodeRange(style.getPropertyValue('unicode-range')),
    })
  }
}

async function dataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url)
    if (!response.ok) return null
    const blob = await response.blob()
    return await new Promise((resolve) => {
      const reader = new FileReader()
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null)
      reader.onerror = () => resolve(null)
      reader.readAsDataURL(blob)
    })
  } catch {
    return null
  }
}

/**
 * The `@font-face` rules for the faces this text uses, with each file inlined.
 *
 * A face is embedded when its family is somewhere in a run's stack and, if the face is
 * restricted by `unicode-range`, when that run has a character in the range. So a
 * board written in English carries two small Comic Neue files rather than nine Indic
 * faces it never draws, and a Bengali label brings exactly the Bengali one.
 *
 * Only same-origin stylesheets are readable, and the app's faces are self-hosted, so
 * that is all of them. A face that fails to load is left out and its text falls back,
 * which is a worse file rather than no file.
 */
export async function embedFonts(used: FontUse): Promise<string> {
  const faces: Face[] = []
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList
    try {
      rules = sheet.cssRules
    } catch {
      continue
    }
    collectFaces(rules, sheet.href ?? document.baseURI, faces)
  }

  const wanted = faces.filter((face) => {
    const chars = used.get(face.family)
    if (chars === undefined) return false
    if (face.ranges === null) return true
    for (const code of chars) {
      for (const [from, to] of face.ranges) if (code >= from && code <= to) return true
    }
    return false
  })

  const inlined = await Promise.all(
    wanted.map(async (face) => {
      const data = await dataUrl(face.url)
      if (data === null) return ''
      const format = /\.woff2(\?|#|$)/i.test(face.url) ? 'woff2' : /\.woff(\?|#|$)/i.test(face.url) ? 'woff' : 'truetype'
      // The rule as the browser serialised it, with its `src` swapped for the file
      // itself. `font-display` is dropped as meaningless in a file that has the font.
      const body = face.css
        .replace(/src\s*:[^;]+;?/i, `src: url("${data}") format("${format}");`)
        .replace(/font-display\s*:[^;]+;?/i, '')
      return body
    }),
  )
  return inlined.filter((rule) => rule !== '').join('\n')
}
