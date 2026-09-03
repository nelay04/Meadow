import { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

import { ApiError, type BoardRole, mintGuestWsToken, mintWsToken } from '../lib/api'

/**
 * ws-tokens are single-use with a 60s TTL, which fights y-websocket's built-in
 * reconnect: the provider builds its URL once and retries on its own schedule, so
 * every retry after the first replays a spent token and is rejected 4401 forever.
 *
 * So autoConnect is off and reconnection is driven here: mint a fresh token, write it
 * into provider.params (read on each connect), then connect. Backoff is capped so a
 * genuinely revoked board does not hammer /ws-token, which is rate limited at
 * 30/min/user.
 */

const MIN_RETRY_MS = 500
const MAX_RETRY_MS = 15_000

/**
 * Server close codes, from ARCHITECTURE 6. 4401 (bad or expired credential) is not
 * listed because it needs no special handling: the retry mints a new ws-token, and
 * the API client refreshes the access token behind it on the way.
 */
const CLOSE_FORBIDDEN = 4403
const CLOSE_ROOM_FULL = 4429

export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'denied'

/**
 * What the server says this connection may do, as of the mint that opened it.
 *
 * Three fields rather than one, because `canWrite` alone cannot be explained to
 * anybody: a viewer and an editor on a locked board are both refused, and the notice
 * that says which is the difference between "ask the owner for access" and "the owner
 * locked it, wait".
 */
export type BoardAccess = {
  role: BoardRole
  /** Role permits writing *and* the board is not locked. The server's answer, not ours. */
  canWrite: boolean
  /** The owner's board-wide lock. */
  locked: boolean
}

type Options = {
  boardId: string
  doc: Y.Doc
  /**
   * The share token from the address bar, or null.
   *
   * Presented on every mint even by a member, because it can only raise the answer -
   * an editor link opens an editor connection for somebody whose membership is viewer.
   */
  linkToken: string | null
  /**
   * Whether there is a session behind this page.
   *
   * It picks the endpoint, and the two are genuinely different: a signed-in caller
   * mints against their membership (raised by the link if there is one), and an
   * anonymous visitor mints against the link alone at a route that has no auth on it
   * at all. Guessing from a 401 instead would make every anonymous visit start with a
   * refused request.
   */
  authenticated: boolean
  onState: (state: ConnectionState, detail?: string) => void
  /**
   * Fires whenever the server reports access, including a change after a reconnect.
   *
   * This is how a lock reaches the client. The owner's press evicts every socket on
   * the board; each one reconnects, re-mints, and is told the new answer here - which
   * is why nothing in the client needs to watch a lock flag or trust a peer's word
   * about one.
   */
  onAccess: (access: BoardAccess) => void
}

export type BoardConnection = {
  provider: WebsocketProvider
  disconnect: () => void
  reconnect: () => void
  destroy: () => void
}

export function connectBoard({
  boardId,
  doc,
  linkToken,
  authenticated,
  onState,
  onAccess,
}: Options): BoardConnection {
  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/board`

  const provider = new WebsocketProvider(wsBase, boardId, doc, {
    connect: false,
    params: {},
  })

  let retryMs = MIN_RETRY_MS
  let timer: number | undefined
  let wantConnection = true
  let destroyed = false

  const clearTimer = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const schedule = (): void => {
    if (!wantConnection || destroyed) return
    clearTimer()
    timer = window.setTimeout(() => void attempt(), retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
  }

  const attempt = async (): Promise<void> => {
    if (!wantConnection || destroyed) return
    onState('connecting')
    try {
      const minted =
        authenticated || linkToken === null
          ? await mintWsToken(boardId, linkToken)
          : await mintGuestWsToken(linkToken)
      // Re-read on every attempt: an access change is exactly why the server closed
      // the previous socket, so the reconnect is where the client learns the new
      // answer - a promotion, a demotion, or the board having just been locked.
      onAccess({ role: minted.role, canWrite: minted.can_write, locked: minted.is_locked })
      provider.params = { token: minted.token }
      provider.connect()
    } catch (error) {
      // 403 from the mint endpoint means access is gone, not that the network is
      // flaky. 404 is the same thing said by the public route: the link was rotated,
      // or the board is no longer shared. Retrying either cannot help and only burns
      // the rate limit.
      if (error instanceof ApiError && (error.status === 403 || error.status === 404)) {
        wantConnection = false
        onState(
          'denied',
          error.status === 404
            ? 'this link no longer opens this glade'
            : 'you no longer have access to this glade',
        )
        return
      }
      onState('disconnected', error instanceof Error ? error.message : String(error))
      schedule()
    }
  }

  provider.on('status', (event: { status: string }) => {
    if (event.status === 'connected') {
      retryMs = MIN_RETRY_MS
      onState('connected')
    }
  })

  // y-websocket reconnects internally on close. Disconnect first so it cannot retry
  // with the spent token, then drive the retry from here with a fresh one.
  provider.on('connection-close', (event: CloseEvent | null) => {
    if (!wantConnection) return
    provider.disconnect()

    if (event?.code === CLOSE_FORBIDDEN) {
      // Access was revoked, the role changed, or the board was locked or unlocked
      // mid-session. Reconnecting re-mints, which re-resolves all of it - and a genuine
      // revocation fails at the mint, which is what turns this into 'denied'.
      onState('disconnected', 'access changed, reconnecting')
      retryMs = MIN_RETRY_MS
      schedule()
      return
    }
    if (event?.code === CLOSE_ROOM_FULL) {
      onState('disconnected', 'this glade is full, retrying')
      schedule()
      return
    }
    // 4401 included: the access token behind the session expired, and the API client
    // refreshes it transparently on the next mint.
    onState('disconnected', event ? `closed ${event.code}` : 'closed')
    schedule()
  })

  provider.on('connection-error', () => {
    if (!wantConnection) return
    onState('disconnected', 'connection error')
    provider.disconnect()
    schedule()
  })

  void attempt()

  return {
    provider,
    disconnect: () => {
      wantConnection = false
      clearTimer()
      provider.disconnect()
      onState('disconnected', 'offline (manual)')
    },
    reconnect: () => {
      wantConnection = true
      retryMs = MIN_RETRY_MS
      void attempt()
    },
    destroy: () => {
      destroyed = true
      wantConnection = false
      clearTimer()
      provider.destroy()
    },
  }
}
