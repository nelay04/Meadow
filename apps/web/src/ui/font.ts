/**
 * The face the app's chrome is set in.
 *
 * A preference of this browser, beside the theme and for the same reasons: it is how
 * Meadow looks to you, and nothing about it is written into a board. Text objects on
 * the canvas keep their own font, because that one is part of the document and every
 * collaborator has to measure it the same way.
 *
 * Applied as `data-font` on the root element. The stacks themselves are in
 * styles.css as `--ui-font`, so a new face is a block of CSS and a name in this list.
 */

export const FONTS = ['comic', 'poppins'] as const
export type Font = (typeof FONTS)[number]

/** How each one is offered, in the order Preferences shows them. */
export const FONT_LABEL: Record<Font, string> = {
  comic: 'Comic Neue',
  poppins: 'Poppins',
}

export const DEFAULT_FONT: Font = 'comic'

const STORAGE_KEY = 'meadow.font'

/** Fired on `window` after the root's `data-font` changes. */
export const FONT_EVENT = 'meadow:font'

function isFont(value: unknown): value is Font {
  return typeof value === 'string' && (FONTS as readonly string[]).includes(value)
}

export function readFont(): Font {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isFont(stored) ? stored : DEFAULT_FONT
  } catch {
    // Private-mode Safari throws on localStorage, the way the theme handles it.
    return DEFAULT_FONT
  }
}

function setRoot(font: Font): void {
  if (typeof document === 'undefined') return
  if (font === DEFAULT_FONT) delete document.documentElement.dataset.font
  else document.documentElement.dataset.font = font
}

export function applyFont(font: Font): void {
  setRoot(font)
  try {
    if (font === DEFAULT_FONT) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, font)
  } catch {
    // The font still applies for this session.
  }
  window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }))
}

/* The same tab-to-tab bridge as the theme and the paper. See the note in ui/paper.ts. */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    const font = readFont()
    setRoot(font)
    window.dispatchEvent(new CustomEvent(FONT_EVENT, { detail: font }))
  })
}

/** Call once at startup, before the first paint, so the stored font does not flash. */
export function initFont(): Font {
  const font = readFont()
  setRoot(font)
  return font
}
