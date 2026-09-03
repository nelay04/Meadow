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
import { roleCanWrite } from '../doc/mutations'
import type { BoardRole } from '../lib/api'

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

const ROLES: readonly BoardRole[] = ['owner', 'editor', 'commenter', 'viewer']

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
  /** The picture this person chose, so peers show a face rather than initials. */
  avatarUrl?: string | null
  /**
   * What this client resolved its own role to, so peers can name it: the badge, the
   * crown on an owner, and the line the card under a face shows on click.
   */
  role: BoardRole
}

export type WandererState = {
  user: {
    id: string
    name: string
    avatarUrl: string | null
    color: number
    role: BoardRole
    /**
     * Redundant with the role, and sent anyway: peers on a build from before roles
     * were published read this field and nothing else, and dropping it would demote
     * every one of them to a viewer badge.
     */
    canWrite: boolean
  }
  cursor: { x: number; y: number } | null
  selection: string[]
}

export type PresenceHandle = {
  /** World coordinates, or null when the pointer leaves the canvas. */
  setCursor(point: { x: number; y: number } | null): void
  setSelection(ids: readonly string[]): void
  /**
   * Republish the role.
   *
   * Presence is bound when the connection opens, and the role is resolved by the
   * handshake a moment later, so the first announcement is always made without it. It
   * can also change mid-session when an owner promotes somebody.
   */
  setRole(role: BoardRole): void
  /**
   * Re-introduce this client to the room, after the socket has been replaced.
   *
   * Called on every connect, including reconnects, and it is the difference between
   * presence recovering in a blink and recovering in fifteen seconds. See the body for
   * the clock rule it is working around.
   */
  resync(): void
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
  const user = {
    id: local.id,
    name: local.name,
    // Normalised to null rather than left undefined: awareness state is JSON on the
    // wire, and an undefined field simply vanishes, which reads on the far side as a
    // peer on an older build rather than as a peer with no picture.
    avatarUrl: local.avatarUrl ?? null,
    color: colorFor(local.id),
    role: local.role,
    canWrite: roleCanWrite(local.role),
  }
  let announced = user
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
   * The half of the introduction this side owes. The server now sends a joining client
   * the room's current awareness (`app/realtime/server.py::awareness_snapshot`), so an
   * arriving peer learns about us without being told twice - but a peer arriving is
   * still news to *us*, and answering it means they get whatever we have changed since
   * that snapshot was taken. It cannot ping-pong, because a re-announce reaches the
   * other side as an *update* to a client it already knows, and only additions trigger
   * this.
   *
   * Both halves are needed, and the reason is the reconnect. y-websocket drops every
   * remote awareness state when a socket closes, so a client coming back from an
   * eviction has forgotten the room, while the peers it left behind never noticed it
   * go and have no reason to announce themselves again. Only the server knows both
   * things at once.
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
        // A peer on an older build sends no picture at all, and the header falls back
        // to initials on its own.
        avatarUrl:
          typeof remote.avatarUrl === 'string' && remote.avatarUrl !== '' ? remote.avatarUrl : null,
        color: typeof remote.color === 'number' ? remote.color : colorFor(String(remote.id ?? '')),
        // Absent means a peer on an older build, which announced `canWrite` and no
        // role. There is no honest name for the role in that case - an editor and an
        // owner both write - so it stays null and the header shows the badge alone.
        role: ROLES.includes(remote.role as BoardRole) ? (remote.role as BoardRole) : null,
        // Reading an absent `canWrite` as "viewer" would mark every older peer
        // read-only, so the benign default is the common case.
        canWrite: remote.canWrite !== false,
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
    resync() {
      /*
       * Both halves of a reconnection, and both are about the awareness *clock*
       * rather than about the states everybody can see.
       *
       * y-protocols accepts an update for a client only when its clock has advanced
       * (`applyAwarenessUpdate`), and a clock advances only on `setLocalState`. A
       * reconnect changes neither side's state, so both sides go quiet in a way that
       * is invisible until you look at the clocks:
       *
       * - **Peers ignore us.** y-websocket re-announces our state the moment the new
       *   socket opens, at the clock we already had. Everybody who kept a clock for us
       *   - which is everybody who did not drop at the same instant - reads that as
       *   old news and drops it, and we stay missing from their row until our own
       *   fifteen-second keepalive finally moves the number.
       * - **We ignore peers.** Closing a socket makes y-websocket delete every remote
       *   *state* while keeping the *clock* it last saw for each. So the room snapshot
       *   the server sends on join, and any peer re-announce, both arrive looking
       *   equally stale, and the faces stay gone for the same fifteen seconds.
       *
       * So: forget the clocks of peers whose state we no longer hold, which lets us
       * accept whatever we are told next, and bump our own, which is what makes
       * everybody else accept us. This is the reported "collaborator circles vanish
       * when I sit still" - sitting still is what a reconnect leaves you doing.
       */
      for (const clientId of Array.from(awareness.meta.keys())) {
        if (clientId !== awareness.clientID && !awareness.getStates().has(clientId)) {
          awareness.meta.delete(clientId)
        }
      }
      greeted.clear()
      // setLocalState rather than setLocalStateField: the point is the clock, and a
      // field written with the value it already holds does not move it.
      awareness.setLocalState(awareness.getLocalState())
    },

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

    setRole(role) {
      if (announced.role === role) return
      announced = { ...announced, role, canWrite: roleCanWrite(role) }
      awareness.setLocalStateField('user', announced)
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
