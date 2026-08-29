/**
 * What a diary page is printed on.
 *
 * One level, not two. It was the document's choice with a reader default under it, and
 * the two disagreed the moment either control was touched: the profile moved the
 * preference while a lea carrying its own stock went on rendering that. So the stock is
 * the reader's, a preference about this browser rather than about any page, and it
 * lives here beside the theme for the same reasons the theme does. Both the profile's
 * "Diary paper" and a lea's own paper menu read and write exactly this.
 *
 * `system` is the one that follows the app: it is not a fifth palette, it is the light
 * and dark ones selected by `light-dark()`, so it changes with the theme toggle with
 * nothing listening.
 *
 * The colours themselves are not here. They are `[data-paper]` blocks in the
 * stylesheet, so adding a stock is a block of CSS and a name in this list.
 */

export const PAPERS = ['vintage', 'light', 'dark', 'system'] as const
export type Paper = (typeof PAPERS)[number]

/** How each one is offered, in the order the menus show them. */
export const PAPER_LABEL: Record<Paper, string> = {
  vintage: 'Vintage',
  light: 'Light',
  dark: 'Dark',
  system: 'Match theme',
}

export const DEFAULT_PAPER: Paper = 'vintage'

const STORAGE_KEY = 'meadow.lea.paper'

/** Fired on `window` when the reader's default changes. */
export const PAPER_EVENT = 'meadow:paper'

export function isPaper(value: unknown): value is Paper {
  return typeof value === 'string' && (PAPERS as readonly string[]).includes(value)
}

export function readPaperPreference(): Paper {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isPaper(stored) ? stored : DEFAULT_PAPER
  } catch {
    // Private-mode Safari throws on localStorage, the way the theme handles it.
    return DEFAULT_PAPER
  }
}

export function writePaperPreference(paper: Paper): void {
  try {
    if (paper === DEFAULT_PAPER) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, paper)
  } catch {
    // The choice still applies for this session.
  }
  window.dispatchEvent(new CustomEvent(PAPER_EVENT, { detail: paper }))
}

/*
 * Every tab of this browser holds the same preference, so every tab hears it change.
 *
 * `localStorage` is shared across tabs and a `CustomEvent` is not, so a diary open in
 * one tab never learned that the profile in another had changed its default: it kept
 * the stock it read at mount until it was reloaded. `storage` is the browser's own
 * answer, and it fires in every tab *except* the one that wrote - exactly the half
 * that is missing, because the writer already announced it itself.
 *
 * Translated into the same `PAPER_EVENT` rather than exposed as a second subscription,
 * so nothing downstream has to know there are two ways a preference can move. A null
 * key is `localStorage.clear()`, which is also a change.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    window.dispatchEvent(new CustomEvent(PAPER_EVENT, { detail: readPaperPreference() }))
  })
}
