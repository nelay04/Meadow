import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import * as api from '../../lib/api'
import type { ProfilePatch, User } from '../../lib/api'
import { providerLabel } from './providers'

type AuthState = {
  user: User | null
  /** True until the initial refresh-cookie exchange settles, so the UI can wait. */
  loading: boolean
  /** True only after a successful login() or register() call, never on session restore. */
  freshLogin: boolean
  clearFreshLogin: () => void
  /**
   * Why a third-party sign-in did not finish, in words. Set when the browser comes
   * back from the callback with an error, and cleared once the login screen has
   * shown it.
   */
  signInError: string | null
  clearSignInError: () => void
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
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
  state: () => 'That sign-in link expired. Try again.',
  unverified_email: (who) =>
    `Your ${who} account has no verified email address. Verify one on ${who}, then try again.`,
  conflict: (who) => `That email is already signed in with a different ${who} account.`,
  provider: (who) => `${who} could not be reached. Try again in a moment.`,
}

/**
 * Read the markers the OAuth callback left in the query string, and remove them.
 *
 * They are stripped with `replaceState` rather than left in place: a reload should
 * not replay the splash screen, and a shared URL should not carry the trace of
 * somebody else's sign-in. The hash is preserved untouched - it is the app's route,
 * and the callback puts the destination there.
 */
function takeCallbackMarkers(): { signedIn: boolean; error: string | null } {
  const params = new URLSearchParams(location.search)
  const signedIn = params.get('auth') !== null
  const code = params.get('auth_error')
  const who = providerLabel(params.get('provider') ?? '')
  if (!signedIn && code === null) return { signedIn: false, error: null }

  params.delete('auth')
  params.delete('auth_error')
  params.delete('provider')
  const query = params.toString()
  history.replaceState(null, '', `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`)

  return {
    signedIn,
    error: code === null ? null : (SIGN_IN_ERRORS[code]?.(who) ?? `${who} sign-in did not finish.`),
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)
  const [freshLogin, setFreshLogin] = useState(false)
  const [signInError, setSignInError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // Read before the await, so a re-render cannot see the markers twice.
    const markers = takeCallbackMarkers()
    if (markers.error !== null) setSignInError(markers.error)

    // The access token was in memory and is gone after a reload. The httpOnly refresh
    // cookie is not, so trade it for a new session before deciding to show the login
    // form - otherwise every refresh looks like a logout. A third-party sign-in lands
    // here too: the callback set that cookie on its way through, and this is what
    // turns it into a session.
    void api.restoreSession().then((restored) => {
      if (cancelled) return
      setUser(restored)
      // Coming back from a provider is a login, so it gets the same welcome as one.
      if (markers.signedIn && restored !== null) setFreshLogin(true)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password))
    setFreshLogin(true)
  }, [])

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      setUser(await api.register(email, password, displayName))
      setFreshLogin(true)
    },
    [],
  )

  // The response is the whole updated user, so the context takes it as-is rather than
  // merging a guess about what the server did with the patch.
  const updateProfile = useCallback(async (patch: ProfilePatch) => {
    setUser(await api.updateProfile(patch))
  }, [])

  const clearFreshLogin = useCallback(() => setFreshLogin(false), [])
  const clearSignInError = useCallback(() => setSignInError(null), [])

  const logout = useCallback(async () => {
    await api.logout()
    setUser(null)
    setFreshLogin(false)
  }, [])

  const value = useMemo(
    () => ({
      user,
      loading,
      freshLogin,
      clearFreshLogin,
      signInError,
      clearSignInError,
      login,
      register,
      updateProfile,
      logout,
    }),
    [
      user,
      loading,
      freshLogin,
      clearFreshLogin,
      signInError,
      clearSignInError,
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
