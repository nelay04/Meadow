/**
 * Light, dark, or whatever the OS says.
 *
 * The whole palette is expressed with CSS `light-dark()` against the `color-scheme`
 * on the root element, so switching themes is one property write and there is no
 * second copy of the colours to keep in step. Setting `color-scheme` also fixes the
 * scrollbars, the form controls and the native caret, which a class-based theme has
 * to chase separately.
 *
 * The canvas is the exception: WebGL knows nothing about CSS, so the engine reads
 * `--canvas-bg` off its own host element and repaints when this module says so.
 */

export const THEMES = ['system', 'light', 'dark'] as const
export type Theme = (typeof THEMES)[number]

const STORAGE_KEY = 'meadow.theme'

/** Fired on `window` after the root's `color-scheme` changes. */
export const THEME_EVENT = 'meadow:theme'

function isTheme(value: unknown): value is Theme {
  return typeof value === 'string' && (THEMES as readonly string[]).includes(value)
}

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    return isTheme(stored) ? stored : 'system'
  } catch {
    // Private-mode Safari throws on localStorage. A theme preference is not worth
    // taking the app down for.
    return 'system'
  }
}

export function applyTheme(theme: Theme): void {
  if (typeof document === 'undefined') return

  document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme

  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, theme)
  } catch {
    // As above: the theme still applies for this session.
  }

  // The engine listens for this. A CSS variable change is not observable, so the
  // one thing that cannot read the cascade gets told explicitly.
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }))
}

/*
 * The same tab-to-tab bridge the paper preference has, and for the same reason: this
 * is one browser's setting, so a window that did not make the change still has to hear
 * about it. `storage` fires everywhere but the tab that wrote, which already announced
 * it. See the note in ui/paper.ts.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== null && event.key !== STORAGE_KEY) return
    const theme = readTheme()
    document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }))
  })
}

/** Call once at startup, before the first paint, so the stored theme does not flash. */
export function initTheme(): Theme {
  const theme = readTheme()
  if (typeof document !== 'undefined') {
    document.documentElement.style.colorScheme = theme === 'system' ? 'light dark' : theme
  }
  return theme
}

export function nextTheme(theme: Theme): Theme {
  return THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length]
}
