/**
 * Presence. ARCHITECTURE 6: cursors are **wanderers**.
 *
 * Awareness rides the same socket as the document but is not part of it. It is
 * ephemeral state that y-protocols relays and expires on its own, and it must never
 * reach the Y.Doc: a cursor position written into the CRDT would land in the update
 * log, the snapshot, and the undo stack, and a board would accumulate a permanent
 * record of where everyone's mouse had been.
 *
 * The one thing worth getting right here is the update rate. A pointermove fires at up
 * to 120Hz, every awareness change is a broadcast to every peer, and a room of ten
 * people moving their mice would otherwise be sending 1,200 frames a second between
 * them for something the eye cannot resolve past about 20.
 */

import type { Awareness } from 'y-protocols/awareness'

import type { Wanderer } from '../canvas/overlay/wandererLayer'

/** Roughly 30Hz. Below the rate a cursor reads as smooth, well above what is polite. */
const CURSOR_INTERVAL_MS = 33

/**
 * Wanderer colours.
 *
 * Picked from the user id rather than assigned on join, so one person is the same
 * colour for everybody and stays that colour across reconnects. A per-room rotation
 * would recolour everyone whenever somebody left.
 */
const PALETTE = [
  0x2f7d4f, 0xd8456b, 0x7b8fd4, 0xd88c5a, 0x5aa7c4, 0xc47ba0, 0x8a7bc4, 0x4f9d6b,
]

export function colorFor(userId: string): number {
  let hash = 0
  for (let index = 0; index < userId.length; index += 1) {
    hash = (hash * 31 + userId.charCodeAt(index)) >>> 0
  }
  return PALETTE[hash % PALETTE.length]
}

export type LocalPresence = {
  id: string
  name: string
}

export type WandererState = {
  user: { id: string; name: string; color: number }
  cursor: { x: number; y: number } | null
  selection: string[]
}

export type PresenceHandle = {
  /** World coordinates, or null when the pointer leaves the canvas. */
  setCursor(point: { x: number; y: number } | null): void
  setSelection(ids: readonly string[]): void
  destroy(): void
}

/**
 * Bind local presence to an awareness instance and report remote peers.
 *
 * `onChange` fires with everyone *except* this client. Rendering your own cursor as a
 * wanderer is the classic version of this bug and it looks like input lag.
 */
export function trackPresence(
  awareness: Awareness,
  local: LocalPresence,
  onChange: (wanderers: Wanderer[]) => void,
): PresenceHandle {
  const user = { id: local.id, name: local.name, color: colorFor(local.id) }
  awareness.setLocalStateField('user', user)
  awareness.setLocalStateField('cursor', null)
  awareness.setLocalStateField('selection', [])

  let pending: { x: number; y: number } | null = null
  let hasPending = false
  let timer: number | undefined

  const flush = (): void => {
    timer = undefined
    if (!hasPending) return
    hasPending = false
    awareness.setLocalStateField('cursor', pending)
  }

  /**
   * Peers we have already greeted, so a re-announce happens once per arrival.
   *
   * The server relays awareness but does not replay it: `YRoom.serve` sends a sync
   * message to a joining client and nothing else, so the newest peer knows the
   * document immediately and knows *who else is here* only when one of them next
   * publishes. y-protocols does re-announce on a timer, so it heals on its own after
   * roughly fifteen seconds, which is long enough that opening a busy board shows an
   * empty room and the avatars trickle in.
   *
   * The fix is to answer an arrival: when a peer we have not seen appears, publish our
   * own state again so they learn about us in the same round trip. It cannot ping-pong,
   * because a re-announce reaches the other side as an *update* to a client it already
   * knows, and only additions trigger this.
   *
   * Deliberately client-side. The server-side version - encoding the room's awareness
   * and writing it to the socket at handshake time - worked, and intermittently hung
   * the room: it writes to the channel before `YRoom.serve` has taken it over, and the
   * backend test suite deadlocked on it roughly half the time. There is no race to
   * have here.
   */
  const greeted = new Set<number>()

  const collect = (): void => {
    const wanderers: Wanderer[] = []
    let sawNewPeer = false

    for (const [clientId, raw] of awareness.getStates()) {
      if (clientId === awareness.clientID) continue

      const state = raw as Partial<WandererState> | undefined
      const remote = state?.user
      if (remote === undefined) continue

      if (!greeted.has(clientId)) {
        greeted.add(clientId)
        sawNewPeer = true
      }

      wanderers.push({
        clientId,
        name: typeof remote.name === 'string' && remote.name !== '' ? remote.name : 'someone',
        color: typeof remote.color === 'number' ? remote.color : colorFor(String(remote.id ?? '')),
        cursor:
          state?.cursor != null &&
          typeof state.cursor.x === 'number' &&
          typeof state.cursor.y === 'number'
            ? { x: state.cursor.x, y: state.cursor.y }
            : null,
        selection: Array.isArray(state?.selection) ? state.selection.filter((id) => typeof id === 'string') : [],
      })
    }

    onChange(wanderers)

    if (sawNewPeer) {
      // Re-publish so the arriving peer learns about us now rather than on the next
      // keepalive. `setLocalState` with the current state is what forces the update;
      // `setLocalStateField` with an unchanged value would be a no-op.
      awareness.setLocalState(awareness.getLocalState())
    }
  }

  const forget = ({ removed }: { removed: number[] }): void => {
    // Otherwise a peer who left and came back would not be greeted again, and the
    // reconnecting side would be the one sitting in an apparently empty room.
    for (const clientId of removed) greeted.delete(clientId)
  }

  awareness.on('change', collect)
  awareness.on('change', forget)
  collect()

  return {
    setCursor(point) {
      pending = point
      hasPending = true
      // Leaving the canvas publishes immediately. A stale cursor left hovering after
      // someone has moved away is worse than a late one.
      if (point === null) {
        if (timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
        flush()
        return
      }
      if (timer === undefined) timer = window.setTimeout(flush, CURSOR_INTERVAL_MS)
    },

    setSelection(ids) {
      // Not throttled: selection changes are discrete and rare, and a late highlight
      // is more noticeable than a late cursor.
      awareness.setLocalStateField('selection', Array.from(ids))
    },

    destroy() {
      if (timer !== undefined) clearTimeout(timer)
      awareness.off('change', collect)
      awareness.off('change', forget)
      // Tell the room we are gone rather than waiting for the 30s timeout to expire
      // this client, which would leave a ghost cursor sitting on the board.
      awareness.setLocalState(null)
    },
  }
}
