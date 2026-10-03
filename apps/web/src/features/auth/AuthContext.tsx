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
  // The session as it stands, for the callbacks that need to know whether there is one
  // to lose without being rebuilt - and so resubscribing the feed - every time it changes.
  const userRef = useRef<User | null>(null)
  // Consecutive failures of the sessions feed, which is how long to wait before the
  // next attempt. Reset by a frame arriving.
  const attemptsRef = useRef(0)
  // Bumped to reopen the feed. The connection is owned by an effect, so asking for a
  // new one is a state change rather than a function call.
  const [feedEpoch, setFeedEpoch] = useState(0)

  useEffect(() => {
    userRef.current = user
  }, [user])

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
    void api.restoreSession().then((check) => {
      if (cancelled) return
      if (check.state === 'active') {
        setUser(check.user)
        // Activation is where a registration finishes, and it is the one moment that
        // earns the welcome. A plain sign-in does not.
        if (markers.registered) setJustRegistered(true)
      } else if (check.state === 'none') {
        setUser(null)
      }
      // `unknown` - the API unreachable - leaves `user` as it is. On this first pass
      // that is null and the login form is all there is to show, but the same call is
      // made again later against a live session, and there it must not end it.
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Give up the session this browser is holding, and say out loud why.
   *
   * `null` for the message means say nothing: the only caller that passes it is a page
   * the reader navigated back to themselves, where the login form appearing needs no
   * explaining and a red toast would be inventing a problem.
   */
  const signOut = useCallback(
    (message: string | null) => {
      streamRef.current?.close()
      streamRef.current = null
      api.clearAccessToken()
      setSessions(null)
      setUser(null)
      if (message !== null) toast.error(message, { life: SIGNED_OUT_TOAST_MS })
    },
    [toast],
  )

  /*
   * Ask the server again what this browser's session is, and act only on an answer.
   *
   * Two things call this, and both used to read "could not reach the API" as "signed
   * out". One is a page coming back out of the back/forward cache: it was frozen,
   * possibly showing a login form, and what happened while it was frozen is exactly
   * the thing it cannot know. The other is the sessions feed dropping.
   */
  const revalidate = useCallback(
    async (announce = true): Promise<api.SessionCheck['state']> => {
      const check = await api.restoreSession()
      if (check.state === 'active') {
        // The back button's fix lives in this line. A login screen restored from the
        // cache after a third-party sign-in finds the session that sign-in created,
        // instead of asking again for a password it no longer needs.
        setUser(check.user)
      } else if (check.state === 'none' && userRef.current !== null) {
        signOut(announce ? 'You were signed out. This session is no longer active.' : null)
      }
      return check.state
    },
    [signOut],
  )

  /*
   * A page restored from the back/forward cache, which is a load that runs no code.
   *
   * Pressing Back after signing in with a provider lands on the login screen as it
   * was before the round trip - a frozen DOM, with no session in it, for an account
   * that is now signed in. Nothing else in this app would ever correct that: there is
   * no render, no effect and no fetch on a restore. `persisted` is what separates it
   * from an ordinary load, which has already asked a few lines up.
   */
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return
      void revalidate(false)
    }
    window.addEventListener('pageshow', onPageShow)
    return () => window.removeEventListener('pageshow', onPageShow)
  }, [revalidate])

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
    let reopen: ReturnType<typeof setTimeout> | null = null
    // The check below is awaited, so it can land after this effect has been torn down.
    let stopped = false

    source.addEventListener('sessions', (event) => {
      // A frame arrived, so the feed works. The next failure backs off from the start
      // rather than from however far the last outage had got.
      attemptsRef.current = 0
      setSessions(JSON.parse((event as MessageEvent<string>).data) as AuthSession[])
    })

    source.addEventListener('terminated', () => {
      /*
       * Closed first. The server has already refused this browser's credentials, so a
       * reconnect would be a retry loop against a door that is shut.
       *
       * Red, and said out loud rather than left on the login screen. This is not a
       * notice about something the reader chose. Their tab was open and untouched and
       * the page under them has just become a login form; without an explanation that
       * reads as the app having crashed and dropped the session. Error rather than
       * info because somebody else ended this session, which is either something the
       * reader did from their own other device a moment ago - in which case the
       * sentence confirms it - or something they need to know about.
       */
      source.close()
      signOut('You were signed out. This session was terminated from another device.')
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
      source.close()
      streamRef.current = null
      /*
       * And a third thing, which this used to read as the second: the API being
       * unreachable. A deploy restarts it and nginx answers 502 for a second or two,
       * which ended the session in every open tab - a login screen that a reload
       * immediately undoes, and that reload is the tell that the session was fine all
       * along. So `revalidate` is allowed to answer "cannot tell", and only a real no
       * signs anybody out. The message it uses when it does is deliberately vaguer
       * than the one above: the session ended while this browser was not connected,
       * and whether it was terminated, logged out in another tab or simply expired is
       * not knowable from here. Naming the wrong one would be worse than naming none.
       */
      void revalidate().then((state) => {
        if (stopped || state === 'none') return
        // Signed in, or no way to tell. Either way this browser now has no feed, and
        // without one it would not hear about a real termination until a reload. So
        // reopen, backing off, rather than going deaf.
        const wait = Math.min(30_000, 1_000 * 2 ** attemptsRef.current)
        attemptsRef.current += 1
        reopen = setTimeout(() => setFeedEpoch((epoch) => epoch + 1), wait)
      })
    }

    return () => {
      stopped = true
      if (reopen !== null) clearTimeout(reopen)
      source.close()
      streamRef.current = null
    }
    // Keyed on the id, not the object: editing a display name replaces `user` and must
    // not drop and reopen the connection. `feedEpoch` is how a failed attempt asks for
    // the next one.
  }, [user?.id, feedEpoch, revalidate])

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
