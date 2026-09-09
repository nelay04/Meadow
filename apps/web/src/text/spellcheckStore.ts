/**
 * Whether the browser marks misspellings on a writing page. One switch, for the whole app.
 *
 * A preference of this browser rather than of the diary, for the reason `imeStore.ts`
 * gives about input methods and `ui/paper.ts` gives about stock: two people on one lea
 * are writing in different languages on different machines with different dictionaries
 * installed, and a shared setting would have one of them turning the other's underlines
 * off. Nothing here reaches the Y.Doc.
 *
 * A plain store rather than React state, and for the same reason as the IME's: the menu
 * item is a React component and the editor is a TipTap instance the canvas owns, and
 * both have to read one value. `useSyncExternalStore` on the item, `subscribe` in the
 * editor.
 *
 * On by default. A red underline under a typo is what every other writing surface on the
 * machine does, so having to go and find the switch to get it would be the surprise; the
 * switch is there for the opposite case, a notebook full of names and loanwords that no
 * dictionary knows, where the underlines are noise on every line.
 */

const KEY = 'meadow.spellcheck'

const listeners = new Set<() => void>()

function read(): boolean {
  try {
    // Only an explicit "off" turns it off, so a cleared key, a private window and a
    // first visit all mean the same thing: on.
    return window.localStorage.getItem(KEY) !== 'off'
  } catch {
    // Private windows and blocked site data, as everywhere else. The option still
    // works, it just does not survive a reload.
    return true
  }
}

let enabled = read()

/** Whether misspellings are marked. */
export function spellcheckEnabled(): boolean {
  return enabled
}

export function setSpellcheckEnabled(next: boolean): void {
  if (next === enabled) return

  enabled = next
  try {
    window.localStorage.setItem(KEY, next ? 'on' : 'off')
  } catch {
    // It still holds for this session.
  }
  for (const listener of listeners) listener()
}

export function subscribeSpellcheck(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/*
 * Every tab of this browser holds the same preference, so every tab hears it change.
 *
 * `ui/paper.ts` explains the shape: `localStorage` is shared across tabs and an
 * in-process listener set is not, and `storage` fires in every tab except the one that
 * wrote - exactly the half that is missing, since the writer announced it itself. A null
 * key is `localStorage.clear()`, which is also a change.
 */
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key !== null && event.key !== KEY) return
    const next = read()
    if (next === enabled) return
    enabled = next
    for (const listener of listeners) listener()
  })
}
