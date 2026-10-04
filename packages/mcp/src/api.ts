/**
 * The REST half of Meadow, as a personal access token sees it.
 *
 * Deliberately small: the API accepts a token on listing and reading boards, creating
 * one, minting a ws-token and reading the account, and on nothing else. Every document
 * read and write goes over the websocket, through the same handshake a browser passes.
 */

// Defined in @meadow/document-core, because the document layer is what acts on it.
// Imported and re-exported, not re-exported straight through: this file's own
// signatures use the name, and `export ... from` would not bind it locally.
import type { BoardRole } from '@meadow/document-core'

export type { BoardRole }

export type Board = {
  id: string
  workspace_id: string
  title: string
  kind: string
  role: BoardRole
  can_write: boolean
  /** Changing the glade other than removing objects. Split from delete by fine-grained tokens. */
  can_edit: boolean
  /** Removing objects. */
  can_delete: boolean
  is_locked: boolean
  has_password: boolean
  updated_at: string
}

export type Me = {
  id: string
  display_name: string
  default_workspace_id: string | null
}

export type WsToken = {
  token: string
  role: BoardRole
  can_write: boolean
  can_edit: boolean
  can_delete: boolean
  is_locked: boolean
}

export type TokenGrant = {
  board_id: string
  title: string
  read: boolean
  edit: boolean
  delete: boolean
}

/** The token describing itself: what it may do before any role or lock is applied. */
export type TokenInfo = {
  id: string
  name: string
  kind: 'classic' | 'fine_grained'
  expires_at: string | null
  can_create_glades: boolean
  /** Null for a classic token, which has every glade its owner can open. */
  grants: TokenGrant[] | null
}

export class MeadowApiError extends Error {
  constructor(
    readonly status: number,
    detail: string,
  ) {
    super(detail)
    this.name = 'MeadowApiError'
  }
}

/** A human sentence for a refusal, since this text reaches the model and then a person. */
function explain(status: number, detail: string): string {
  if (status === 401) {
    return 'Meadow refused the access token. It may be wrong, revoked or expired: create a new one under Profile > Access tokens.'
  }
  if (detail.includes('password required')) {
    return 'This glade has a password, and access tokens cannot open password-protected glades.'
  }
  if (detail.includes('token may not create')) {
    return 'This access token cannot create glades. A classic token can, and so can a fine-grained one given the create permission under Profile > Access tokens.'
  }
  if (status === 403)
    return 'This access token has no access to that glade. Call get_my_access to see which glades it can open.'
  if (status === 429) return 'Meadow is rate limiting this token. Wait a moment and try again.'
  return `Meadow answered ${status}: ${detail}`
}

/** One mutation, as the audit trail records it. See `recordEvent`. */
export type McpEvent = {
  operationId: string
  tool: string
  /** What the batch asked to touch, against what the write took. */
  requested: number
  accepted: number
  durationMs: number
  outcome: 'applied' | 'refused' | 'failed'
  reason?: string
}

export class MeadowApi {
  constructor(
    readonly origin: string,
    private readonly token: string,
  ) {}

  get wsBase(): string {
    const url = new URL(this.origin)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${url.origin}${url.pathname.replace(/\/+$/, '')}/ws/board`
  }

  private async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`${this.origin}/api/v1${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    })
    if (!response.ok) {
      const raw = await response.text()
      let detail = raw
      try {
        const parsed = JSON.parse(raw) as { detail?: unknown }
        if (typeof parsed.detail === 'string') detail = parsed.detail
      } catch {
        // Not JSON; the raw text is the detail.
      }
      throw new MeadowApiError(response.status, explain(response.status, detail))
    }
    return (await response.json()) as T
  }

  me(): Promise<Me> {
    return this.call<Me>('/auth/me')
  }

  listBoards(): Promise<Board[]> {
    return this.call<Board[]>('/boards')
  }

  getBoard(boardId: string): Promise<Board> {
    return this.call<Board>(`/boards/${encodeURIComponent(boardId)}`)
  }

  createBoard(workspaceId: string, title: string, kind: string): Promise<Board> {
    return this.call<Board>('/boards', {
      method: 'POST',
      body: { workspace_id: workspaceId, title, kind },
    })
  }

  currentToken(): Promise<TokenInfo> {
    return this.call<TokenInfo>('/tokens/current')
  }

  mintWsToken(boardId: string): Promise<WsToken> {
    return this.call<WsToken>('/ws-token', {
      method: 'POST',
      body: { board_id: boardId },
    })
  }

  /**
   * Record one mutation in the glade's audit trail.
   *
   * Posted rather than read off the socket because a Yjs update carries no origin: the
   * operation id lives on the transaction that produced the update and is never encoded
   * into it. This is also the only way the server learns the parts only this side knows,
   * which tool ran and how long it took.
   *
   * Nothing here names the actor. Who did it is the server's answer, from the token this
   * request presents.
   */
  recordEvent(boardId: string, event: McpEvent): Promise<unknown> {
    return this.call(`/boards/${encodeURIComponent(boardId)}/mcp-events`, {
      method: 'POST',
      body: {
        operation_id: event.operationId,
        tool: event.tool,
        requested: event.requested,
        accepted: event.accepted,
        duration_ms: event.durationMs,
        outcome: event.outcome,
        ...(event.reason === undefined ? {} : { reason: event.reason }),
      },
    })
  }
}
