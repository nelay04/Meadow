import { WebsocketProvider } from 'y-websocket'
import type * as Y from 'yjs'

import { ApiError, type BoardRole, mintGuestWsToken, mintWsToken } from '../lib/api'
import { boardPass, forgetBoardPass } from '../lib/boardPass'

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

/**
 * What the API says when a board's password has not been answered.
 *
 * Matched on the substring rather than parsed, because the body arrives as FastAPI's
 * JSON envelope and this is the one detail string the client branches on. The server
 * spells it from a single constant (`board_password.PASSWORD_REQUIRED`) so the two
 * halves cannot drift apart quietly.
 */
const PASSWORD_REQUIRED = 'password required'

function isPasswordRefusal(error: ApiError): boolean {
  return error.message.includes(PASSWORD_REQUIRED)
}

/**
 * `password` is a refusal like `denied`, and a different one.
 *
 * Both mean the mint said no and retrying cannot help, so both stop the loop. What
 * separates them is what the person does next: `denied` is answered by somebody else
 * granting access, and `password` is answered by typing. Folding them together would
 * put "ask the owner to let you in" in front of somebody who was let in weeks ago and
 * simply has not typed today's password.
 */
export type ConnectionState =
  | 'connecting'
  | 'connected'
  | 'disconnected'
  | 'denied'
  | 'password'

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

/**
 * What a `flush` found, which is the whole of what this client can honestly say.
 *
 * - `saved`: everything written here has left this browser down an open socket. The
 *   server writes each update to `board_updates` as it reads it, so a byte that has
 *   left is a byte that is kept.
 * - `offline`: there is no socket. The work is in this browser's own store and goes up
 *   on the next connection, which a flush also asks for.
 * - `slow`: connected, and the socket has not emptied yet. Nothing is lost and nothing
 *   is confirmed either - a large paste on a poor line looks exactly like this.
 */
export type SaveResult = 'saved' | 'offline' | 'slow'

export type BoardConnection = {
  provider: WebsocketProvider
  disconnect: () => void
  reconnect: () => void
  /** Push what this client has written and say whether it got there. See `SaveResult`. */
  flush: (timeoutMs?: number) => Promise<SaveResult>
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
      // The pass is re-read on every attempt rather than captured once: the password
      // screen writes it and then asks for a reconnect, and this is where that lands.
      const pass = boardPass(boardId)
      const minted =
        authenticated || linkToken === null
          ? await mintWsToken(boardId, linkToken, pass)
          : await mintGuestWsToken(linkToken, pass)
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
      // The board has a password and this browser has not proved it - either it never
      // did, or the owner has since changed it. Either way the pass in hand is worth
      // nothing, so it is dropped before the screen that asks for a new one.
      if (error instanceof ApiError && error.status === 403 && isPasswordRefusal(error)) {
        wantConnection = false
        forgetBoardPass(boardId)
        onState('password')
        return
      }
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

  /*
   * Stop y-websocket's own reconnect without re-entering its teardown.
   *
   * `provider.disconnect()` is the obvious call here and it is a trap: it ends in
   * `closeWebsocketConnection`, which emits `connection-close` *before* it clears
   * `provider.ws`. Calling it from inside that same event therefore re-enters, sees a
   * socket still set, and emits again - about twelve hundred times, until the stack
   * overflows. The RangeError escapes through `ws.onclose`, so the teardown never
   * finishes: `provider.ws` stays set, `wsconnected` stays true, and every later
   * `connect()` is a no-op because it only acts on a null socket. The connection is
   * dead for the rest of the page's life, which is why locking a glade, or any ordinary
   * network blip, used to need a reload to recover from.
   *
   * The flag is all that was wanted from `disconnect()` anyway. y-websocket's internal
   * retry is a `setTimeout(setupWS)` that checks `shouldConnect`, so clearing it is
   * what stops the retry replaying our spent single-use token; the close it is already
   * in the middle of does the rest, and `attempt()` sets the flag back through
   * `provider.connect()`.
   */
  const stopInternalRetry = (): void => {
    provider.shouldConnect = false
  }

  provider.on('connection-close', (event: CloseEvent | null) => {
    if (!wantConnection) return
    stopInternalRetry()

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
    // Same reason as above, and the socket is on its way down regardless: a WebSocket
    // error is always followed by a close, and that close is what clears `provider.ws`.
    stopInternalRetry()
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
    /*
     * There is nothing to save, and that is exactly why this exists.
     *
     * Every edit is handed to the socket by y-websocket the moment it is made, and the
     * server appends it to `board_updates` as it reads it. So a "save" here is not a
     * write that was being held back: it is a question, and the only honest answer is
     * whether what this client has written has actually left it.
     *
     * `bufferedAmount` is what answers that. It is the bytes the browser has accepted
     * from us and not yet put on the wire, so zero on an open socket means everything
     * written so far is at the other end - and ordered ahead of anything sent after it,
     * because a WebSocket is a stream. It is not an acknowledgement from the database,
     * and this deliberately does not pretend to be one: there is no round trip in the
     * sync protocol to wait on, and inventing one to make a familiar key feel familiar
     * would be a new message type on the hot path for reassurance alone.
     *
     * Disconnected is not a failure and must not be reported as one. The edits are in
     * this browser's IndexedDB store and replay on the next connection, so the useful
     * thing to do with the keypress is to stop waiting out the backoff and try now.
     */
    flush: async (timeoutMs = 4_000): Promise<SaveResult> => {
      const socket = provider.ws
      if (!provider.wsconnected || socket === null || socket.readyState !== WebSocket.OPEN) {
        if (wantConnection && !destroyed) {
          retryMs = MIN_RETRY_MS
          void attempt()
        }
        return 'offline'
      }

      const deadline = Date.now() + timeoutMs
      while (socket.bufferedAmount > 0) {
        if (Date.now() >= deadline) return 'slow'
        // The socket drains on the browser's own schedule and fires nothing when it
        // does, so there is no event to wait for. Short enough to feel immediate on a
        // buffer that is already empty, which is the ordinary case.
        await new Promise((resolve) => setTimeout(resolve, 50))
        // Dropped while we waited. The work is safe locally, which is `offline`, not
        // a lie about it having landed.
        if (provider.ws !== socket || socket.readyState !== WebSocket.OPEN) return 'offline'
      }
      return 'saved'
    },
    destroy: () => {
      destroyed = true
      wantConnection = false
      clearTimer()
      provider.destroy()
    },
  }
}
