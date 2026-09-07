import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'

import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import type { AuthSession, ProfilePatch, RegistrationPending, User } from '../../lib/api'
import { providerLabel } from './providers'

type AuthState = {
  user: User | null
  /** True until the initial refresh-cookie exchange settles, so the UI can wait. */
  loading: boolean
  /**
   * True only for the sign-in that created the account: a register() call, or an OAuth
   * round trip the server marked as a first one. Never on a return visit, and never on
   * session restore. The splash video is a welcome, and a welcome shown on every login
   * is a loading screen with a video in it.
   */
  justRegistered: boolean
  clearJustRegistered: () => void
  /**
   * Why a third-party sign-in did not finish, in words. Set when the browser comes
   * back from the callback with an error, and cleared once the login screen has
   * shown it.
   */
  signInError: string | null
  clearSignInError: () => void
  /**
   * A thing that happened and is not a failure: an account created and waiting on its
   * activation mail, or a link that had already been used. Same lifecycle as the error.
   */
  signInNotice: string | null
  clearSignInNotice: () => void
  /**
   * Every browser signed in to this account, or null before the first frame arrives.
   *
   * Lives here rather than on the profile page because the feed it comes from is not
   * a page's concern: it is also how this browser finds out it has been terminated,
   * which has to work whatever is on screen.
   */
  sessions: AuthSession[] | null
  /** Ask for the list once, for when the stream is not connected. */
  refreshSessions: () => Promise<void>
  login: (email: string, password: string) => Promise<void>
  /** Resolves with what the server said about the mail. Never signs in: see api.register. */
  register: (
    email: string,
    password: string,
    displayName: string,
  ) => Promise<RegistrationPending>
  updateProfile: (patch: ProfilePatch) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

/**
 * What the OAuth callback's `auth_error` codes mean to a person.
 *
 * The server sends codes rather than sentences because it is redirecting a browser,
 * not answering a caller, and the wording belongs on this side anyway. The provider
 * rides along in the query string so the sentence can name the button that failed,
 * which is the difference between "try again" and knowing which one to try.
 */
const SIGN_IN_ERRORS: Record<string, (who: string) => string> = {
  denied: (who) => `${who} sign-in was cancelled.`,
  no_account: (who) =>
    `No account uses that ${who} address yet. Register first, and you can register with` +
    ` ${who} itself.`,
  already_registered: (who) =>
    `That ${who} address already has an account. Log in instead.`,
  not_activated: () =>
    'That account is not activated yet. Check your email inbox for the activation link.',
  email_mismatch: (who) =>
    `That ${who} account uses a different email address, so it was not connected. Use the` +
    ` ${who} account whose verified email matches this one.`,
  session: () => 'Your session expired. Log in again, then try connecting.',
  state: () => 'That sign-in link expired. Try again.',
  unverified_email: (who) =>
    `Your ${who} account has no verified email address. Verify one on ${who}, then try again.`,
  conflict: (who) => `That email is already signed in with a different ${who} account.`,
  provider: (who) => `${who} could not be reached. Try again in a moment.`,
}

/** What the activation link's redirect can say, once it has been followed. */
const ACTIVATION_ERRORS: Record<string, string> = {
  expired: 'That activation link has expired. Ask for a new one below.',
  invalid: 'That activation link is not valid. Ask for a new one below.',
}

/**
 * Read the markers the OAuth callback left in the query string, and remove them.
 *
 * They are stripped with `replaceState` rather than left in place: a reload should
 * not replay the splash screen, and a shared URL should not carry the trace of
 * somebody else's sign-in. The hash is preserved untouched - it is the app's route,
 * and the callback puts the destination there.
 */
function takeCallbackMarkers(): {
  registered: boolean
  error: string | null
  notice: string | null
} {
  const params = new URLSearchParams(location.search)
  const signedIn = params.get('auth') !== null
  const code = params.get('auth_error')
  // A registration through a provider: the account exists and is waiting on its address,
  // exactly as one made with the form is.
  const pending = params.get('auth_pending')
  // A provider connected from the profile page. Not a sign-in: the session is the one
  // that was already there.
  const linked = params.get('auth_linked')
  const activated = params.get('activated')
  const activationError = params.get('activation_error')
  const who = providerLabel(params.get('provider') ?? '')

  const touched =
    signedIn ||
    code !== null ||
    pending !== null ||
    linked !== null ||
    activated !== null ||
    activationError !== null
  if (!touched) return { registered: false, error: null, notice: null }

  for (const marker of [
    'auth',
    'auth_error',
    'auth_pending',
    'auth_linked',
    'activated',
    'activation_error',
    'provider',
  ]) {
    params.delete(marker)
  }
  const query = params.toString()
  history.replaceState(null, '', `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`)

  let notice: string | null = null
  if (pending === 'registered') {
    notice = `Account created with ${who}. Check your email inbox and follow the activation link to finish.`
  } else if (pending === 'registered_nomail') {
    notice = `Account created with ${who}, but the activation email could not be sent. Ask for it again below.`
  } else if (linked !== null) {
    notice = `${providerLabel(linked)} connected.`
  } else if (activated === 'already') {
    notice = 'That account is already activated. Log in below.'
  }

  return {
    // The splash greets a new account, and activation is the moment one opens.
    registered: activated === '1',
    error:
      code !== null
        ? (SIGN_IN_ERRORS[code]?.(who) ?? `${who} sign-in did not finish.`)
        : activationError !== null
          ? (ACTIVATION_ERRORS[activationError] ?? 'That activation link did not work.')
          : null,
    notice,
  }
}

/**
 * How long a "you were signed out" toast stays up.
 *
 * Longer than the 7s an ordinary error gets. Every other toast in the app comments on
 * something the reader just did and is already looking at; this one arrives at a tab
 * nobody has touched, explains why the screen in front of them has changed to a login
 * form, and is the only account of it they will get.
 */
const SIGNED_OUT_TOAST_MS = 12000

export function AuthProvider({ children }: { children: ReactNode }) {
  const toast = useToast()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [justRegistered, setJustRegistered] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)
  const [signInNotice, setSignInNotice] = useState<string | null>(null)
  const [sessions, setSessions] = useState<AuthSession[] | null>(null)
  // Held in a ref so `logout` can close the feed without the effect that owns it
  // having to re-run, which would tear down and rebuild the connection on every render.
  const streamRef = useRef<EventSource | null>(null)

  useEffect(() => {
    let cancelled = false
    // Read before the await, so a re-render cannot see the markers twice.
    const markers = takeCallbackMarkers()
    if (markers.error !== null) setSignInError(markers.error)
    if (markers.notice !== null) setSignInNotice(markers.notice)

    // The access token was in memory and is gone after a reload. The httpOnly refresh
    // cookie is not, so trade it for a new session before deciding to show the login
    // form - otherwise every refresh looks like a logout. A third-party sign-in lands
    // here too: the callback set that cookie on its way through, and this is what
    // turns it into a session.
    void api.restoreSession().then((restored) => {
      if (cancelled) return
      setUser(restored)
      // Activation is where a registration finishes, and it is the one moment that
      // earns the welcome. A plain sign-in does not.
      if (markers.registered && restored !== null) setJustRegistered(true)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /*
   * The live sessions feed.
   *
   * Open for as long as somebody is signed in, whatever page they are on. Two things
   * arrive on it and only one of them is about the profile screen: `sessions` is the
   * list, and `terminated` is this browser being told its own session has been ended
   * somewhere else. The second is why this is in the provider rather than in
   * `ProfilePage` - a browser signed out from another device has to find out while it
   * is sitting on a board doing nothing, which is exactly the case where nothing else
   * would ever ask the server a question.
   */
  useEffect(() => {
    if (user === null) {
      setSessions(null)
      return
    }

    const source = new EventSource(api.SESSIONS_STREAM_URL, { withCredentials: true })
    streamRef.current = source

    source.addEventListener('sessions', (event) => {
      setSessions(JSON.parse((event as MessageEvent<string>).data) as AuthSession[])
    })

    source.addEventListener('terminated', () => {
      // Closed first. The server has already refused this browser's credentials, so a
      // reconnect would be a retry loop against a door that is shut.
      source.close()
      streamRef.current = null
      api.clearAccessToken()
      setSessions(null)
      setUser(null)
      /*
       * Red, and said out loud rather than left on the login screen.
       *
       * This is not a notice about something the reader chose. Their tab was open and
       * untouched and the page under them has just become a login form; without an
       * explanation that reads as the app having crashed and dropped the session. Error
       * rather than info because somebody else ended this session, which is either
       * something the reader did from their own other device a moment ago - in which
       * case the sentence confirms it - or something they need to know about.
       */
      toast.error('You were signed out. This session was terminated from another device.', {
        life: SIGNED_OUT_TOAST_MS,
      })
    })

    source.onerror = () => {
      /*
       * Two very different things arrive here. A dropped connection leaves the source
       * in CONNECTING and the browser retries on its own, which is the whole reason to
       * use `EventSource` - nothing to do. CLOSED means the browser gave up, which per
       * the spec is what a non-200 does, and the likeliest non-200 is the session
       * having ended while the connection was down. So ask: if the refresh cookie
       * still buys a session, this was a blip; if it does not, this browser is signed
       * out and has simply missed being told.
       */
      if (source.readyState !== EventSource.CLOSED) return
      streamRef.current = null
      void api.restoreSession().then((restored) => {
        if (restored !== null) return
        api.clearAccessToken()
        setSessions(null)
        setUser(null)
        // Deliberately vaguer than the message above. Arriving here means the session
        // ended while this browser was not connected, and the reason is not knowable
        // from here: terminated, logged out on this device in another tab, or simply
        // expired. Naming the wrong one would be worse than naming none.
        toast.error('You were signed out. This session is no longer active.', {
          life: SIGNED_OUT_TOAST_MS,
        })
      })
    }

    return () => {
      source.close()
      streamRef.current = null
    }
    // Keyed on the id, not the object: editing a display name replaces `user` and must
    // not drop and reopen the connection. `toast` is a stable value from its provider.
  }, [user?.id, toast])

  /** The list, asked for directly. The fallback for a browser with no working stream. */
  const refreshSessions = useCallback(async () => {
    setSessions(await api.listSessions())
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password))
  }, [])

  // No `setUser` and no splash: registering now ends at "check your mail", and the
  // welcome belongs to the moment the account actually opens, which is activation.
  const register = useCallback(
    (email: string, password: string, displayName: string) =>
      api.register(email, password, displayName),
    [],
  )

  // The response is the whole updated user, so the context takes it as-is rather than
  // merging a guess about what the server did with the patch.
  const updateProfile = useCallback(async (patch: ProfilePatch) => {
    setUser(await api.updateProfile(patch))
  }, [])

  const clearJustRegistered = useCallback(() => setJustRegistered(false), [])
  const clearSignInError = useCallback(() => setSignInError(null), [])
  const clearSignInNotice = useCallback(() => setSignInNotice(null), [])

  const logout = useCallback(async () => {
    // Before the request, not after. Logging out revokes this session, so the server
    // ends the stream from its side; closing first means the client never sees that as
    // an error worth investigating.
    streamRef.current?.close()
    streamRef.current = null
    await api.logout()
    setSessions(null)
    setUser(null)
    setJustRegistered(false)
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      justRegistered,
      clearJustRegistered,
      signInError,
      clearSignInError,
      signInNotice,
      clearSignInNotice,
      sessions,
      refreshSessions,
      login,
      register,
      updateProfile,
      logout,
    }),
    [
      user,
      loading,
      justRegistered,
      clearJustRegistered,
      signInError,
      clearSignInError,
      signInNotice,
      clearSignInNotice,
      sessions,
      refreshSessions,
      login,
      register,
      updateProfile,
      logout,
    ],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  const context = use(AuthContext)
  if (context === null) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
