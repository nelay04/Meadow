/**
 * The share token the browser arrived with, if it arrived with one.
 *
 * A public link is `https://host/?k=<token>#/glade/<id>`: the capability in the query
 * string, the route in the fragment. Query rather than fragment because the fragment
 * is already the route and burying a second thing inside it is how one of them ends up
 * truncated by the next tool that touches the URL - and because a share link is pasted
 * into chat apps and social cards, which normalise URLs and are much better behaved
 * about `?k=` than about anything after a `#`.
 *
 * Read once, at load, and kept in a module variable. It is deliberately *not* stripped
 * from the address bar the way the OAuth callback markers are: those are the residue of
 * a redirect and mean nothing on a reload, while this one is how the page gets in.
 * Removing it would make refreshing a shared board log you out of it.
 *
 * Not a secret to hide from this file, either. Anyone reading it already has the link.
 */

const KEY = 'k'

let token: string | null = null

function read(): string | null {
  const raw = new URLSearchParams(location.search).get(KEY)
  if (raw === null) return null
  const trimmed = raw.trim()
  // The server bounds this at 128 too. Refusing an obviously wrong value here saves a
  // request and, more usefully, stops a pasted essay being sent as a credential.
  return trimmed === '' || trimmed.length > 128 ? null : trimmed
}

/*
 * Signing in with a provider leaves the site and returns with only a hash route, so the
 * token is held in this tab's session storage across the trip and put back in the
 * address bar on return. It is only restored onto the same route it was held for.
 */
const HELD_KEY = 'meadow-share-held'

export function holdForSignIn(): void {
  if (token === null) return
  try {
    sessionStorage.setItem(HELD_KEY, JSON.stringify({ token, hash: location.hash }))
  } catch {
    // Without storage a provider sign-in lands on the app instead of this board.
  }
}

function takeHeld(): string | null {
  try {
    const raw = sessionStorage.getItem(HELD_KEY)
    if (raw === null) return null
    sessionStorage.removeItem(HELD_KEY)
    const held: unknown = JSON.parse(raw)
    if (typeof held !== 'object' || held === null) return null
    const { token: value, hash } = held as { token?: unknown; hash?: unknown }
    if (typeof value !== 'string' || hash !== location.hash) return null
    if (value === '' || value.length > 128) return null
    return value
  } catch {
    return null
  }
}

function restore(value: string): string {
  const params = new URLSearchParams(location.search)
  params.set(KEY, value)
  history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`)
  return value
}

const held = takeHeld()
const arrived = read()
token = arrived ?? (held === null ? null : restore(held))

/** The token in the address bar, or null. */
export function shareToken(): string | null {
  return token
}

/**
 * Forget the token for this session.
 *
 * Used when it turns out not to open anything: an expired or rotated link should stop
 * being presented on every subsequent request, or a signed-in member with a stale link
 * in their URL would keep sending a credential the server keeps rejecting. The address
 * bar is left alone, because the person may well want to see what they followed.
 */
export function clearShareToken(): void {
  token = null
}

/**
 * The address of a board, as something to hand to somebody else.
 *
 * Built from the current origin rather than asked for, so it is right in development,
 * behind a proxy, and on whatever host this happens to be served from - the server's
 * own `web_base_url` is a configured value and is wrong on any deployment where it has
 * not been kept in step.
 */
export function shareUrl(path: string, linkToken: string | null): string {
  const query = linkToken === null ? '' : `?${KEY}=${encodeURIComponent(linkToken)}`
  return `${location.origin}/${query}${path}`
}
