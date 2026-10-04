/**
 * What is on screen while a glade is still deciding whether it may be shown.
 *
 * Deliberately empty of the document. The handshake takes a round trip and the local
 * offline copy is there in milliseconds, so anything drawn here would be drawn before
 * the answer - which is how a locked glade used to show its contents for a second and
 * then ask for the password.
 *
 * Two moments, one screen. Usually this is the brief wait for the answer and looks
 * exactly like the app's own loading screen, because it is the same screen. When the
 * glade is known to be locked and the API cannot be reached, the wait has no end in
 * sight and is worth explaining: the password is the server's to check, so there is
 * nothing this browser can do with the copy it has.
 */

import { Wordmark } from '../../ui/Brand'
import { LoaderScreen } from '../../ui/LoaderScreen'
import { ThemeToggle } from '../../ui/ThemeToggle'

type Props = {
  /** "glade" or "lea", lowercase. */
  noun: string
  /** Locked, with no way to reach the server that holds the answer. */
  blocked: boolean
  /** Leave for the board list, or for the app itself when nobody is signed in. */
  onBack: () => void
  /** What leaving is called here, which depends on whether there is an account. */
  backLabel: string
}

export function BoardOpening({ noun, blocked, onBack, backLabel }: Props) {
  if (!blocked) return <LoaderScreen />

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        <h1 className="join-title">This {noun} is locked</h1>
        <p className="join-body">
          It opens with a password, and Meadow cannot be reached to check one. Your copy
          of this {noun} stays shut until the connection is back, because whether a
          password is right is not a question this browser can answer.
        </p>
        <p className="join-body">
          It keeps trying. Leave the page open and it opens by itself.
        </p>
        <button type="button" className="link" onClick={onBack}>
          {backLabel}
        </button>
      </div>
    </main>
  )
}
