/**
 * What a glade with a password on it looks like before you have typed it.
 *
 * A whole screen rather than a dialog over the canvas, and for the same reason
 * `AccessGate` is: nothing of the document may be rendered behind it. The board is not
 * loaded, the local copy is cleared on the way here, and there is nothing to see
 * through. A modal over a canvas showing yesterday's drawing would be a lock on a glass
 * door.
 *
 * It is deliberately the same screen for everybody. The owner who set the password sees
 * exactly this, because the password is in front of every role - see
 * `app/services/board_password.py` - and a screen that greeted the owner differently
 * would be the first place somebody looked for a way round it.
 *
 * The one thing it will not do is tell you whether you have access. Somebody who types
 * the right password and still has no role gets the ordinary refusal afterwards, from
 * the same place everyone else gets it: this screen answers one question, and running
 * two answers together here would make a wrong password and a missing grant look like
 * one problem.
 */

import { useState } from 'react'

import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import { rememberBoardPass } from '../../lib/boardPass'
import { Wordmark } from '../../ui/Brand'
import { IconLock } from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useAuth } from '../auth/AuthContext'

type Props = {
  boardId: string
  /** "glade" or "lea", lowercase. */
  noun: string
  /** The share token from the address bar, or null. */
  linkToken: string | null
  /** Try the connection again, now that a pass has been written. */
  onUnlocked: () => void
  /** Leave for the board list, or for the app itself when nobody is signed in. */
  onBack: () => void
}

export function PasswordGate({ boardId, noun, linkToken, onUnlocked, onBack }: Props) {
  const { user } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (password === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      /*
       * Two routes, and the split is the same one the ws-token mint makes: a signed-in
       * caller answers against their own account and whatever the link adds, and a
       * visitor with no account answers against the link alone. Guessing from a 401
       * instead would make every anonymous visit start with a refused request.
       */
      const pass =
        user === null && linkToken !== null
          ? await api.verifySharedBoardPassword(linkToken, password)
          : await api.verifyBoardPassword(boardId, password, linkToken)
      rememberBoardPass(boardId, pass.pass_token)
      // Cleared before leaving, so a password does not sit in a React state tree for
      // the rest of the session.
      setPassword('')
      onUnlocked()
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : `That is not the password for this ${noun}.`,
      )
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

        <h1 className="join-title with-icon">
          <IconLock size={20} />
          This {noun} has a password
        </h1>

        <p className="join-body">
          {/* One line on purpose: the only thing worth saying is that having access is
              not the same as having the password. Telling somebody to go ask is a second
              sentence for something they were already going to do. */}
          Everybody who opens it is asked.
        </p>

        <form className="password-gate" onSubmit={(event) => void submit(event)}>
          <label className="modal-field">
            <span>Password</span>
            <input
              // Autofocused because there is exactly one thing to do on this screen and
              // making somebody click into the only field first is a step for nothing.
              autoFocus
              type="password"
              value={password}
              autoComplete="off"
              maxLength={128}
              onChange={(event) => {
                setPassword(event.target.value)
                // The old failure is about the old guess. Leaving it up while somebody
                // types the next one reads as the new one having failed already.
                if (error !== null) setError(null)
              }}
            />
          </label>

          {error !== null && <p className="error">{error}</p>}

          <div className="row">
            <button type="submit" className="primary" disabled={busy || password === ''}>
              {busy ? 'Checking…' : 'Open'}
            </button>
            <button type="button" className="link" onClick={onBack}>
              {user === null ? 'Go to Meadow' : `Back to your ${noun}s`}
            </button>
          </div>
        </form>
      </div>
    </main>
  )
}
