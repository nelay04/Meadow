/**
 * Whether phonetic Bengali input is on. One switch, for the whole app.
 *
 * Not in the Y.Doc, and deliberately: an input method is a property of the person
 * typing, not of the document. Two people on one lea can be writing in different
 * scripts, and a shared toggle would have one of them turning the other's keyboard off.
 * The pages-open preference is stored the same way and for the same reason.
 *
 * A plain store rather than React state because the editor is not a React component -
 * it is a TipTap instance the canvas owns - and both it and the toolbar button have to
 * read the same value. `useSyncExternalStore` on the button, `subscribe` in the editor.
 */

const KEY = 'meadow.input.bengali'

const listeners = new Set<() => void>()
let enabled = read()

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === 'on'
  } catch {
    // Private windows and blocked site data. The option still works, it just does not
    // survive a reload.
    return false
  }
}

export function bengaliInputEnabled(): boolean {
  return enabled
}

export function setBengaliInput(next: boolean): void {
  if (next === enabled) return
  enabled = next
  try {
    window.localStorage.setItem(KEY, next ? 'on' : 'off')
  } catch {
    // See `read`.
  }
  for (const listener of listeners) listener()
}

export function toggleBengaliInput(): boolean {
  setBengaliInput(!enabled)
  return enabled
}

export function subscribeBengaliInput(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
