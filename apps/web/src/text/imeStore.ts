/**
 * Which script the keyboard is writing in, or none. One switch, for the whole app.
 *
 * Not in the Y.Doc, and deliberately: an input method is a property of the person
 * typing, not of the document. Two people on one lea can be writing in different
 * scripts, and a shared setting would have one of them turning the other's keyboard off.
 * The pages-open preference is stored the same way and for the same reason.
 *
 * A plain store rather than React state because the editor is not a React component -
 * it is a TipTap instance the canvas owns - and both it and the toolbar button have to
 * read the same value. `useSyncExternalStore` on the button, `subscribe` in the editor.
 *
 * Two values are kept, not one. `language` is what is on now; `last` is what Ctrl+G
 * turns back on, so switching off and on again returns to the script you were writing
 * rather than to whatever the default happens to be.
 */

import { inputLanguage } from './inputLanguages'

const KEY = 'meadow.input.language'
const LAST_KEY = 'meadow.input.last'
const DEFAULT_LANGUAGE = 'bn'

const listeners = new Set<() => void>()

function read(key: string): string | null {
  try {
    const stored = window.localStorage.getItem(key)
    // A code that is no longer offered - a language withdrawn from the list, a hand
    // edited value - is not a language. Off is the safe reading of it.
    return inputLanguage(stored) === null ? null : stored
  } catch {
    // Private windows and blocked site data. The option still works, it just does not
    // survive a reload.
    return null
  }
}

let language = read(KEY)
let last = read(LAST_KEY) ?? language ?? DEFAULT_LANGUAGE

function write(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key)
    else window.localStorage.setItem(key, value)
  } catch {
    // See `read`.
  }
}

/** The language being typed, or null when phonetic input is off. */
export function inputLanguageId(): string | null {
  return language
}

/** What Ctrl+G switches back on. Never null. */
export function lastInputLanguageId(): string {
  return last
}

export function setInputLanguage(next: string | null): void {
  const resolved = next === null || inputLanguage(next) === null ? null : next
  if (resolved === language) return

  language = resolved
  write(KEY, resolved)
  if (resolved !== null) {
    last = resolved
    write(LAST_KEY, resolved)
  }
  for (const listener of listeners) listener()
}

/** Off if something is on, and back to the last script if not. Returns what is on now. */
export function toggleInputLanguage(): string | null {
  setInputLanguage(language === null ? last : null)
  return language
}

export function subscribeInputLanguage(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
