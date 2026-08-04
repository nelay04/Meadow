/**
 * The one definition of how a text object is laid out.
 *
 * Every consumer applies these same styles: the idle overlay element, the offscreen
 * measurer, and the mounted TipTap editor. They have to agree exactly. If the measurer
 * uses a slightly different box model from the element it is measuring for, the height
 * written into the CRDT is wrong by a few pixels and the text clips or floats. If the
 * editor differs from the idle element, the text visibly jumps at the moment the user
 * double-clicks, which is the sort of detail that makes an app feel unfinished.
 *
 * Sizes here are world units. The overlay root carries the camera scale, so nothing
 * below it ever multiplies by the zoom.
 */

import type { FontFamily, TextProps, VerticalAlign } from '@meadow/schema'

/**
 * Self-hosted faces from public/fonts. The fallbacks matter for the first paint
 * before `document.fonts.ready` resolves, and for the headless browsers the smoke
 * tests run in.
 */
export const FONT_STACKS: Record<FontFamily, string> = {
  inter: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif",
  comic: "'Comic Neue', 'Comic Sans MS', ui-rounded, cursive",
  mono: "'JetBrains Mono', ui-monospace, 'SFMono-Regular', Consolas, monospace",
}

const FLEX_ALIGN: Record<VerticalAlign, string> = {
  top: 'flex-start',
  middle: 'center',
  bottom: 'flex-end',
}

/**
 * Marks the content box in both the overlay and the offscreen measurer.
 *
 * The two have to lay out identically or the measured height is wrong, and browser
 * defaults are the obvious way for them to disagree: a `<p>` carries a 1em margin, a
 * `<ul>` carries padding, and the measurer would inherit whichever stylesheet happened
 * to be on the page. Hence the reset below, injected from JavaScript rather than
 * written in styles.css, so it is present wherever this module is used including the
 * dev harness.
 */
export const CONTENT_CLASS = 'meadow-rt'

const CONTENT_CSS = `
.${CONTENT_CLASS} > * { margin: 0; padding: 0; }
.${CONTENT_CLASS} > * + * { margin-top: 0.4em; }
.${CONTENT_CLASS} h1 { font-size: 1.6em; font-weight: 650; line-height: 1.2; }
.${CONTENT_CLASS} h2 { font-size: 1.3em; font-weight: 650; line-height: 1.25; }
.${CONTENT_CLASS} h3 { font-size: 1.1em; font-weight: 650; line-height: 1.3; }
.${CONTENT_CLASS} ul, .${CONTENT_CLASS} ol { padding-left: 1.4em; }
.${CONTENT_CLASS} li { margin: 0; }
.${CONTENT_CLASS} li > p { margin: 0; }
.${CONTENT_CLASS} blockquote { border-left: 2px solid currentColor; padding-left: 0.6em; opacity: 0.85; }
.${CONTENT_CLASS} pre { font-family: ${FONT_STACKS.mono}; font-size: 0.92em; white-space: pre-wrap; }
.${CONTENT_CLASS} code { font-family: ${FONT_STACKS.mono}; font-size: 0.92em; }
.${CONTENT_CLASS} p:empty::before { content: ''; display: inline-block; }
.${CONTENT_CLASS}.ProseMirror { outline: none; }
`

let stylesInjected = false

export function ensureContentStyles(): void {
  if (stylesInjected || typeof document === 'undefined') return
  stylesInjected = true

  const style = document.createElement('style')
  style.dataset.meadow = 'rich-text'
  style.textContent = CONTENT_CSS
  document.head.appendChild(style)
}

export function cssColor(value: number): string {
  return `#${(value >>> 0).toString(16).padStart(6, '0').slice(-6)}`
}

/** Usable width for text inside an object of world width `w`. */
export function contentWidth(w: number, props: TextProps): number {
  return Math.max(1, w - props.padding * 2)
}

/**
 * Styles for the inner content box: the element whose height is the text's height.
 *
 * `pre-wrap` keeps the user's own spacing and their empty lines. `overflow-wrap` on
 * top of `break-word` is what stops a single pasted 400-character URL from silently
 * widening the object past its own bounds.
 */
export function applyContentStyle(element: HTMLElement, props: TextProps): void {
  ensureContentStyles()
  element.classList.add(CONTENT_CLASS)

  const style = element.style
  style.fontFamily = FONT_STACKS[props.fontFamily]
  style.fontSize = `${props.fontSize}px`
  style.lineHeight = String(props.lineHeight)
  style.color = cssColor(props.color)
  style.textAlign = props.align
  style.whiteSpace = 'pre-wrap'
  style.overflowWrap = 'break-word'
  style.wordBreak = 'normal'
  style.margin = '0'
  style.padding = '0'
  style.border = '0'
  style.outline = 'none'
  style.width = '100%'
}

/** Styles for the outer box: position, padding, and vertical alignment. */
export function applyBoxStyle(element: HTMLElement, props: TextProps): void {
  const style = element.style
  style.position = 'absolute'
  style.boxSizing = 'border-box'
  style.padding = `${props.padding}px`
  style.display = 'flex'
  style.flexDirection = 'column'
  style.justifyContent = FLEX_ALIGN[props.verticalAlign]
  style.overflow = 'hidden'
  // The canvas below owns selection and dragging. Only an object being edited takes
  // the pointer back, and it does that by overriding this on itself.
  style.pointerEvents = 'none'
  style.userSelect = 'none'
}
