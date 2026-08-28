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
.${CONTENT_CLASS} > * + * { margin-top: var(--meadow-rt-gap, 0.4em); }
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
 * How a text box is laid out. `box` fills an object; `arrow-label` rides a line.
 *
 * A variant rather than a second function applied on top, and that is the whole point.
 * The earlier arrangement had `applyArrowLabelStyle` overriding three properties after
 * the fact, which meant every property one of them set and the other did not was left
 * at whatever the previous object had put there - overlay nodes are pooled, so that is
 * a real path, and `align-items` was the live example. A node that had been a caption
 * kept `center`, and the next object to reuse it laid its text out shrink-to-fit, so
 * the words ran out of the shape instead of wrapping inside it.
 *
 * One function that assigns every property it cares about, every time, has no such
 * class of bug.
 */
export type BoxVariant = 'box' | 'arrow-label'

/**
 * Styles for the inner content box: the element whose height is the text's height.
 *
 * `pre-wrap` keeps the user's own spacing and their empty lines. `overflow-wrap` on
 * top of `break-word` is what stops a single pasted 400-character URL from silently
 * widening the object past its own bounds.
 */
export function applyContentStyle(
  element: HTMLElement,
  props: TextProps,
  variant: BoxVariant = 'box',
): void {
  ensureContentStyles()
  element.classList.add(CONTENT_CLASS)

  const label = variant === 'arrow-label'
  const style = element.style
  style.fontFamily = FONT_STACKS[props.fontFamily]
  style.fontSize = `${props.fontSize}px`
  style.lineHeight = String(props.lineHeight)
  // A property rather than a class, so the measurer and the live overlay cannot end up
  // with different block spacing and disagree about how tall the text is.
  style.setProperty('--meadow-rt-gap', `${props.paragraphSpacing}em`)
  style.color = cssColor(props.color)
  style.textAlign = props.align
  style.whiteSpace = 'pre-wrap'
  style.overflowWrap = 'break-word'
  style.wordBreak = 'normal'
  style.margin = '0'
  style.padding = '0'
  style.border = '0'
  style.outline = 'none'
  // A caption shrinks to its words so it sits centred on the line; everything else
  // fills its box so the text wraps inside the shape rather than beside it.
  style.width = label ? 'max-content' : '100%'
  style.maxWidth = label ? '100%' : 'none'
  style.background = 'none'
  style.borderRadius = '0'
}

/** Styles for the outer box: position, padding, alignment, and clipping. */
export function applyBoxStyle(
  element: HTMLElement,
  props: TextProps,
  variant: BoxVariant = 'box',
  editing = false,
): void {
  const label = variant === 'arrow-label'
  const style = element.style
  style.position = 'absolute'
  style.boxSizing = 'border-box'
  style.padding = label ? '0' : `${props.padding}px`
  style.display = 'flex'
  style.flexDirection = 'column'
  style.justifyContent = label ? 'center' : FLEX_ALIGN[props.verticalAlign]
  style.alignItems = label ? 'center' : 'stretch'
  /*
   * Nothing is ever clipped. Text that does not fit spills, centred, and stays legible.
   *
   * This box used to clip, on the reasoning that text escaping a shape is the shape
   * lying about its own size. That is true and it is the lesser problem. A label is
   * centred on both axes, so a block taller than its box is cut at *both* ends: the
   * first and last lines disappear, and past a certain size the whole caption does.
   * Somebody raising the type size and watching their words vanish has no way to tell
   * whether the text is still there. Overflowing is visibly wrong in a way they can
   * see and fix; clipping is invisibly wrong.
   *
   * The horizontal axis is not the same question - the content is sized to the box, so
   * it wraps rather than spilling, and only a single unbreakable word can exceed it.
   */
  style.overflow = 'visible'
  // The canvas below owns selection and dragging. Only an object being edited takes
  // the pointer back.
  style.pointerEvents = editing ? 'auto' : 'none'
  style.userSelect = editing ? 'text' : 'none'
}

/**
 * The signature in the bottom-right corner of a sticky note.
 *
 * Chrome rather than content: it is not in the `Y.XmlFragment`, so it cannot be typed
 * into, selected, or accidentally deleted, and it never counts towards the note's
 * measured height. It reads at about two thirds the note's own size and well under
 * full contrast, which is what keeps it a signature rather than a second line of text.
 *
 * Positioned absolutely inside the note's box, so it stays in the corner however much
 * is written above it. The note's own bottom padding is what stops the writing running
 * into it.
 */
export function applyBylineStyle(element: HTMLElement, props: TextProps): void {
  const style = element.style
  style.position = 'absolute'
  style.right = `${props.padding}px`
  style.bottom = `${Math.max(4, props.padding - 6)}px`
  style.fontFamily = FONT_STACKS[props.fontFamily]
  style.fontSize = `${Math.max(8, props.fontSize * 0.66)}px`
  style.lineHeight = '1'
  style.color = cssColor(props.color)
  style.opacity = '0.55'
  style.pointerEvents = 'none'
  style.userSelect = 'none'
  style.whiteSpace = 'nowrap'
  style.maxWidth = '70%'
  style.overflow = 'hidden'
  style.textOverflow = 'ellipsis'
}
