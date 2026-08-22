import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { IconCheck } from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'

type Props = {
  token: string
  onDone: () => void
}

/**
 * The other end of the reset mail.
 *
 * Its own screen rather than a panel on the login card: the token is in the URL, so
 * arriving here is a different event from opening the app, and the form has one job.
 * The token never leaves the fragment on the way in - it is not in a request line any
 * proxy or access log could keep - and goes to the server in the POST body instead.
 */
export default function ResetPasswordPage({ token, onDone }: Props) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState(false)
  /*
   * Whether the link is worth a form at all. Undefined while asking, so the card shows
   * nothing rather than flashing a form that may be about to be replaced by a refusal.
   */
  const [usable, setUsable] = useState<boolean | undefined>(undefined)

  // A link works once. Checked on arrival rather than on submit, because finding out
  // after choosing a password and typing it twice is the worst moment to be told.
  useEffect(() => {
    let cancelled = false
    void api
      .checkResetLink(token)
      .then(() => {
        if (!cancelled) setUsable(true)
      })
      .catch((caught: unknown) => {
        if (cancelled) return
        setUsable(false)
        setError(
          caught instanceof ApiError && caught.message.includes('expired')
            ? 'That link has expired. Links last an hour, so ask for a new one.'
            : 'That link has already been used, or is not valid. Ask for a new one.',
        )
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const submit = async (event: FormEvent) => {
    event.preventDefault()

    if (password.length < 12) {
      setError('Use at least 12 characters.')
      return
    }
    // Checked here and not on the server: a mistyped new password is a typing problem,
    // and the server has no way to tell the difference between two fields anyway.
    if (password !== confirm) {
      setError('Those two do not match.')
      return
    }

    setError(null)
    setBusy(true)
    try {
      await api.resetPassword(token, password)
      setDone(true)
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 400) {
        setError(
          caught.message.includes('expired')
            ? 'That link has expired. Ask for a new one from the login screen.'
            : 'That link is not valid. Ask for a new one from the login screen.',
        )
      } else if (caught instanceof ApiError && caught.status === 422) {
        setError('Use at least 12 characters.')
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
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        {usable === undefined ? (
          <p className="tagline">Checking that link...</p>
        ) : usable === false ? (
          <div className="auth-done">
            <p className="auth-done-head auth-done-head-warn">Link no longer works</p>
            <p className="hint">{error}</p>
            <button type="button" className="primary" onClick={onDone}>
              Back to log in
            </button>
          </div>
        ) : done ? (
          /*
           * The card's own rhythm, not a shouted panel: a stated outcome, the consequence
           * in the quiet voice everything else on this screen explains itself in, and one
           * button the width of the form it replaces. The accent belongs on the mark and
           * the button, which is where the eye should land.
           */
          <div className="auth-done">
            <p className="auth-done-head">
              <IconCheck size={18} />
              Your password is set
            </p>
            <p className="hint">
              Every device signed in to this account has been signed out, including this
              one. Log in with your new password.
            </p>
            <button type="button" className="primary" onClick={onDone}>
              Go to log in
            </button>
          </div>
        ) : (
          <>
            <p className="tagline">Choose a new password for your account.</p>
            <form onSubmit={submit} noValidate>
              <label>
                New password
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  minLength={12}
                  placeholder="At least 12 characters"
                  required
                />
              </label>

              <label>
                Repeat it
                <input
                  type="password"
                  value={confirm}
                  onChange={(event) => setConfirm(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>

              {error !== null && <p className="error">{error}</p>}

              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Working...' : 'Set password'}
              </button>
            </form>
            <p className="hint">
              Setting a password signs out every device currently signed in to this
              account.
            </p>
          </>
        )}
      </div>
    </main>
  )
}
