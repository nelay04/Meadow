import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { ThemeToggle } from '../../ui/ThemeToggle'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import type { Providers } from '../../lib/api'
import { useAuth } from './AuthContext'
import { OAUTH_PROVIDERS } from './providers'

type Mode = 'login' | 'register'

export default function LoginPage() {
  const { login, register, signInError, clearSignInError, signInNotice, clearSignInNotice } =
    useAuth()
  const [mode, setMode] = useState<Mode>('login')
  /*
   * Which third-party buttons to offer, if any.
   *
   * Null until the answer arrives, and the buttons are simply absent until then rather
   * than disabled: they appear once, in their final state, instead of flickering
   * through a state nobody can act on. A provider with no OAuth app configured never
   * shows up, because the endpoints behind its button are a 404 there.
   */
  const [providers, setProviders] = useState<Providers | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /*
   * What the screen says when nothing is wrong: an account waiting on its activation
   * mail. Held apart from `error` because it is the successful end of registering, and
   * painting it red would say the opposite of what happened.
   */
  const [notice, setNotice] = useState<string | null>(null)
  // The address a resend would go to. Set once an activation link is the thing standing
  // between this person and their account, and it is what the Resend button uses.
  const [awaiting, setAwaiting] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void api
      .getProviders()
      .then((available) => {
        if (!cancelled) setProviders(available)
      })
      .catch(() => {
        // The form still works. A sign-in method we cannot confirm is one we do not
        // offer, which is the same outcome as it being switched off.
        if (!cancelled) setProviders({ github: false, google: false })
      })
    return () => {
      cancelled = true
    }
  }, [])

  // A failed OAuth round trip comes back as a redirect, so its message is waiting in
  // the context by the time this screen mounts. Shown in the same place as a form
  // error, then taken off the context so it cannot reappear on a later visit.
  useEffect(() => {
    if (signInError === null) return
    setError(signInError)
    clearSignInError()
  }, [signInError, clearSignInError])

  // Same handover for the things that are not failures: an account created through a
  // provider, or a link that had already been used.
  useEffect(() => {
    if (signInNotice === null) return
    setNotice(signInNotice)
    clearSignInNotice()
  }, [signInNotice, clearSignInNotice])

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
    setNotice(null)
    setBusy(true)
    try {
      if (mode === 'login') {
        await login(email, password)
      } else {
        const pending = await register(email, password, displayName)
        setAwaiting(pending.activation_required ? pending.email : null)
        setNotice(
          !pending.activation_required
            ? 'Account created. You can log in now.'
            : pending.activation_sent
              ? `Account created. Check the inbox for ${pending.email} and follow the activation link in the email - the account cannot be used until you do.`
              : `Account created, but the activation email could not be sent to ${pending.email}. Try sending it again.`,
        )
        // Straight to the form they will use next. The account exists; what is left is
        // the link in their inbox and then a login.
        setMode('login')
        setPassword('')
      }
    } catch (caught) {
      /*
       * The refusals are named now, so the message can be the instruction rather than
       * a shrug. The server's `detail` is matched on rather than reprinted: it is
       * wording for an API caller, and the sentence a person reads belongs here.
       */
      if (caught instanceof ApiError && caught.status === 403) {
        setAwaiting(email.trim())
        setError('That account is not activated yet. Check your email inbox for the activation link.')
      } else if (caught instanceof ApiError && caught.status === 401) {
        if (caught.message.includes('not registered')) {
          setError('No account uses that email yet. Register first.')
          setMode('register')
        } else if (caught.message.includes('no password')) {
          setError('That account signs in with GitHub or Google. Use the buttons below.')
        } else {
          setError('That email and password do not match.')
        }
      } else if (caught instanceof ApiError && caught.status === 409) {
        setError('That email is already registered. Log in instead.')
        setMode('login')
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

  const forgot = async () => {
    const address = email.trim()
    if (address === '') {
      // The link goes to an address, and only this form knows which one. Asking for it
      // beats sending nothing and saying nothing.
      setNotice(null)
      setError('Type your email address first, then press this again.')
      return
    }

    setBusy(true)
    try {
      await api.requestPasswordReset(address)
      setError(null)
      // Two things this sentence has to do at once: name the inbox to look in, and not
      // claim a mail was sent. The server does not say whether the account exists, so
      // neither does this - hence "if", and the instruction after it.
      setNotice(
        `Check the inbox for ${address}. If it has an account, an email with a link to set a new password is on its way, and the link expires in an hour.`,
      )
    } catch {
      setError('Could not send that. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const resend = async () => {
    if (awaiting === null) return
    setBusy(true)
    try {
      await api.resendActivation(awaiting)
      // The server says nothing about whether the address exists, so neither does this.
      setError(null)
      setNotice(
        `Check the inbox for ${awaiting}. If that account is waiting to be activated, another activation email is on its way.`,
      )
    } catch {
      setError('Could not send that. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  const offered = OAUTH_PROVIDERS.filter((provider) => providers?.[provider.id] === true)

  const switchMode = (next: Mode) => {
    if (next === mode) return
    setMode(next)
    setError(null)
    setNotice(null)
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        <p className="tagline">Think Beyond the horizon...</p>

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
            {/* The action sits with the field it acts on, at the end of its own label
                row: a forgotten password is remembered while looking at the password
                box, not at the bottom of the form. */}
            <span className="label-row">
              Password
              {mode === 'login' && (
                <button
                  type="button"
                  className="label-action"
                  disabled={busy}
                  onClick={() => void forgot()}
                >
                  Forgot password?
                </button>
              )}
            </span>
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
          {notice !== null && <p className="notice">{notice}</p>}
          {awaiting !== null && (
            <button type="button" className="ghost" disabled={busy} onClick={() => void resend()}>
              Send the activation email again
            </button>
          )}

          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Working...' : mode === 'login' ? 'Log in' : 'Create account'}
          </button>
        </form>

        {/*
          * On both tabs, and the intent goes with the button. The same round trip means
          * "make me an account" under Register and "let me in" under Log in, and the
          * server refuses the mismatch either way rather than guessing.
          */}
        {offered.length > 0 && (
          <>
            <div className="auth-divider">
              <span>or</span>
            </div>

            {/* A link's job, done by buttons because they are form controls here.
                Deliberately a full page navigation and not a fetch: the OAuth flow
                leaves the site, and the session it returns with is set by the browser
                from the callback's redirect. */}
            <div className="auth-oauth">
              {offered.map(({ id, label, Icon }) => (
                <button
                  key={id}
                  type="button"
                  className="oauth-btn"
                  onClick={() => {
                    location.href = api.oauthSignInUrl(id, { intent: mode })
                  }}
                >
                  <Icon size={18} />
                  {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </main>
  )
}
