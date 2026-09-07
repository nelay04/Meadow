import { useSyncExternalStore } from 'react'

/**
 * The one place the phone breakpoint is written down for JavaScript.
 *
 * It is the same 560px the stylesheet turns the tool rail into a bar at, and it has to
 * stay that way: the page list is a drawer over the paper below this width and a column
 * beside it above, and the two answers come from different places - CSS decides how it
 * is drawn, React decides whether the scrim exists and whether it opens by default. A
 * second number here would give a band of widths with a drawer and no scrim.
 *
 * `matchMedia` rather than a width comparison because a resize listener re-renders on
 * every pixel of a drag and this fires twice in the life of a session: once when it
 * becomes true, once when it stops being.
 */
export const PHONE_QUERY = '(max-width: 560px)'

/**
 * Whether the layout is at phone width, as a subscription rather than a snapshot.
 *
 * Read through `useSyncExternalStore` for the same reason the document is: the value
 * lives outside React, and copying it into state means holding a second copy that is
 * right until it is not. Rotating a phone crosses this breakpoint, so it does move
 * while a board is open.
 */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot)
}

function subscribe(onChange: () => void): () => void {
  const query = window.matchMedia(PHONE_QUERY)
  query.addEventListener('change', onChange)
  return () => query.removeEventListener('change', onChange)
}

function snapshot(): boolean {
  return window.matchMedia(PHONE_QUERY).matches
}

/* No window, no phone. Nothing here is server-rendered; this is what makes the hook
   safe to call from a test that runs without a DOM. */
function serverSnapshot(): boolean {
  return false
}

/**
 * The same answer outside a component, for the one caller that needs it before React
 * has mounted: a `useState` initialiser choosing whether a panel opens.
 */
export function isPhone(): boolean {
  try {
    return window.matchMedia(PHONE_QUERY).matches
  } catch {
    return false
  }
}
