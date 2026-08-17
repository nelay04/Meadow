import { useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { ApiError } from '../../lib/api'
import { useAuth } from './AuthContext'

type Mode = 'login' | 'register'

export default function LoginPage() {
  const { login, register } = useAuth()
  const [mode, setMode] = useState<Mode>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

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

        <div className="auth-divider">
          <span>or</span>
        </div>

        <div className="auth-oauth">
          <button type="button" className="oauth-btn" onClick={() => undefined}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23Z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84Z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53Z" />
            </svg>
            Google
          </button>
          <button type="button" className="oauth-btn" onClick={() => undefined}>
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="currentColor">
              <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
            </svg>
            GitHub
          </button>
        </div>
      </div>
    </main>
  )
}
