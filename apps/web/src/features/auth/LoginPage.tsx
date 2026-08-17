import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { IconGitHub } from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import { useAuth } from './AuthContext'

type Mode = 'login' | 'register'

export default function LoginPage() {
  const { login, register, signInError, clearSignInError } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  /*
   * Whether to offer the GitHub button at all.
   *
   * Undefined until the answer arrives, and the button is simply absent until then
   * rather than disabled: it appears once, in its final state, instead of flickering
   * through a state nobody can act on. A deployment with no OAuth app configured
   * never shows it, because the endpoint behind it is a 404 there.
   */
  const [githubEnabled, setGithubEnabled] = useState<boolean | undefined>(undefined)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    void api
      .getProviders()
      .then((providers) => {
        if (!cancelled) setGithubEnabled(providers.github)
      })
      .catch(() => {
        // The form still works. A sign-in method we cannot confirm is one we do not
        // offer, which is the same outcome as it being switched off.
        if (!cancelled) setGithubEnabled(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // A failed GitHub round trip comes back as a redirect, so its message is waiting in
  // the context by the time this screen mounts. Shown in the same place as a form
  // error, then taken off the context so it cannot reappear on a later visit.
  useEffect(() => {
    if (signInError === null) return
    setError(signInError)
    clearSignInError()
  }, [signInError, clearSignInError])

  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (!email.trim() || !password) {
      setError('Please fill in all fields.')
      return
    }

    if (mode === 'register') {
      if (!displayName.trim()) {
        setError('Please fill in your display name.')
        return
      }
      if (password.length < 12) {
        setError('Password must be at least 12 characters.')
        return
      }
    }

    setError(null)
    setBusy(true)
    try {
      if (mode === 'login') await login(email, password)
      else await register(email, password, displayName)
    } catch (caught) {
      // The server deliberately does not say whether the email exists, so neither
      // does this. See the account-enumeration test.
      if (caught instanceof ApiError && caught.status === 401) {
        setError('That email and password do not match.')
      } else if (caught instanceof ApiError && caught.status === 409) {
        setError('Could not create that account.')
      } else if (caught instanceof ApiError && caught.status === 422) {
        setError('Check the email format, and use at least 12 characters for the password.')
      } else if (caught instanceof ApiError && caught.status === 429) {
        setError('Too many attempts. Wait a minute and try again.')
      } else {
        setError('Something went wrong. Try again.')
      }
    } finally {
      setBusy(false)
    }
  }

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        <p className="tagline">An infinite canvas for notes and whiteboarding.</p>

        {/* A segmented control rather than a sentence that behaves like a button.
            Both destinations are visible before the choice is made. */}
        <div className="segmented" role="group" aria-label="Account">
          <button type="button" aria-pressed={mode === 'login'} onClick={() => switchMode('login')}>
            Log in
          </button>
          <button
            type="button"
            aria-pressed={mode === 'register'}
            onClick={() => switchMode('register')}
          >
            Register
          </button>
        </div>

        <form onSubmit={submit} noValidate>
          {mode === 'register' && (
            <label>
              Display name
              <input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                autoComplete="name"
                placeholder="Your full name"
                required
              />
            </label>
          )}

          <label>
            Email
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              autoComplete="email"
              placeholder="you@creara.in"
              required
            />
          </label>

          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              minLength={mode === 'register' ? 12 : undefined}
              placeholder={mode === 'register' ? 'At least 12 characters' : ''}
              required
            />
          </label>

          {error !== null && <p className="error">{error}</p>}

          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Working...' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        {githubEnabled === true && (
          <>
            <div className="auth-divider">
              <span>or</span>
            </div>

            {/* A link's job, done by a button because it is a form control here.
                Deliberately a full page navigation and not a fetch: the OAuth flow
                leaves the site, and the session it returns with is set by the browser
                from the callback's redirect. */}
            <div className="auth-oauth">
              <button
                type="button"
                className="oauth-btn"
                onClick={() => {
                  location.href = api.githubSignInUrl()
                }}
              >
                <IconGitHub size={18} />
                Continue with GitHub
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
