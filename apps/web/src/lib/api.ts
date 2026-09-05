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

/** Who a board is open to. `public` means the share link opens it for anybody. */
export type ShareMode = 'restricted' | 'public'

export type Board = {
  id: string
  workspace_id: string
  title: string
  kind: BoardKind
  is_archived: boolean
  created_at: string
  updated_at: string
  role: BoardRole
  share_mode: ShareMode
  /** What the public link hands out. Only ever 'viewer' or 'editor'. */
  share_role: BoardRole
  /** The owner's board-wide edit lock. Distinct from the per-tab one in the client. */
  is_locked: boolean
  locked_by: string | null
  /**
   * Role permits writing *and* the board is not locked.
   *
   * Read this rather than deriving it. The server answers it in one place, the same
   * place the websocket handshake answers it, and a second implementation on this side
   * is the shape of bug ARCHITECTURE 7 warns about for roles.
   */
  can_write: boolean
}

/**
 * A board in the trash.
 *
 * Not a `Board` with a flag. Everything on a board that is about opening it - the
 * lock, `can_write`, what its link hands out - is meaningless here, because a board in
 * the trash cannot be opened by anybody including its owner. What it has instead is
 * when it went and when it stops being recoverable, both decided by the server.
 */
export type TrashedBoard = {
  id: string
  workspace_id: string
  title: string
  kind: BoardKind
  role: BoardRole
  created_at: string
  updated_at: string
  deleted_at: string
  deleted_by: string | null
  /** When it goes for good, as an ISO timestamp. The server's arithmetic, not ours. */
  purge_after: string
}

/** Deployment settings the client is allowed to know. Public; read before sign-in. */
export type AppConfig = {
  trash_retention_hours: number
}

export type WsToken = {
  token: string
  expires_in: number
  role: BoardRole
  can_write: boolean
  is_locked: boolean
}

/**
 * A board as it looks to somebody holding a share link and nothing else.
 *
 * Fewer fields than `Board` on purpose: a link visitor has no workspace, no history
 * with this board, and no business knowing either. Everything here is something they
 * are about to see on the canvas anyway.
 */
export type SharedBoard = {
  id: string
  title: string
  kind: BoardKind
  role: BoardRole
  is_locked: boolean
  can_write: boolean
}

export type BoardMember = {
  user_id: string
  email: string
  display_name: string
  role: BoardRole
  avatar_url: string | null
}

/**
 * An invitation waiting for an account to exist at an address.
 *
 * `link` is on every read, not just the one that created it. Nothing was mailed - see
 * the share dialog - so the owner holding this link is the only copy of it.
 */
export type BoardInvitation = {
  id: string
  email: string
  role: BoardRole
  link: string
  created_at: string
}

/**
 * Somebody waiting to be let in.
 *
 * The address is here beside the display name, and it is the field that matters: an
 * owner is being asked to recognise a person, and a display name is whatever that
 * person typed when they registered.
 */
export type BoardAccessRequest = {
  id: string
  user_id: string
  email: string
  display_name: string
  avatar_url: string | null
  /** What they asked for. A request, not a claim - the owner may grant something else. */
  role: BoardRole
  created_at: string
}

/**
 * The state of your own request, which is all somebody without access is told.
 *
 * No title, no owner, no member list: knowing a board id is not a relationship with
 * the board, and until somebody decides otherwise the only thing you are entitled to
 * know is what became of what you asked.
 */
export type MyAccessRequest = {
  status: 'none' | 'pending' | 'granted' | 'declined'
  role: BoardRole | null
  /**
   * Whether the board opens right now.
   *
   * The field the waiting screen actually watches. An owner may let somebody in by a
   * route that has nothing to do with the request - adding them to the members list,
   * or making the board public - and a screen watching only its own row would leave
   * them staring at "waiting" in front of an open door.
   */
  has_access: boolean
}

export type ShareState = {
  mode: ShareMode
  role: BoardRole
  /** The plain address. What "copy link" gives while sharing is restricted. */
  url: string
  /** The address with the capability on it, or null if the board has never been shared. */
  link_url: string | null
  is_locked: boolean
  members: BoardMember[]
  invitations: BoardInvitation[]
  /** People who have asked to be let in and are still waiting on an answer. */
  requests: BoardAccessRequest[]
}

/**
 * What happened to one address typed into the share dialog.
 *
 * - `granted`: there was an account. It has the role now, and has been mailed.
 * - `pending`: there was not. **Nothing was sent.** `link` is the invitation the owner
 *   passes on themselves.
 * - `member`: they already had exactly this role, so nothing changed and nothing was
 *   sent.
 */
export type InviteResult = {
  status: 'granted' | 'pending' | 'member'
  email: string
  role: BoardRole
  user_id: string | null
  display_name: string | null
  link: string | null
  /** False when the grant landed but the notice could not be sent. */
  mailed: boolean
}

/** What a `#/join/...` link shows, to somebody who probably has no account yet. */
export type JoinInvitation = {
  email: string
  title: string
  kind: BoardKind
  role: BoardRole
  status: 'pending' | 'accepted' | 'revoked'
  invited_by: string | null
}

/**
 * One browser signed in to this account.
 *
 * A session is a refresh-token family on the server, which is the same thing that
 * decides access - so this list is the live sessions themselves rather than a log
 * written beside them, and revoking a row really does lock that browser out.
 */
export type AuthSession = {
  id: string
  /** The browser reading this list. Exactly one row has it, and it cannot be revoked. */
  current: boolean
  browser: string | null
  os: string | null
  device: 'desktop' | 'mobile' | 'tablet' | 'unknown'
  /** "Firefox on Windows". Composed on the server so every screen words it the same. */
  label: string
  /** The raw header, for when the parse above is wrong about an unusual client. */
  user_agent: string | null
  ip: string | null
  /** When this browser signed in. Survives every token rotation since. */
  signed_in_at: string
  /**
   * When it last renewed its access token.
   *
   * The closest thing to activity the server actually witnesses: a browser sitting on
   * an open tab doing nothing never renews, and is honestly reported as idle.
   */
  last_active_at: string
  /** When it gets signed out for doing nothing, unless it renews first. */
  expires_at: string
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

/**
 * Every browser signed in to this account, most recently active first.
 *
 * The current one is marked by the server from the refresh cookie, which this call
 * cannot see and must not try to guess: the access token is deliberately blind to
 * which session issued it.
 */
export function listSessions(): Promise<AuthSession[]> {
  return call<AuthSession[]>('/auth/sessions')
}

/** End one other session. The server refuses the caller's own - log out instead. */
export function revokeSession(sessionId: string): Promise<void> {
  return call<void>(`/auth/sessions/${sessionId}`, { method: 'DELETE' })
}

/** Sign out everywhere else, keeping this browser. Answers with how many ended. */
export function revokeOtherSessions(): Promise<{ revoked: number }> {
  return call<{ revoked: number }>('/auth/sessions', { method: 'DELETE' })
}

/**
 * Where the live sessions feed lives.
 *
 * An `EventSource` cannot set an Authorization header, so this one endpoint
 * authenticates by the refresh cookie the browser attaches on its own. Same-origin, so
 * the cookie goes without any CORS credentials handling; the server refuses the request
 * outright when it is missing.
 */
export const SESSIONS_STREAM_URL = `${BASE}/auth/sessions/stream`

/** Throw away the in-memory access token, without telling the server anything. */
export function clearAccessToken(): void {
  accessToken = null
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

/**
 * The name the create dialog opens with.
 *
 * Asked for rather than made up here, because the generator has to check the names
 * already in the workspace and the client does not have that list in a form it could
 * trust. A failure is not fatal: the caller falls back to an empty field and the
 * server names the board on create as it always did.
 */
export function suggestBoardTitle(workspaceId: string): Promise<{ title: string }> {
  return call<{ title: string }>(`/boards/suggested-title?workspace_id=${workspaceId}`)
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

/**
 * Move a board to the trash. Owner only, and it is not the end of it.
 *
 * The name is unchanged because the gesture is: this is what the delete button has
 * always called. What changed is on the server, where the board is now recoverable
 * until its window runs out. `purgeBoard` is the one that cannot be taken back.
 */
export function deleteBoard(boardId: string): Promise<void> {
  return call<void>(`/boards/${boardId}`, { method: 'DELETE' })
}

/** Everything of yours in the trash, most recently deleted first. Owner only. */
export function listTrash(): Promise<TrashedBoard[]> {
  return call<TrashedBoard[]>('/boards/trash')
}

/** Take one back out. Answers with the board, which is what it is again. */
export function restoreBoard(boardId: string): Promise<Board> {
  return call<Board>(`/boards/${boardId}/restore`, { method: 'POST' })
}

/** Delete for good. Only works on a board that is already in the trash. */
export function purgeBoard(boardId: string): Promise<void> {
  return call<void>(`/boards/${boardId}/purge`, { method: 'DELETE' })
}

/**
 * How this deployment is configured, in the small part that concerns the client.
 *
 * Read once and shared, because it is the same answer for the whole session and two
 * views want it: the trash, which says how long things are kept, and a lea, whose own
 * page trash is swept against the same window.
 */
export function getAppConfig(): Promise<AppConfig> {
  return call<AppConfig>('/config')
}

export function getBoard(boardId: string): Promise<Board> {
  return call<Board>(`/boards/${boardId}`)
}

/**
 * A websocket credential for a signed-in caller.
 *
 * The share token rides along whenever the browser has one, because it can only ever
 * *raise* the answer: an editor link opens an editor connection for somebody whose
 * membership is viewer, and a viewer link never demotes an editor who follows it. An
 * anonymous visitor cannot call this at all and uses `mintGuestWsToken` instead.
 */
export function mintWsToken(boardId: string, linkToken: string | null): Promise<WsToken> {
  return call<WsToken>('/ws-token', {
    method: 'POST',
    body: JSON.stringify({ board_id: boardId, link_token: linkToken }),
  })
}

/** A websocket credential for somebody with no account, holding a public link. */
export function mintGuestWsToken(linkToken: string): Promise<WsToken> {
  return call<WsToken>(`/share/${encodeURIComponent(linkToken)}/ws-token`, {
    method: 'POST',
  })
}

/**
 * Set the board-wide lock. Owner only; the server refuses anyone else.
 *
 * It stops the owner too, which is the point: this locks the document rather than
 * holding other people off it.
 */
export function setBoardLock(boardId: string, locked: boolean): Promise<Board> {
  return call<Board>(`/boards/${boardId}`, {
    method: 'PATCH',
    body: JSON.stringify({ is_locked: locked }),
  })
}

// --- sharing ---

/** Everything the share dialog draws, in one response. Owner only. */
export function getShare(boardId: string): Promise<ShareState> {
  return call<ShareState>(`/boards/${boardId}/share`)
}

/** Set who may open the board and what they get. Mints the link on first going public. */
export function setShare(
  boardId: string,
  mode: ShareMode,
  role: BoardRole,
): Promise<ShareState> {
  return call<ShareState>(`/boards/${boardId}/share`, {
    method: 'PUT',
    body: JSON.stringify({ mode, role }),
  })
}

/** Replace the link, breaking every copy of the old one. Its own action for that reason. */
export function rotateShareLink(boardId: string): Promise<ShareState> {
  return call<ShareState>(`/boards/${boardId}/share/rotate`, { method: 'POST' })
}

/** Invite one address. The server decides which of the two routes it takes. */
export function inviteToBoard(
  boardId: string,
  email: string,
  role: BoardRole,
): Promise<InviteResult> {
  return call<InviteResult>(`/boards/${boardId}/invites`, {
    method: 'POST',
    body: JSON.stringify({ email, role }),
  })
}

/** Withdraw an invitation nobody has accepted yet. */
export function revokeInvitation(boardId: string, invitationId: string): Promise<void> {
  return call<void>(`/boards/${boardId}/invites/${invitationId}`, { method: 'DELETE' })
}

/** Change one member's role, or add one. This is the demote path; inviting never lowers. */
export function setMemberRole(
  boardId: string,
  userId: string,
  role: BoardRole,
): Promise<BoardMember> {
  return call<BoardMember>(`/boards/${boardId}/members`, {
    method: 'POST',
    body: JSON.stringify({ user_id: userId, role }),
  })
}

export function removeMember(boardId: string, userId: string): Promise<void> {
  return call<void>(`/boards/${boardId}/members/${userId}`, { method: 'DELETE' })
}

/**
 * Ask to be let in to a board you only have the address of.
 *
 * The one board call that works without any access to the board, which is the point of
 * it. It grants nothing and reveals nothing: a board that does not exist answers
 * exactly as one that does, so this cannot be used to find out which ids are real.
 */
export function requestAccess(boardId: string, role: BoardRole): Promise<MyAccessRequest> {
  return call<MyAccessRequest>(`/boards/${boardId}/access-requests`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  })
}

/** Who is waiting to be let in. Owner only. */
export function listAccessRequests(boardId: string): Promise<BoardAccessRequest[]> {
  return call<BoardAccessRequest[]>(`/boards/${boardId}/access-requests`)
}

/** What became of your request. Polled by the waiting screen. */
export function getMyAccessRequest(boardId: string): Promise<MyAccessRequest> {
  return call<MyAccessRequest>(`/boards/${boardId}/access-requests/mine`)
}

/**
 * Let somebody in, or turn them down.
 *
 * `role` overrides what they asked for, so an owner can answer a request to edit with
 * view access rather than having to refuse it. Answers with the whole share state,
 * like every other write in the dialog.
 */
export function decideAccessRequest(
  boardId: string,
  requestId: string,
  approve: boolean,
  role?: BoardRole,
): Promise<ShareState> {
  return call<ShareState>(`/boards/${boardId}/access-requests/${requestId}`, {
    method: 'POST',
    body: JSON.stringify(role === undefined ? { approve } : { approve, role }),
  })
}

/**
 * What a share link opens, for a caller holding nothing else.
 *
 * The fallback when `getBoard` 403s: a signed-in non-member on a public board is
 * refused by the members-only route and welcomed by this one.
 */
export function getSharedBoard(linkToken: string): Promise<SharedBoard> {
  return call<SharedBoard>(`/share/${encodeURIComponent(linkToken)}`)
}

/** What a `#/join/...` link says. Unauthenticated: its audience has no account yet. */
export function getInvitation(token: string): Promise<JoinInvitation> {
  return call<JoinInvitation>(`/invites/${encodeURIComponent(token)}`)
}

/**
 * Redeem an invitation for the account signed in right now.
 *
 * Rarely needed. Invitations apply themselves when an account opens at the address
 * they name, so this is for the person who already had an account when they were
 * invited - or who was invited at a second address they also own.
 */
export function acceptInvitation(token: string): Promise<Board> {
  return call<Board>(`/invites/${encodeURIComponent(token)}/accept`, { method: 'POST' })
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
 * Drop a board preview.
 *
 * Called when the board has been emptied: a stale picture of objects that are gone is
 * worse than no picture at all.
 */
export function deleteThumbnail(boardId: string): Promise<void> {
  return call<void>(`/boards/${boardId}/thumbnail`, { method: 'DELETE' })
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
