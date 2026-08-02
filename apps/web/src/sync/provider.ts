import { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

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

export type ConnectionState = 'connecting' | 'connected' | 'disconnected'

type Options = {
  boardId: string
  doc: Y.Doc
  onState: (state: ConnectionState, detail?: string) => void
}

export type BoardConnection = {
  provider: WebsocketProvider
  disconnect: () => void
  reconnect: () => void
}

async function mintToken(boardId: string): Promise<string> {
  const response = await fetch('/api/v1/ws-token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: boardId }),
  })
  if (!response.ok) {
    throw new Error(`ws-token failed: ${response.status}`)
  }
  const body: { token: string } = await response.json()
  return body.token
}

export function connectBoard({ boardId, doc, onState }: Options): BoardConnection {
  const wsBase = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/board`

  const provider = new WebsocketProvider(wsBase, boardId, doc, {
    connect: false,
    params: {},
  })

  let retryMs = MIN_RETRY_MS
  let timer: number | undefined
  let wantConnection = true
  let closed = false

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
  }

  const attempt = async () => {
    if (!wantConnection || closed) return
    onState('connecting')
    try {
      provider.params = { token: await mintToken(boardId) }
      provider.connect()
    } catch (error) {
      onState('disconnected', error instanceof Error ? error.message : String(error))
      schedule()
    }
  }

  const schedule = () => {
    if (!wantConnection || closed) return
    clearTimer()
    timer = window.setTimeout(attempt, retryMs)
    retryMs = Math.min(retryMs * 2, MAX_RETRY_MS)
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
    onState('disconnected', event ? `close ${event.code}` : 'closed')
    provider.disconnect()
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
  }
}
