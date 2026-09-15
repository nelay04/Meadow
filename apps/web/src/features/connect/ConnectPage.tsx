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
import { IconAlert, IconCheck } from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/Toaster'
import { useAuth } from '../auth/AuthContext'
import {
  CreateToggle,
  GladePicker,
  LifetimePicker,
  daysFromToday,
  daysUntil,
  inputDate,
  toInput,
} from '../profile/AccessTokensCard'
import type { Grants, Lifetime } from '../profile/AccessTokensCard'

type Props = {
  requestId: string
  onDone: () => void
}

export default function ConnectPage({ requestId, onDone }: Props) {
  const toast = useToast()
  const { user } = useAuth()
  const [request, setRequest] = useState<ConnectRequest | null>(null)
  const [missing, setMissing] = useState(false)
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [grants, setGrants] = useState<Grants>({})
  const [mayCreate, setMayCreate] = useState(false)
  // Same default as a token made by hand. A connection is renewed by the assistant, so a
  // date is what makes it end without anybody remembering to revoke it.
  const [lifetime, setLifetime] = useState<Lifetime>(90)
  const [customDate, setCustomDate] = useState(() => inputDate(daysFromToday(60)))
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

  const canApprove =
    !busy &&
    (mayCreate || Object.keys(grants).length > 0) &&
    (lifetime !== 'custom' || daysUntil(customDate) !== null)

  const answer = async (approve: boolean) => {
    // Counted at the moment of answering, like the token form, so a screen left open
    // past midnight does not end the connection a day late.
    const days = lifetime === 'custom' ? daysUntil(customDate) : lifetime
    if (approve && lifetime === 'custom' && days === null) {
      toast.error('Pick an end date between tomorrow and a year from now.')
      return
    }
    setBusy(true)
    try {
      const { redirect_url } = approve
        ? await api.approveConnectRequest(requestId, {
            grants: toInput(grants),
            can_create: mayCreate,
            ...(days === null ? {} : { expires_in_days: days }),
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
              A request to connect lasts ten minutes and can be answered once. Start connecting
              again from the assistant.
            </p>
            <button type="button" className="primary" onClick={onDone}>
              Go to Meadow
            </button>
          </>
        )}

        {!missing && request === null && <p className="faint">Loading...</p>}

        {!missing && request !== null && (
          <>
            {/*
              Laid out like the form for a new token on the profile page, because it is
              one: who is asking and where the answer goes, then the same numbered steps,
              then the decision. Seeing it twice in the same shape is what lets somebody
              recognise the token later in their list.
            */}
            <div className="connect-head">
              <span className="connect-avatar" aria-hidden="true">
                {request.client_name.trim().charAt(0).toUpperCase() || '?'}
              </span>
              <div className="connect-head-text">
                <h1 className="connect-title">{request.client_name} wants to use Meadow as you</h1>
                <span
                  className={
                    request.client_host === null ? 'connect-identity' : 'connect-identity verified'
                  }
                >
                  {request.client_host === null ? <IconAlert size={14} /> : <IconCheck size={14} />}
                  {request.client_host === null
                    ? 'Unverified: the name is what the assistant called itself'
                    : `Verified as ${request.client_host}`}
                </span>
              </div>
            </div>

            <dl className="connect-facts">
              <div>
                <dt>Signed in as</dt>
                <dd>{user?.email ?? 'You'}</dd>
              </div>
              <div>
                <dt>Answer goes to</dt>
                <dd>
                  <strong>{request.redirect_host}</strong>
                </dd>
              </div>
              <div>
                <dt>Revoke any time</dt>
                <dd>Profile, Assistants and tokens</dd>
              </div>
            </dl>

            <div className="token-compose connect-steps">
              <div className="token-step">
                <span className="token-step-num" aria-hidden="true">
                  1
                </span>
                <div className="token-step-body">
                  <h5>Access</h5>
                  <p className="hint">
                    Tick what it may open, and what it may do on each. It can never do more than you
                    can yourself.
                  </p>
                  <GladePicker boards={boards} grants={grants} onChange={setGrants} />
                </div>
              </div>

              <div className="token-step">
                <span className="token-step-num" aria-hidden="true">
                  2
                </span>
                <div className="token-step-body">
                  <h5>New glades and leas</h5>
                  <CreateToggle on={mayCreate} onChange={setMayCreate} />
                </div>
              </div>

              <div className="token-step">
                <span className="token-step-num" aria-hidden="true">
                  3
                </span>
                <div className="token-step-body">
                  <h5>How long</h5>
                  <p className="hint">
                    The assistant renews its access by itself, but never past the date you pick.
                    Either way it also ends if it goes a month without being used.
                  </p>
                  <LifetimePicker
                    lifetime={lifetime}
                    onLifetime={setLifetime}
                    customDate={customDate}
                    onCustomDate={setCustomDate}
                    neverNote="It stays connected for as long as the assistant keeps using it, until you revoke it under Profile, Assistants and tokens."
                  />
                </div>
              </div>

              <div className="token-compose-actions">
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
                  {busy ? 'Connecting...' : 'Allow access'}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  )
}
