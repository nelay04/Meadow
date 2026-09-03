/**
 * What a glade you cannot open looks like.
 *
 * Two situations arrive here and they are one screen because they are one moment: a
 * link to a restricted glade that was never yours, and a glade that was yours until
 * somebody changed their mind about it. In both cases the previous answer was a status
 * pill reading "No access" over a canvas that carried on showing the document, which
 * is the worst of both - it says you are locked out while displaying the thing you are
 * locked out of.
 *
 * So this replaces the board rather than sitting on top of it. Nothing of the document
 * is rendered, and `BoardPage` clears the local copy on its way here, because a
 * revoked collaborator who reloads must not be handed the contents out of their own
 * IndexedDB.
 *
 * The part that is new is the way forward. Asking costs the person one click and gives
 * them nothing until an owner says so - the request is a record, not a key - and it is
 * the difference between a door and a wall.
 */

import { useCallback, useEffect, useState } from 'react'

import * as api from '../../lib/api'
import type { BoardRole, MyAccessRequest } from '../../lib/api'
import { Wordmark } from '../../ui/Brand'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/Toaster'
import { useAuth } from '../auth/AuthContext'

type Props = {
  boardId: string
  /** "glade" or "lea", lowercase. */
  noun: string
  /** Why the connection was refused, as the provider reported it. */
  reason: string
  /** Leave for the board list, or for the app itself when nobody is signed in. */
  onBack: () => void
}

/**
 * How often the waiting screen asks whether anything has changed.
 *
 * Eight seconds, and only while somebody is actually sitting on this screen waiting.
 * A person who has just asked for access is watching the page, so a slower poll would
 * be felt; anything faster is a request per few seconds for an answer that needs a
 * human, and this is the one screen a stranger can hold open indefinitely.
 */
const POLL_MS = 8_000

export function AccessGate({ boardId, noun, reason, onBack }: Props) {
  const { user } = useAuth()
  const toast = useToast()
  const [request, setRequest] = useState<MyAccessRequest | null>(null)
  const [busy, setBusy] = useState(false)

  const read = useCallback(async (): Promise<MyAccessRequest | null> => {
    try {
      return await api.getMyAccessRequest(boardId)
    } catch {
      // Nothing here is worth a toast. The screen already says the board will not
      // open, and a failed poll is not a second piece of news.
      return null
    }
  }, [boardId])

  useEffect(() => {
    if (user === null) return
    let cancelled = false

    const check = async (): Promise<void> => {
      const state = await read()
      if (cancelled || state === null) return
      setRequest(state)
      if (state.has_access) {
        // Reloading rather than reconnecting in place. Access arriving changes the
        // answer to every question this view already asked - the title, the role, the
        // share mode, whether there is a document to show - and a full reload is one
        // path instead of a second, rarer one that has to put all of it back.
        location.reload()
      }
    }

    void check()
    const timer = window.setInterval(() => void check(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [user, read])

  const ask = async (role: BoardRole): Promise<void> => {
    setBusy(true)
    try {
      setRequest(await api.requestAccess(boardId, role))
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : 'That request could not be sent.',
      )
    } finally {
      setBusy(false)
    }
  }

  const pending = request?.status === 'pending'
  const declined = request?.status === 'declined'

  return (
    <main className="auth">
      <div className="auth-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        <h1 className="join-title">
          {pending ? 'Waiting to be let in' : `This ${noun} is not open to you`}
        </h1>

        {user === null ? (
          <>
            <p className="join-body">
              {reason === ''
                ? `The address works, the ${noun} behind it is private.`
                : `${reason[0].toUpperCase()}${reason.slice(1)}.`}{' '}
              Asking for access needs an account, because the person deciding has to
              know who is asking.
            </p>
            <button type="button" className="primary" onClick={onBack}>
              Go to Meadow
            </button>
          </>
        ) : pending ? (
          <>
            <p className="join-body">
              Your request to {request?.role === 'editor' ? 'edit' : 'read'} this {noun}{' '}
              has gone to whoever owns it, along with your name and the address on your
              account. This page opens by itself the moment they say yes.
            </p>
            <p className="join-body">
              You can close it in the meantime - nothing here has to stay open for the
              request to stand.
            </p>
            <button type="button" className="link" onClick={onBack}>
              Go to my glades
            </button>
          </>
        ) : (
          <>
            <p className="join-body">
              {declined
                ? `Your last request for this ${noun} was turned down. If that was a
                   misunderstanding, ask again - the owner sees who is asking.`
                : `You have the address, and the ${noun} behind it is private. Ask the
                   owner to let you in, and say which you need: reading it is a smaller
                   thing to grant than writing in it, and asking for the smaller one is
                   more often answered.`}
            </p>
            <div className="row">
              <button
                type="button"
                className="primary"
                disabled={busy}
                onClick={() => void ask('viewer')}
              >
                Ask to view
              </button>
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void ask('editor')}
              >
                Ask to edit
              </button>
            </div>
            <button type="button" className="link" onClick={onBack}>
              Back to my glades
            </button>
          </>
        )}
      </div>
    </main>
  )
}
