/**
 * REST client.
 *
 * The access token lives in a module variable and never touches localStorage
 * (ARCHITECTURE 7): anything readable by page JavaScript is readable by an XSS
 * payload. The refresh token is an httpOnly cookie the browser attaches on its own,
 * so this file never sees it.
 */

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer'

export type User = {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  default_workspace_id: string | null
}

export type Board = {
  id: string
  workspace_id: string
  title: string
  is_archived: boolean
  created_at: string
  updated_at: string
  role: BoardRole
}

export type WsToken = {
  token: string
  expires_in: number
  role: BoardRole
}

type AuthResponse = {
  access_token: string
  expires_in: number
  user: User
}

export class ApiError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'ApiError'
  }
}

const BASE = '/api/v1'

let accessToken: string | null = null

export function setAccessToken(token: string | null): void {
  accessToken = token
}

export function hasAccessToken(): boolean {
  return accessToken !== null
}

async function request(path: string, init: RequestInit): Promise<Response> {
  const headers = new Headers(init.headers)
  if (init.body !== undefined) headers.set('content-type', 'application/json')
  if (accessToken !== null) headers.set('authorization', `Bearer ${accessToken}`)
  return fetch(`${BASE}${path}`, { ...init, headers, credentials: 'same-origin' })
}

/**
 * Single-flight refresh. This is correctness, not an optimisation.
 *
 * Refresh tokens rotate on every use and reuse of a rotated one revokes the whole
 * family. Two requests 401-ing at once would each POST /auth/refresh; the second
 * presents a token the first already spent, the server reads that as theft, and the
 * user is logged out of a working session.
 */
let inFlightRefresh: Promise<boolean> | null = null

async function refreshSession(): Promise<boolean> {
  inFlightRefresh ??= (async () => {
    try {
      const response = await request('/auth/refresh', { method: 'POST' })
      if (!response.ok) {
        accessToken = null
        return false
      }
      const body = (await response.json()) as { access_token: string }
      accessToken = body.access_token
      return true
    } finally {
      inFlightRefresh = null
    }
  })()
  return inFlightRefresh
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  let response = await request(path, init)

  // One retry, and only for the access token having aged out mid-session. A 401 on
  // the refresh call itself means the session is genuinely over.
  if (response.status === 401 && !path.startsWith('/auth/refresh')) {
    if (await refreshSession()) {
      response = await request(path, init)
    }
  }

  if (!response.ok) {
    const detail = await response.text()
    throw new ApiError(response.status, detail || response.statusText)
  }
  if (response.status === 204) return undefined as T
  return (await response.json()) as T
}

// --- auth ---

export async function register(
  email: string,
  password: string,
  displayName: string,
): Promise<User> {
  const body = await call<AuthResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: displayName }),
  })
  accessToken = body.access_token
  return body.user
}

export async function login(email: string, password: string): Promise<User> {
  const body = await call<AuthResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
  accessToken = body.access_token
  return body.user
}

export async function logout(): Promise<void> {
  await call<void>('/auth/logout', { method: 'POST' })
  accessToken = null
}

/**
 * Restore a session on page load. The access token is gone (it was in memory), but
 * the refresh cookie survived, so this trades it for a new one.
 */
export async function restoreSession(): Promise<User | null> {
  if (!(await refreshSession())) return null
  try {
    return await call<User>('/auth/me')
  } catch {
    accessToken = null
    return null
  }
}

// --- boards ---

export function listBoards(archived = false): Promise<Board[]> {
  return call<Board[]>(`/boards?archived=${archived}`)
}

export function createBoard(workspaceId: string, title: string): Promise<Board> {
  return call<Board>('/boards', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId, title }),
  })
}

export function deleteBoard(boardId: string): Promise<void> {
  return call<void>(`/boards/${boardId}`, { method: 'DELETE' })
}

export function getBoard(boardId: string): Promise<Board> {
  return call<Board>(`/boards/${boardId}`)
}

export function mintWsToken(boardId: string): Promise<WsToken> {
  return call<WsToken>('/ws-token', {
    method: 'POST',
    body: JSON.stringify({ board_id: boardId }),
  })
}
