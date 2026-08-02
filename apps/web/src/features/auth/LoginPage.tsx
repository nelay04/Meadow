import { useState } from 'react'
import type { FormEvent } from 'react'

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

  return (
    <main className="auth">
      <h1>Meadow</h1>
      <p className="tagline">An infinite canvas for notes and whiteboarding.</p>

      <form onSubmit={submit}>
        {mode === 'register' && (
          <label>
            Display name
            <input
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              autoComplete="name"
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
            required
          />
        </label>

        {error !== null && <p className="error">{error}</p>}

        <button type="submit" disabled={busy}>
          {busy ? 'Working...' : mode === 'login' ? 'Log in' : 'Create account'}
        </button>
      </form>

      <button
        type="button"
        className="link"
        onClick={() => {
          setMode(mode === 'login' ? 'register' : 'login')
          setError(null)
        }}
      >
        {mode === 'login' ? 'Need an account? Register' : 'Already have an account? Log in'}
      </button>
    </main>
  )
}
