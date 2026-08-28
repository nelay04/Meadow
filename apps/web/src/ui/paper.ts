/**
 * What a diary page is printed on.
 *
 * Two levels, because the two questions are different. A lea can say what stock it is
 * on, which travels with the page and is the same for everyone who opens it - that
 * lives in the document. A reader can say what they want a page that has *not* chosen
 * to look like, which is a preference about this browser rather than about any page,
 * and that lives here beside the theme for the same reasons the theme does.
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

/**
 * What a page is actually printed on: its own choice, or the reader's default when it
 * has none. One function so the board and any preview answer it the same way.
 */
export function resolvePaper(pagePaper: string, preference: Paper): Paper {
  return isPaper(pagePaper) ? pagePaper : preference
}
