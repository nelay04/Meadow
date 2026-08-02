import { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

import { ApiError, type BoardRole, mintWsToken } from '../lib/api'

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

type Options = {
  boardId: string
  doc: Y.Doc
  onState: (state: ConnectionState, detail?: string) => void
  /** Fires whenever the server reports a role, including a change after reconnect. */
  onRole: (role: BoardRole) => void
}

export type BoardConnection = {
  provider: WebsocketProvider
  disconnect: () => void
  reconnect: () => void
  destroy: () => void
}

export function connectBoard({ boardId, doc, onState, onRole }: Options): BoardConnection {
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
      const minted = await mintWsToken(boardId)
      // Re-read on every attempt: a role change is exactly why the server closed the
      // previous socket, so the reconnect is where the client learns the new one.
      onRole(minted.role)
      provider.params = { token: minted.token }
      provider.connect()
    } catch (error) {
      // 403 from the mint endpoint means access is gone, not that the network is
      // flaky. Retrying cannot help and only burns the rate limit.
      if (error instanceof ApiError && error.status === 403) {
        wantConnection = false
        onState('denied', 'you no longer have access to this field')
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
      // Access was revoked, or the role changed mid-session. Reconnecting re-mints,
      // which re-resolves the role - and a genuine revocation fails at the mint.
      onState('disconnected', 'access changed, reconnecting')
      retryMs = MIN_RETRY_MS
      schedule()
      return
    }
    if (event?.code === CLOSE_ROOM_FULL) {
      onState('disconnected', 'this field is full, retrying')
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
