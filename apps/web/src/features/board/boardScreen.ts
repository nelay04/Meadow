/**
 * Whether a glade may be drawn, and what stands in for it when it may not.
 *
 * One function because this is one decision, and it used to be three: a render branch
 * for `denied`, another for `password`, and the glade itself as the fall-through -
 * which meant the fall-through was reached by default, while the handshake that
 * decides it was still in flight. The local offline copy hydrates in a few
 * milliseconds and the handshake takes a round trip, so a locked glade drew its whole
 * document and then covered it with a password screen. A lock has to come first or it
 * is decoration.
 *
 * So the default is now the other way round: nothing of the document is drawn, or
 * even read out of this browser's store, until something says it may be. Both the
 * paint and the hydration ask this function, so they cannot disagree.
 */

import type { ConnectionState } from '../../sync/provider'

export type BoardScreen =
  /** The glade itself. */
  | 'glade'
  /** The question has not been answered yet. Quiet, and usually brief. */
  | 'opening'
  /** Locked, and no way to check the password from here. */
  | 'blocked'
  /** Locked, and the password can be typed. */
  | 'password'
  /** Not this browser's to open. */
  | 'denied'

export type Seen = {
  /** The server has minted a token for this browser at least once this mount. */
  admitted: boolean
  /** An attempt has failed for a reason that is not a refusal: the API is not there. */
  unreachable: boolean
  /** This browser has been told before, on some earlier visit, that this one is locked. */
  lockedBefore: boolean
}

export function boardScreen(state: ConnectionState, seen: Seen): BoardScreen {
  // Both of these outrank an earlier admission on purpose. A password put on a glade
  // somebody is already reading, or a grant withdrawn under them, closes the socket;
  // the re-mint is refused, and the refusal is the newer answer.
  if (state === 'denied') return 'denied'
  if (state === 'password') return 'password'

  // The only thing that opens a glade: the server minted a token for this browser,
  // which is the same check the websocket handshake makes.
  if (seen.admitted) return 'glade'

  if (seen.unreachable) {
    // Offline-first is what the local store is for, and an unreachable API is not a
    // refusal - but it is not an admission either, so a glade that has asked this
    // browser for a password before stays shut. Only the server can check one, and
    // "cannot check" has to read as no.
    return seen.lockedBefore ? 'blocked' : 'glade'
  }

  return 'opening'
}
