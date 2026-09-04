/**
 * Where a `#/join/...` invitation link lands.
 *
 * The audience is somebody with no Meadow account - that is the only reason this link
 * exists. An address that already has one is granted access outright and told by mail,
 * with nothing to accept; this screen is the other half, for an address that had
 * nobody behind it when the owner typed it in.
 *
 * So it is written for a person who has never seen this app. It says who invited them,
 * what to, and what they will be able to do, before it asks for anything - and then it
 * asks for exactly one thing, which is to make an account at the address the invitation
 * names. The board is waiting on the other side: activation applies every invitation
 * addressed to the account it just opened, so there is no second link to keep, no code
 * to paste, and nothing to remember.
 *
 * The signed-in cases are here too, and both are real. Somebody may have registered
 * since the link was sent, in which case one button finishes it; and somebody may be
 * signed in as a different person, in which case saying so plainly is the only useful
 * thing this screen can do - accepting for whoever holds the link would make the
 * address part decorative, and forwarding the message would forward the access.
 */

import { useEffect, useState } from 'react'

import * as api from '../../lib/api'
import type { JoinInvitation } from '../../lib/api'
import { Wordmark } from '../../ui/Brand'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/Toaster'
import { useAuth } from '../auth/AuthContext'
import { rememberInvitedEmail } from '../auth/invitation'
import { boardKind, boardPath } from '../boards/kinds'

type Props = {
  token: string
  /** Leave for the board list, which is also where a signed-out visitor registers. */
  onDone: () => void
}

export default function JoinPage({ token, onDone }: Props) {
  const { user } = useAuth()
  const toast = useToast()
  const [invitation, setInvitation] = useState<JoinInvitation | null>(null)
  const [missing, setMissing] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .getInvitation(token)
      .then((found) => {
        if (!cancelled) setInvitation(found)
      })
      .catch(() => {
        if (!cancelled) setMissing(true)
      })
    return () => {
      cancelled = true
    }
  }, [token])

  const accept = async () => {
    setBusy(true)
    try {
      const board = await api.acceptInvitation(token)
      // Straight onto the board rather than back to the list. They followed a link to
      // one particular thing; landing on a list of everything and having to find it
      // would be the app losing the thread of what was being done.
      location.hash = boardPath(board.kind, board.id)
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'That invitation could not be accepted.',
      )
      setBusy(false)
    }
  }

  const noun = invitation === null ? 'glade' : boardKind(invitation.kind).label.toLowerCase()
  const verb = invitation?.role === 'editor' ? 'edit' : 'read'

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        <p className="tagline">Think Beyond the horizon...</p>

        {missing && (
          <>
            <h1 className="join-title">This invitation is not valid</h1>
            <p className="join-body">
              The link may have been mistyped, or the {noun} it pointed at may be gone.
              Ask whoever sent it for a new one.
            </p>
            <button type="button" className="primary" onClick={onDone}>
              Go to Meadow
            </button>
          </>
        )}

        {invitation !== null && invitation.status === 'revoked' && (
          <>
            <h1 className="join-title">This invitation was withdrawn</h1>
            <p className="join-body">
              {invitation.invited_by ?? 'Whoever sent this'} has since taken it back, so
              it no longer opens “{invitation.title}”. Ask them if you think that was a
              mistake.
            </p>
            <button type="button" className="primary" onClick={onDone}>
              Go to Meadow
            </button>
          </>
        )}

        {invitation !== null && invitation.status !== 'revoked' && (
          <>
            <h1 className="join-title">
              {invitation.invited_by === null
                ? 'You have been invited'
                : `${invitation.invited_by} invited you`}
            </h1>
            <p className="join-body">
              to the {noun} <strong>“{invitation.title}”</strong>, where you will be able
              to {verb} it. The invitation was sent to{' '}
              <strong>{invitation.email}</strong>.
            </p>

            {user === null ? (
              <>
                <p className="join-body">
                  Meadow is an infinite canvas you write and draw on together. Make an
                  account at that address and the {noun} will be waiting in your list -
                  there is nothing else to redeem.
                </p>
                <button
                  type="button"
                  className="primary"
                  onClick={() => {
                    // The form opens on this address rather than empty. Registering
                    // with a different one is the single way to end up with an account
                    // and no board, and it is invisible when it happens.
                    rememberInvitedEmail(invitation.email)
                    onDone()
                  }}
                >
                  Create an account
                </button>
              </>
            ) : user.email.toLowerCase() === invitation.email.toLowerCase() ? (
              <>
                <p className="join-body">
                  You are signed in as {user.email}, which is who this was for.
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => void accept()}
                >
                  {busy ? 'Opening…' : `Open this ${noun}`}
                </button>
              </>
            ) : (
              <>
                <p className="join-body">
                  You are signed in as <strong>{user.email}</strong>, and this invitation
                  was sent to <strong>{invitation.email}</strong>. An invitation belongs
                  to the address it names, so this one cannot be accepted from here. Sign
                  out and register that address, or ask for a new invitation to the one
                  you are using.
                </p>
                <button type="button" className="ghost" onClick={onDone}>
                  Go to Meadow
                </button>
              </>
            )}
          </>
        )}
      </div>
    </main>
  )
}
