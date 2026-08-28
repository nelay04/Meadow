/**
 * REST client.
 *
 * The access token lives in a module variable and never touches localStorage
 * (ARCHITECTURE 7): anything readable by page JavaScript is readable by an XSS
 * payload. The refresh token is an httpOnly cookie the browser attaches on its own,
 * so this file never sees it.
 */

export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer'

/** The third-party sign-ins this app knows how to offer. */
export type OAuthProvider = 'github' | 'google'

/**
 * A provider's copy of the user, read-only.
 *
 * Separate from the account's own fields on purpose: `display_name` and `avatar_url`
 * are what the person chose here, and these are what the provider says. The profile
 * page shows both, and only ever writes the first kind.
 */
export type Identity = {
  provider: string
  /** GitHub's login. Google has no handle, so this is the email address there. */
  username: string
  name: string | null
  email: string | null
  avatar_url: string | null
  profile_url: string | null
  linked_at: string
}

export type User = {
  id: string
  email: string
  display_name: string
  avatar_url: string | null
  /** 'none' for initials, otherwise the provider `avatar_url` came from. */
  avatar_source: string
  /** False for an account created through a provider that never set a password. */
  has_password: boolean
  /**
   * Linked accounts, keyed by provider. Partial because a provider that is not linked
   * is absent rather than null, so every read has to be a lookup that may miss.
   */
  identities: Partial<Record<OAuthProvider, Identity>>
  default_workspace_id: string | null
}

export type Providers = Record<OAuthProvider, boolean>

/** What registering answers with: an account waiting on its address, not a session. */
export type RegistrationPending = {
  email: string
  /** False only where the deployment has no SMTP and opened the account immediately. */
  activation_required: boolean
  /** False when the relay refused, so the client can offer to send it again. */
  activation_sent: boolean
}

export type ProfilePatch = {
  display_name?: string
  avatar_source?: 'none' | OAuthProvider
}

/**
 * What paper a glade is drawn on. Never what editor it opens in: every kind is the
 * same infinite canvas over the same document. See `features/boards/kinds.ts`, which
 * is where a kind becomes a label, an icon and a canvas surface.
 */
export type BoardKind = 'glade' | 'lea'

export type Board = {
  id: string
  workspace_id: string
  title: string
  kind: BoardKind
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
  // JSON unless the caller said otherwise. The thumbnail upload sends image bytes and
  // sets its own type, and stamping application/json over it would be rejected.
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json')
  }
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

/**
 * Open an account. Does not sign in, and cannot: the account is unusable until the link
 * in the activation mail is followed, so there is no session to hand back yet.
 */
export function register(
  email: string,
  password: string,
  displayName: string,
): Promise<RegistrationPending> {
  return call<RegistrationPending>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ email, password, display_name: displayName }),
  })
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

/** Which third-party sign-ins this deployment can actually complete. */
export function getProviders(): Promise<Providers> {
  return call<Providers>('/auth/providers')
}

/**
 * Where a sign-in button points.
 *
 * A plain navigation, not a fetch: the flow leaves the site and comes back, and the
 * session it returns with arrives as an httpOnly cookie the browser sets on the
 * redirect. `next` is a hash route to return to; the server refuses anything else.
 */
export function oauthSignInUrl(
  provider: OAuthProvider,
  options: { next?: string; intent?: 'login' | 'register' | 'link' } = {},
): string {
  // The intent is which button was pressed: "register" may create an account, "link"
  // connects one to the account already signed in, and anything else is a sign-in. The
  // server reads it the same way and refuses the mismatch rather than guessing.
  const query = new URLSearchParams()
  if (options.next !== undefined) query.set('next', options.next)
  if (options.intent !== undefined) query.set('intent', options.intent)
  const suffix = query.toString()
  return `${BASE}/auth/${provider}/start${suffix === '' ? '' : `?${suffix}`}`
}

/**
 * Ask for a password reset link, or a first password on an account that has none.
 *
 * Always resolves, whether or not the address has an account: the server answers 204
 * either way, because it posts mail to an address the caller chose.
 */
export function requestPasswordReset(email: string): Promise<void> {
  return call<void>('/auth/password/reset-request', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

/**
 * Mail me a link to set or change my own password.
 *
 * The signed-in counterpart of `requestPasswordReset`, and unlike it this one reports
 * failure: it is the caller's own account, so there is nothing to keep quiet about, and
 * a screen saying "sent" when nothing was sent is worse than an error.
 */
export function requestPasswordChange(): Promise<void> {
  return call<void>('/auth/password/change-request', { method: 'POST' })
}

/**
 * Is this reset link still good? Asked before drawing the form, and it spends nothing.
 *
 * A link works exactly once, so without this a spent one would open a form that looks
 * alive and only fails after a password has been chosen and typed twice.
 */
export function checkResetLink(token: string): Promise<void> {
  return call<void>(`/auth/password/reset?token=${encodeURIComponent(token)}`)
}

/** Spend a reset link. Ends every session on the account, including this browser's. */
export function resetPassword(token: string, password: string): Promise<void> {
  return call<void>('/auth/password/reset', {
    method: 'POST',
    body: JSON.stringify({ token, password }),
  })
}

/** Ask for another activation link. Always resolves: the server says nothing either way. */
export function resendActivation(email: string): Promise<void> {
  return call<void>('/auth/activation/resend', {
    method: 'POST',
    body: JSON.stringify({ email }),
  })
}

export function updateProfile(patch: ProfilePatch): Promise<User> {
  return call<User>('/auth/me', { method: 'PATCH', body: JSON.stringify(patch) })
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

export function createBoard(
  workspaceId: string,
  title: string,
  kind: BoardKind = 'glade',
): Promise<Board> {
  return call<Board>('/boards', {
    method: 'POST',
    body: JSON.stringify({ workspace_id: workspaceId, title, kind }),
  })
}

/** Rename. Editor and above; the server is the authority, this only asks. */
export function renameBoard(boardId: string, title: string): Promise<Board> {
  return call<Board>(`/boards/${boardId}`, {
    method: 'PATCH',
    body: JSON.stringify({ title }),
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

/**
 * Store a board preview.
 *
 * Fire and forget at the call site: a failed thumbnail is a cosmetic problem, and it
 * must never interrupt whatever the user was doing when it was captured.
 */
export function putThumbnail(boardId: string, image: Blob): Promise<void> {
  return call<void>(`/boards/${boardId}/thumbnail`, {
    method: 'PUT',
    body: image,
    headers: { 'content-type': image.type || 'image/webp' },
  })
}

/**
 * Fetch a board preview as an object URL, or null if it has none yet.
 *
 * Not a plain `<img src>`: every endpoint is behind a Bearer token and an `img` tag
 * cannot send one, so pointing one at the path would 401 on every board in the list.
 * Callers must revoke the URL when the image is unmounted.
 */
export async function fetchThumbnail(boardId: string): Promise<string | null> {
  let response = await request(`/boards/${boardId}/thumbnail`, {})
  if (response.status === 401 && (await refreshSession())) {
    response = await request(`/boards/${boardId}/thumbnail`, {})
  }
  if (!response.ok) return null
  return URL.createObjectURL(await response.blob())
}
