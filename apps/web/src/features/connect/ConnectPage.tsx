/**
 * Where an assistant's sign-in lands: `#/connect/<request id>`.
 *
 * The person is signed in by the time this renders; App shows the login form first. What
 * they approve is a fine-grained access token, so the choice here is the same one the
 * profile page offers, starting with nothing picked. The address the answer goes to is
 * shown beside the name, because the name is whatever the assistant registered with and
 * the address is the part it could not choose freely.
 */

import { useEffect, useState } from 'react'

import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import type { Board, ConnectRequest } from '../../lib/api'
import { Wordmark } from '../../ui/Brand'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/Toaster'
import { CreateToggle, GladePicker, toInput } from '../profile/AccessTokensCard'
import type { Grants } from '../profile/AccessTokensCard'

type Props = {
  requestId: string
  onDone: () => void
}

export default function ConnectPage({ requestId, onDone }: Props) {
  const toast = useToast()
  const [request, setRequest] = useState<ConnectRequest | null>(null)
  const [missing, setMissing] = useState(false)
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [grants, setGrants] = useState<Grants>({})
  const [mayCreate, setMayCreate] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    api.getConnectRequest(requestId).then(
      (found) => {
        if (!cancelled) setRequest(found)
      },
      () => {
        if (!cancelled) setMissing(true)
      },
    )
    api.listBoards().then(
      (found) => {
        if (!cancelled) setBoards(found)
      },
      () => {
        if (!cancelled) setBoards([])
      },
    )
    return () => {
      cancelled = true
    }
  }, [requestId])

  const canApprove = !busy && (mayCreate || Object.keys(grants).length > 0)

  const answer = async (approve: boolean) => {
    setBusy(true)
    try {
      const { redirect_url } = approve
        ? await api.approveConnectRequest(requestId, {
            grants: toInput(grants),
            can_create: mayCreate,
          })
        : await api.denyConnectRequest(requestId)
      location.href = redirect_url
    } catch (caught) {
      setBusy(false)
      if (caught instanceof ApiError && caught.status === 404) {
        setMissing(true)
        return
      }
      toast.error(
        caught instanceof ApiError && caught.status === 409
          ? 'You have as many tokens as an account may hold. Revoke one in your profile first.'
          : 'Could not answer the request. Try again.',
      )
    }
  }

  return (
    <main className="auth">
      <div className="auth-card connect-card">
        <div className="brand">
          <Wordmark />
          <span style={{ flex: 1 }} />
          <ThemeToggle />
        </div>

        {missing && (
          <>
            <h1 className="join-title">This request has expired</h1>
            <p className="join-body">
              A request to connect lasts ten minutes and can be answered once. Start
              connecting again from the assistant.
            </p>
            <button type="button" className="primary" onClick={onDone}>
              Go to Meadow
            </button>
          </>
        )}

        {!missing && request === null && <p className="faint">Loading...</p>}

        {!missing && request !== null && (
          <>
            <h1 className="join-title">{request.client_name} wants to use Meadow as you</h1>
            <p className={request.client_host === null ? 'connect-identity' : 'connect-identity verified'}>
              {request.client_host === null
                ? 'Meadow cannot confirm who this is. The name is what the assistant called itself.'
                : `Verified as ${request.client_host}`}
            </p>
            <p className="join-body">
              It gets a token that reaches only what you pick below, and never more than you
              can do yourself. The answer goes to <strong>{request.redirect_host}</strong>.
              You can change or revoke it later under Profile, Assistants and tokens.
            </p>

            <GladePicker boards={boards} grants={grants} onChange={setGrants} />
            <CreateToggle on={mayCreate} onChange={setMayCreate} />

            <div className="connect-actions">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => void answer(false)}
              >
                Deny
              </button>
              <button
                type="button"
                className="primary"
                disabled={!canApprove}
                onClick={() => void answer(true)}
              >
                {busy ? 'Connecting...' : 'Allow'}
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
