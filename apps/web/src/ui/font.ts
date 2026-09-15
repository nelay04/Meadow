/**
 * The two font preferences: what the app's chrome is set in, and what new canvas text
 * is written in.
 *
 * Both are preferences of this browser, beside the theme, and both use the schema's
 * font slugs so the two lists are one list.
 *
 * They are not the same kind of preference, and the difference is the whole design.
 * The interface font is only ever how Meadow looks to you, so it applies directly: a
 * `data-font` on the root element, with the stacks in styles.css as `--ui-font`.
 *
 * The canvas font is never applied to what is already on a board. A text object's face
 * is part of the document: its height is measured in that face and written into the
 * CRDT, so a reader who saw every board in their own face would write their own height
 * for every object and overwrite everybody else's for as long as both were open. So
 * this one is only a default. It is stamped onto new text on a glade and onto a new
 * lea, and from then on the face is the document's and everybody sees the same one.
 */

import { FONT_FAMILIES, type FontFamily } from '@meadow/schema'

export const FONTS = FONT_FAMILIES
export type Font = FontFamily

/** How each one is offered, in the order Preferences shows them. */
export const FONT_ORDER: readonly Font[] = [
  'comic',
  'poppins',
  'inter',
  'nunito',
  'quicksand',
  'mono',
  'patrick',
  'caveat',
  'kalam',
]

export const FONT_LABEL: Record<Font, string> = {
  comic: 'Comic Neue',
  poppins: 'Poppins',
  inter: 'Inter',
  nunito: 'Nunito',
  quicksand: 'Quicksand',
  mono: 'JetBrains Mono',
  patrick: 'Patrick Hand',
  caveat: 'Caveat',
  kalam: 'Kalam',
}

export const DEFAULT_FONT: Font = 'comic'

function isFont(value: unknown): value is Font {
  return typeof value === 'string' && (FONTS as readonly string[]).includes(value)
}

function read(key: string): Font {
  try {
    const stored = localStorage.getItem(key)
    return isFont(stored) ? stored : DEFAULT_FONT
  } catch {
    // Private-mode Safari throws on localStorage, the way the theme handles it.
    return DEFAULT_FONT
  }
}

function write(key: string, font: Font): void {
  try {
    if (font === DEFAULT_FONT) localStorage.removeItem(key)
    else localStorage.setItem(key, font)
  } catch {
    // The choice still applies for this session.
  }
}

// --- interface -----------------------------------------------------------------------

const STORAGE_KEY = 'meadow.font'

/** Fired on `window` after the root's `data-font` changes. */
export const FONT_EVENT = 'meadow:font'

export function readFont(): Font {
  return read(STORAGE_KEY)
}

function setRoot(font: Font): void {
  if (typeof document === 'undefined') return
  if (font === DEFAULT_FONT) delete document.documentElement.dataset.font
  else document.documentElement.dataset.font = font
}

export function applyFont(font: Font): void {
  setRoot(font)
  write(STORAGE_KEY, font)
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }))
}

/** Call once at startup, before the first paint, so the stored font does not flash. */
export function initFont(): Font {
  const font = readFont()
  setRoot(font)
  return font
}

// --- canvas ----------------------------------------------------------------------------

const CANVAS_STORAGE_KEY = 'meadow.canvasFont'

/** Fired on `window` when the canvas font preference changes. */
export const CANVAS_FONT_EVENT = 'meadow:canvas-font'

export function readCanvasFont(): Font {
  return read(CANVAS_STORAGE_KEY)
}

export function writeCanvasFont(font: Font): void {
  write(CANVAS_STORAGE_KEY, font)
  window.dispatchEvent(new CustomEvent(CANVAS_FONT_EVENT, { detail: font }))
}

/* The same tab-to-tab bridge as the theme and the paper. See the note in ui/paper.ts. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === null || event.key === STORAGE_KEY) {
      const font = readFont()
      setRoot(font)
      window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }))
    }
    if (event.key === null || event.key === CANVAS_STORAGE_KEY) {
      window.dispatchEvent(new CustomEvent(CANVAS_FONT_EVENT, { detail: readCanvasFont() }))
    }
  })
}
