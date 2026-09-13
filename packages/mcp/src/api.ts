/**
 * The REST half of Meadow, as a personal access token sees it.
 *
 * Deliberately small: the API accepts a token on listing and reading boards, creating
 * one, minting a ws-token and reading the account, and on nothing else. Every document
 * read and write goes over the websocket, through the same handshake a browser passes.
 */

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer'

export type Board = {
  id: string
  workspace_id: string
  title: string
  kind: string
  role: BoardRole
  can_write: boolean
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
  is_locked: boolean
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
    return 'This access token cannot create glades: that needs a read-and-edit token that is not limited to particular glades.'
  }
  if (status === 403) return 'The access token has no access to that glade.'
  if (status === 429) return 'Meadow is rate limiting this token. Wait a moment and try again.'
  return `Meadow answered ${status}: ${detail}`
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

  mintWsToken(boardId: string): Promise<WsToken> {
    return this.call<WsToken>('/ws-token', { method: 'POST', body: { board_id: boardId } })
  }
}
