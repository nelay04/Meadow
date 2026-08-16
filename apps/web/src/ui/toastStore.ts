/**
 * The toast list, as plain functions over plain data.
 *
 * Separate from the component because all the behaviour worth being sure about is
 * here: what happens when the same message arrives forty times in a second, and what
 * happens when more toasts arrive than a corner of the screen can hold. Both have a
 * right answer, neither is obvious from looking at a rendered stack, and both are
 * testable in node without a DOM.
 */

export type ToastKind = 'success' | 'error' | 'info'

export type ToastAction = { label: string; run(): void }

export type Toast = {
  id: string
  kind: ToastKind
  message: string
  /** How long it stays up, in ms. Drives the progress bar and the dismissal. */
  life: number
  /**
   * Bumped every time a duplicate restarts this toast's clock. The progress bar is
   * keyed on it, which is what makes the CSS animation start over: React cannot
   * restart an animation on an element it considers unchanged.
   */
  seq: number
  /** How many times this message has arrived. Shown as a badge from two upwards. */
  count: number
  action?: ToastAction
  /** Set while the exit transition runs, so the node stays mounted long enough. */
  leaving?: boolean
}

export type ToastInput = {
  kind: ToastKind
  message: string
  life?: number
  action?: ToastAction
}

/**
 * An error gets longer than a success because it has to be read rather than
 * recognised. A success is a full stop on something the user just did and already
 * knows about; nobody needs four seconds to learn that the thing they clicked worked.
 */
export const LIFETIMES: Record<ToastKind, number> = {
  success: 4000,
  info: 5000,
  error: 7000,
}

/**
 * Above this the stack stops being a notification and becomes a wall.
 *
 * The oldest goes, not the newest. A toast that arrives while four are already up is
 * the one describing what just happened, and the one from six seconds ago has been
 * read or was never going to be.
 */
export const MAX_VISIBLE = 4

let counter = 0

export function nextToastId(): string {
  counter += 1
  return `toast-${counter}`
}

/**
 * Add a toast, or refresh the one that is already saying this.
 *
 * The dedupe is the important half. A refusal from the canvas fires from a pointer
 * handler, so "you cannot edit a locked glade" can arrive on every frame of a drag.
 * Forty identical toasts is not forty pieces of information, and dismissing them one
 * by one is a punishment for having tried. Same kind and same words means the same
 * event: restart its clock, count it, and leave the stack alone.
 *
 * Matched against live toasts only. One that is already leaving has had its exit
 * started and reviving it mid-transition looks like a glitch rather than an update.
 */
export function pushToast(list: readonly Toast[], input: ToastInput): Toast[] {
  const existing = list.find(
    (toast) => toast.leaving !== true && toast.kind === input.kind && toast.message === input.message,
  )

  if (existing !== undefined) {
    return list.map((toast) =>
      toast.id === existing.id
        ? { ...toast, seq: toast.seq + 1, count: toast.count + 1, action: input.action }
        : toast,
    )
  }

  const toast: Toast = {
    id: nextToastId(),
    kind: input.kind,
    message: input.message,
    life: input.life ?? LIFETIMES[input.kind],
    seq: 0,
    count: 1,
    action: input.action,
  }

  const next = [...list, toast]

  // Count only what is still on screen. Toasts already on their way out are about to
  // free their slot on their own, and evicting a live one to make room for a corpse
  // makes a burst of messages drop the ones the user has not seen yet.
  const live = next.filter((entry) => entry.leaving !== true)
  if (live.length <= MAX_VISIBLE) return next

  const doomed = new Set(live.slice(0, live.length - MAX_VISIBLE).map((entry) => entry.id))
  return next.map((entry) => (doomed.has(entry.id) ? { ...entry, leaving: true } : entry))
}

/** Start a toast's exit. It stays in the list until `removeToast` drops it. */
export function dismissToast(list: readonly Toast[], id: string): Toast[] {
  return list.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast))
}

export function removeToast(list: readonly Toast[], id: string): Toast[] {
  return list.filter((toast) => toast.id !== id)
}
