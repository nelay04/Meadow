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
 * The owner has one thing here nobody else does, and it is at the end of the screen
 * rather than in place of it: "Forgot it?", which mails them a code and trades that code
 * for a temporary password. Only the owner is shown it. Offering it to everybody and
 * letting the server refuse would put a control on the screen that does nothing for
 * almost everybody who sees it, and "you are not the owner" is not news to somebody who
 * came here through a link they were sent - it is a dead end with a wrong turn in front
 * of it.
 *
 * That costs nothing to know: `GET /boards/{id}` answers with the role from *behind* the
 * password, deliberately - what the password holds back is the document, not the board's
 * existence - so `BoardPage` has the role in hand before it draws this screen and passes
 * it down. Nothing is asked here that was not already asked.
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
import { copy } from '../../lib/clipboard'
import { Wordmark } from '../../ui/Brand'
import { IconCheck, IconCopy, IconLock, IconMail } from '../../ui/icons'
import { OtpInput } from '../../ui/OtpInput'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useAuth } from '../auth/AuthContext'

/**
 * Which of the three screens this is.
 *
 * A stage rather than two booleans: they are mutually exclusive, and the version of
 * this with `showCode` and `showRecovered` beside each other has a fourth state that
 * means nothing and renders as both at once.
 */
type Stage = 'password' | 'code' | 'recovered'

type Props = {
  boardId: string
  /** "glade" or "lea", lowercase. */
  noun: string
  /** The share token from the address bar, or null. */
  linkToken: string | null
  /**
   * Whether the person looking at this owns the board.
   *
   * Only for whether "Forgot it?" is drawn. It is not a permission - the server resolves
   * that on both recovery routes through `board_owner` like every other owner-only
   * thing - and a client that lied about it would get a 403 and nothing else.
   */
  isOwner: boolean
  /** Try the connection again, now that a pass has been written. */
  onUnlocked: () => void
  /** Leave for the board list, or for the app itself when nobody is signed in. */
  onBack: () => void
}

export function PasswordGate({
  boardId,
  noun,
  linkToken,
  isOwner,
  onUnlocked,
  onBack,
}: Props) {
  const { user } = useAuth()
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const [stage, setStage] = useState<Stage>('password')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState<api.BoardRecoveryStart | null>(null)
  const [recovered, setRecovered] = useState<api.BoardRecovery | null>(null)
  const [copied, setCopied] = useState(false)

  /**
   * Turn a password into a pass, and leave.
   *
   * Shared by the form and by the button on the recovered screen, which is the same
   * act with the typing already done: somebody handed a temporary password has no
   * reason to retype it into the field above.
   */
  const unlockWith = async (candidate: string): Promise<void> => {
    /*
     * Two routes, and the split is the same one the ws-token mint makes: a signed-in
     * caller answers against their own account and whatever the link adds, and a
     * visitor with no account answers against the link alone. Guessing from a 401
     * instead would make every anonymous visit start with a refused request.
     */
    const pass =
      user === null && linkToken !== null
        ? await api.verifySharedBoardPassword(linkToken, candidate)
        : await api.verifyBoardPassword(boardId, candidate, linkToken)
    rememberBoardPass(boardId, pass.pass_token)
    onUnlocked()
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (password === '' || busy) return
    setBusy(true)
    setError(null)
    try {
      await unlockWith(password)
      // Cleared before leaving, so a password does not sit in a React state tree for
      // the rest of the session.
      setPassword('')
    } catch (error) {
      setError(
        error instanceof ApiError && error.status === 429
          ? 'Too many attempts. Wait a few minutes and try again.'
          : `That is not the password for this ${noun}.`,
      )
      setBusy(false)
    }
  }

  /**
   * "Forgot it?" - ask the server to mail this account a code.
   *
   * The refusal for somebody who is not the owner is spelled out rather than softened.
   * They are signed in, they know who they are, and the useful thing to tell them is
   * that the person to ask is the owner - which "that did not work" would not.
   */
  const askForCode = async (): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const start = await api.forgotBoardPassword(boardId)
      setSent(start)
      setCode('')
      setStage('code')
    } catch (error) {
      const status = error instanceof ApiError ? error.status : 0
      setError(
        // 403 should be unreachable: the button is only drawn for an owner. It is
        // handled anyway, because the button being drawn is a client's opinion and the
        // role can have changed since it was formed - an owner demoted while sitting on
        // this screen gets a sentence rather than "that could not be sent".
        status === 403
          ? `Only the owner of this ${noun} can reset its password. Ask them for it.`
          : status === 429
            ? 'A code was sent recently. Check your mail, or wait a while and ask again.'
            : status === 502
              ? 'The code could not be sent just now. Try again in a moment.'
              : 'That code could not be sent.',
      )
    }
    setBusy(false)
  }

  /**
   * Spend the code. What comes back is a new password, not the forgotten one.
   *
   * Called by the boxes themselves the moment the sixth character lands, so there is no
   * button under them: a code is finished when it is finished, and a Confirm that only
   * exists because forms have one is a step for nothing.
   *
   * A refusal empties the boxes. The code was wrong as a whole - there is no character
   * to go back and fix - and leaving six wrong digits on screen for somebody to edit is
   * how the second attempt becomes the same attempt.
   */
  const submitCode = async (entered: string): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const result = await api.recoverBoardPassword(boardId, entered)
      setRecovered(result)
      setCode('')
      setStage('recovered')
    } catch (error) {
      setError(
        error instanceof ApiError && error.detail !== null
          ? error.detail
          : 'That is not the code.',
      )
      setCode('')
    }
    setBusy(false)
  }

  /** Go in with the temporary password, without making anybody retype it. */
  const openWithTemporary = async (): Promise<void> => {
    if (recovered === null || busy) return
    setBusy(true)
    setError(null)
    try {
      await unlockWith(recovered.password)
    } catch {
      setError(`This ${noun} would not open with that password. Ask for another code.`)
      setBusy(false)
    }
  }

  const backToPassword = (): void => {
    setStage('password')
    setError(null)
    setRecovered(null)
    setCopied(false)
  }

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        {stage === 'password' && (
          <>
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
                <span className="label-row">
                  <span>Password</span>
                  {/* The owner and nobody else. Everybody else - a member, a stranger
                      on a link, a visitor with no account at all - has no inbox this
                      could send anything to and no route it could open, so the honest
                      screen for them is the one that was here before this existed. */}
                  {isOwner && (
                    <button
                      type="button"
                      className="label-action"
                      disabled={busy}
                      onClick={() => void askForCode()}
                    >
                      Forgot it?
                    </button>
                  )}
                </span>
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
          </>
        )}

        {stage === 'code' && sent !== null && (
          <>
            <h1 className="join-title with-icon">
              <IconMail size={20} />
              Check your mail
            </h1>

            <p className="join-body">
              A code is on its way to <strong>{sent.sent_to}</strong>. It works once and
              expires in {sent.expires_in_minutes} minutes. Entering it sets a new
              temporary password - the old one cannot be recovered, only replaced.
            </p>

            <div className="password-gate">
              <div className="modal-field">
                <span>Code from the mail</span>
                <OtpInput
                  label="Code from the mail"
                  value={code}
                  autoFocus
                  disabled={busy}
                  invalid={error !== null}
                  onChange={(next) => {
                    setCode(next)
                    // The old failure is about the old code. Leaving it up while
                    // somebody types the next one reads as the new one having failed
                    // before it was finished.
                    if (error !== null) setError(null)
                  }}
                  onComplete={(entered) => void submitCode(entered)}
                />
              </div>

              {busy && <p className="notice">Checking the code…</p>}
              {error !== null && <p className="error">{error}</p>}

              <div className="row">
                <button
                  type="button"
                  className="link"
                  disabled={busy}
                  onClick={() => void askForCode()}
                >
                  Send another
                </button>
                <button type="button" className="link" onClick={backToPassword}>
                  I remembered it
                </button>
              </div>
            </div>
          </>
        )}

        {stage === 'recovered' && recovered !== null && (
          <>
            <h1 className="join-title with-icon">
              <IconLock size={20} />
              A temporary password
            </h1>

            <p className="join-body">
              {/* The deadline and what happens at it, in that order. A password that
                  stops on its own is unlike every other one the reader has, and the
                  part they must not miss is that the {noun} stays shut when it does. */}
              It works until{' '}
              <strong>
                {new Date(recovered.expires_at).toLocaleTimeString([], {
                  hour: 'numeric',
                  minute: '2-digit',
                })}
              </strong>
              . Set a proper one from the {noun}&apos;s menu before then - when this runs
              out the {noun} stays closed, and getting in means another code.
            </p>

            <div className="password-gate">
              <div className="modal-field">
                <span className="label-row">
                  <span>Temporary password</span>
                  <button
                    type="button"
                    className="label-action"
                    onClick={() => {
                      void copy(recovered.password).then((done) => setCopied(done))
                    }}
                  >
                    {copied ? (
                      <>
                        <IconCheck size={13} /> Copied
                      </>
                    ) : (
                      <>
                        <IconCopy size={13} /> Copy
                      </>
                    )}
                  </button>
                </span>
                {/* Readonly rather than plain text: it can be selected, dragged and
                    copied by hand on a browser where the clipboard is unavailable, which
                    is every un-TLS'd deployment. */}
                <input className="mono" readOnly value={recovered.password} />
              </div>

              {!recovered.mailed && (
                <p className="notice">
                  {/* Not an error. The reset happened and the password above works; what
                      failed is the copy going to the inbox, and saying so is the
                      difference between "write this down" and "try again". */}
                  This did not reach your inbox - the mail could not be sent. Copy it
                  from here.
                </p>
              )}

              {error !== null && <p className="error">{error}</p>}

              <div className="row">
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void openWithTemporary()}
                >
                  {busy ? 'Opening…' : `Open the ${noun}`}
                </button>
                <button type="button" className="link" onClick={onBack}>
                  {`Back to your ${noun}s`}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
