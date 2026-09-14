/**
 * A glade, open: a real peer on the board's websocket.
 *
 * Not a REST round trip per edit, and not a second write path. The server has no
 * endpoint that edits a document, by design, so this joins the room exactly as a
 * browser does - ws-token, handshake, `resolve_access`, the read-only filter - and
 * writes through `mutations.ts` into its own Y.Doc, which syncs like anybody else's.
 * People with the board open watch the edits arrive, and the agent shows up among the
 * wanderers while it works.
 *
 * Rooms are cached per board and closed after a minute idle, so a model reading a board
 * and then editing it does not reconnect in between, and a server left running does not
 * hold every board it ever touched open.
 */

import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'

import { type DocSession, createDocSession } from '../../../apps/web/src/doc/mutations'
import type { Board, BoardRole, MeadowApi, WsToken } from './api'

const SYNC_TIMEOUT_MS = 15_000
const FLUSH_TIMEOUT_MS = 5_000

const CLOSE_REASONS: Record<number, string> = {
  4401: 'Meadow refused the connection: the access token was revoked or has expired.',
  4403: 'Meadow refused the connection: the token has no access to this glade, or access just changed.',
  4429: 'This glade is full. Try again shortly.',
}

/** The wanderer palette in `sync/awareness.ts`, indexed the same way. */
const PALETTE = [0x2f7d4f, 0xd8456b, 0x7b8fd4, 0xd88c5a, 0x5aa7c4, 0xc47ba0, 0x8a7bc4, 0x4f9d6b]

function colourFor(id: string): number {
  let hash = 0
  for (let index = 0; index < id.length; index += 1) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return PALETTE[hash % PALETTE.length]
}

export class RoomError extends Error {}

export type Room = {
  board: Board
  access: WsToken
  session: DocSession
  provider: WebsocketProvider
  lastUsed: number
}

export type Identity = {
  userId: string
  /** "<client> (via MCP)", from the client's own name. Read lazily: it arrives after connect. */
  name: () => string
}

export type Action = 'edit' | 'delete'

/** What this connection may do, as a phrase: "read, edit and delete". */
export function allowedPhrase(access: Pick<WsToken, 'can_edit' | 'can_delete'>): string {
  if (access.can_edit && access.can_delete) return 'read, edit and delete'
  if (access.can_edit) return 'read and edit, but not delete'
  if (access.can_delete) return 'read and delete, but not edit'
  return 'only read'
}

/**
 * Why an action is refused on a glade, in words a model can act on, or null when allowed.
 *
 * Names the actual boundary. "Read-only" when the token could edit but the owner locked
 * the glade would send a model off to ask for a different token, which cannot help.
 */
export function refusal(room: Pick<Room, 'board' | 'access'>, action: Action): string | null {
  const { access, board } = room
  if (action === 'edit' ? access.can_edit : access.can_delete) return null
  const what = action === 'edit' ? 'edit' : 'delete objects on'
  if (access.role === 'viewer' || access.role === 'commenter') {
    return `Cannot ${what} "${board.title}": your role there is ${access.role}, which is read-only.`
  }
  if (access.is_locked) {
    return `Cannot ${what} "${board.title}": the owner has locked it. Nobody can change it until they unlock it.`
  }
  return `Cannot ${what} "${board.title}": this access token may ${allowedPhrase(access)} there. The token's owner can change its permissions under Profile > Access tokens.`
}

export class Rooms {
  private readonly open = new Map<string, Room>()
  private readonly pending = new Map<string, Promise<Room>>()
  private readonly sweeper: NodeJS.Timeout

  constructor(
    private readonly api: MeadowApi,
    private readonly identity: Identity,
    private readonly idleMs: number,
  ) {
    this.sweeper = setInterval(() => this.sweep(), Math.min(idleMs, 10_000))
    this.sweeper.unref()
  }

  async get(boardId: string): Promise<Room> {
    const room = this.open.get(boardId)
    if (room !== undefined && room.provider.wsconnected) {
      room.lastUsed = Date.now()
      return room
    }
    if (room !== undefined) this.close(boardId)

    // One connection per board even when a model fires two tool calls at once.
    let joining = this.pending.get(boardId)
    if (joining === undefined) {
      joining = this.join(boardId).finally(() => this.pending.delete(boardId))
      this.pending.set(boardId, joining)
    }
    return joining
  }

  private async join(boardId: string): Promise<Room> {
    const board = await this.api.getBoard(boardId)
    if (board.has_password) {
      throw new RoomError(
        'This glade has a password, and access tokens cannot open password-protected glades.',
      )
    }
    const access = await this.api.mintWsToken(boardId)

    const doc = new Y.Doc()
    const role: BoardRole = access.can_write ? access.role : 'viewer'
    // Writes are refused before they reach the session, with the reason in words (see
    // `refusal`); the session only has to agree, which a viewer role makes it do. The
    // edit/delete split is enforced again by the server, whatever this process does.
    const session = createDocSession(doc, role)

    const provider = new WebsocketProvider(this.api.wsBase, boardId, doc, {
      params: { token: access.token },
      WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
      // Same-process tabs are not a thing here, and the in-memory channel would only
      // ever talk to itself.
      disableBc: true,
    })

    const room: Room = {
      board,
      access,
      session,
      provider,
      lastUsed: Date.now(),
    }

    // A ws-token is single use, so y-websocket's own reconnect would present a spent one
    // and loop. A closed room is dropped instead, and the next tool call joins afresh.
    let closeCode: number | null = null
    provider.on('connection-close', (event: { code?: number } | null) => {
      closeCode = event?.code ?? null
      provider.shouldConnect = false
      if (this.open.get(boardId) === room) this.close(boardId)
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        provider.destroy()
        reject(new RoomError('Timed out joining the glade. Is Meadow reachable from here?'))
      }, SYNC_TIMEOUT_MS)
      const onSync = (synced: boolean): void => {
        if (!synced) return
        clearTimeout(timer)
        provider.off('sync', onSync)
        resolve()
      }
      provider.on('sync', onSync)
      provider.on('connection-close', () => {
        if (provider.synced) return
        clearTimeout(timer)
        provider.destroy()
        reject(
          new RoomError(
            CLOSE_REASONS[closeCode ?? 0] ??
              `The connection to the glade closed (${closeCode ?? 'no code'}).`,
          ),
        )
      })
    })

    provider.awareness.setLocalStateField('user', {
      id: `${this.identity.userId}:mcp`,
      name: this.identity.name(),
      avatarUrl: null,
      color: colourFor(`${this.identity.userId}:mcp`),
      role: access.role,
      canWrite: access.can_write,
    })
    provider.awareness.setLocalStateField('cursor', null)
    provider.awareness.setLocalStateField('selection', [])

    this.open.set(boardId, room)
    return room
  }

  /** Point the agent's cursor at what it just did, so people watching can see where. */
  show(room: Room, ids: readonly string[], at: { x: number; y: number } | null): void {
    room.provider.awareness.setLocalStateField('selection', [...ids])
    room.provider.awareness.setLocalStateField('cursor', at)
  }

  /** Wait until the socket has handed every queued update to the network. */
  async flush(room: Room): Promise<void> {
    const deadline = Date.now() + FLUSH_TIMEOUT_MS
    for (;;) {
      const socket = room.provider.ws as unknown as WebSocket | null
      if (socket === null || !room.provider.wsconnected) {
        throw new RoomError(
          'The connection closed before the edit was sent. Nothing may have been saved; read the glade again.',
        )
      }
      if (socket.bufferedAmount === 0) break
      if (Date.now() > deadline) throw new RoomError('Timed out sending the edit to Meadow.')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    // One more turn, so a write queued by the same tick is on the wire too.
    await new Promise((resolve) => setImmediate(resolve))
  }

  close(boardId: string): void {
    const room = this.open.get(boardId)
    if (room === undefined) return
    this.open.delete(boardId)
    room.provider.awareness.setLocalState(null)
    room.provider.destroy()
    room.session.doc.destroy()
  }

  closeAll(): void {
    clearInterval(this.sweeper)
    for (const boardId of [...this.open.keys()]) this.close(boardId)
  }

  private sweep(): void {
    const now = Date.now()
    for (const [boardId, room] of this.open) {
      if (now - room.lastUsed > this.idleMs) this.close(boardId)
    }
  }
}
