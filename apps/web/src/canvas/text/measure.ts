/**
 * Offscreen text measurement.
 *
 * A text object's height is not stored by the user, it is derived from the glyphs, and
 * ARCHITECTURE 1 says those measurements feed CRDT bounds. That makes this a
 * correctness surface rather than a layout detail: the number this returns is written
 * into the document and every other client sees it.
 *
 * Two consequences drive the design.
 *
 * Measurement happens at zoom 1, in world units, in an element outside the camera
 * transform. Measuring the live element would divide by the zoom and hand back a
 * different height at every scale, so a board would resize its own text as people
 * panned around it.
 *
 * Fonts must be loaded first. A measurement taken against a fallback face is simply
 * wrong, and it gets written to the CRDT before the real face arrives. `whenFontsReady`
 * is what the engine gates its first render on.
 */

import type { TextProps } from '@meadow/schema'

import { applyBoxStyle, applyContentStyle, contentWidth } from './textStyle'

let host: HTMLDivElement | null = null

function measurer(): HTMLDivElement {
  if (host !== null) return host

  const outer = document.createElement('div')
  // Off-canvas rather than `display: none`: a hidden element has no layout, so it has
  // no height to read. Negative positioning keeps it measurable and invisible.
  outer.style.cssText =
    'position:absolute;left:-99999px;top:0;visibility:hidden;pointer-events:none;contain:layout style;'
  outer.setAttribute('aria-hidden', 'true')
  document.body.appendChild(outer)

  host = outer
  return outer
}

/**
 * Bounded because the key includes the text itself, and a user typing a paragraph
 * generates one entry per keystroke. Dropping the whole map on overflow is crude but
 * costs one re-measure per entry, and a real LRU here would be more bookkeeping than
 * the thing it protects.
 */
const CACHE_LIMIT = 600
const cache = new Map<string, number>()

export function clearMeasureCache(): void {
  cache.clear()
  baselines.clear()
}

/**
 * Height of the content box for this HTML at this width, in world units.
 *
 * Returns the *content* height. Callers add padding themselves, so the caller that
 * wants an object height and the caller that wants a text height do not have to agree
 * on which one this includes.
 */
export function measureContentHeight(html: string, width: number, props: TextProps): number {
  const key = `${width}|${props.fontFamily}|${props.fontSize}|${props.lineHeight}|${props.align}|${html}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const outer = measurer()
  outer.style.width = `${width}px`

  const probe = document.createElement('div')
  applyContentStyle(probe, props)
  probe.innerHTML = html === '' ? '<p><br></p>' : html
  outer.replaceChildren(probe)

  const height = probe.getBoundingClientRect().height

  if (cache.size >= CACHE_LIMIT) cache.clear()
  cache.set(key, height)
  return height
}

/** Full object height for auto-height text: content plus padding, floored at one line. */
export function measureObjectHeight(html: string, width: number, props: TextProps): number {
  const inner = measureContentHeight(html, contentWidth(width, props), props)
  const oneLine = props.fontSize * props.lineHeight
  return Math.ceil(Math.max(inner, oneLine) + props.padding * 2)
}

/**
 * Where the first baseline sits below a text object's top edge, in world units.
 *
 * Laid out and read rather than computed. The arithmetic looks easy - half the leading
 * plus the ascent, plus the padding - and every term in it is a place to be wrong: the
 * ascent is the face's own and not a fraction of the em, the half-leading depends on
 * both, and the padding is only there when the box's vertical alignment leaves it
 * there. A constant fitted to one size then walks off the rules at the next.
 *
 * The empty inline-block is the trick that makes this a measurement. It has no size,
 * so it cannot move the line it lands in, and its bottom edge is the baseline, because
 * that is where the browser aligns it.
 *
 * Used by the ruled surface to phase its rules to the type. Cached, because it is read
 * on every camera change and the answer only moves when the column does.
 */
const baselines = new Map<string, number>()

export function measureBaselineOffset(props: TextProps, width: number): number {
  const key = `${width}|${props.fontFamily}|${props.fontSize}|${props.lineHeight}|${props.padding}|${props.verticalAlign}`
  const hit = baselines.get(key)
  if (hit !== undefined) return hit

  const outer = measurer()
  outer.style.width = `${width}px`

  const box = document.createElement('div')
  applyBoxStyle(box, props)
  box.style.width = `${width}px`
  box.style.height = `${measureObjectHeight('<p>Hxg</p>', width, props)}px`

  const content = document.createElement('div')
  applyContentStyle(content, props)
  content.innerHTML = '<p>Hxg<span data-strut style="display:inline-block;width:0;height:0"></span></p>'
  box.appendChild(content)
  outer.replaceChildren(box)

  const strut = content.querySelector('[data-strut]')
  const offset =
    strut === null
      ? props.fontSize * props.lineHeight
      : strut.getBoundingClientRect().bottom - box.getBoundingClientRect().top
  outer.replaceChildren()

  baselines.set(key, offset)
  return offset
}

/**
 * Resolve once the three project faces are usable.
 *
 * `document.fonts.ready` alone is not enough: it resolves when no load is *pending*,
 * and a face nothing has asked for yet is not pending. So ask for them explicitly
 * first. Failures resolve rather than reject, because a missing font should degrade to
 * fallback metrics, not stop the canvas from ever appearing.
 */
export async function whenFontsReady(): Promise<void> {
  if (typeof document === 'undefined' || document.fonts === undefined) return

  const faces = ['16px Inter', '16px "Comic Neue"', '16px "JetBrains Mono"']
  await Promise.all(faces.map((face) => document.fonts.load(face).catch(() => undefined)))
  await document.fonts.ready.catch(() => undefined)

  // Metrics taken before the faces landed are stale by definition.
  clearMeasureCache()
}
