import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { IconCopy, IconKey } from '../../ui/icons'
import { absoluteTime, relativeTime } from '../../ui/time'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import type { AccessToken, AccessTokenGrantInput, Board, CreatedAccessToken } from '../../lib/api'
import { copy } from '../../lib/clipboard'
import { roleCanWrite } from '../../doc/mutations'

type Kind = AccessToken['kind']
type Permission = 'read' | 'edit' | 'delete'
/** Glade id to what is granted on it. A glade that is not a key is not granted. */
type Grants = Record<string, { edit: boolean; delete: boolean }>

const KINDS: { id: Kind; label: string; hint: string }[] = [
  { id: 'classic', label: 'Classic', hint: 'Everything you can do, on every glade' },
  { id: 'fine_grained', label: 'Fine-grained', hint: 'Chosen glades, chosen permissions' },
]

/** Days, or null for never. Never is offered and is not the default. */
const LIFETIMES: { days: number | null; label: string }[] = [
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 365, label: 'A year' },
  { days: null, label: 'Never' },
]

const PERMISSIONS: { id: Permission; label: string }[] = [
  { id: 'read', label: 'View' },
  { id: 'edit', label: 'Edit' },
  { id: 'delete', label: 'Delete' },
]

/** "12 Dec 2026". `relativeTime` only speaks about the past, and an expiry is ahead. */
function shortDate(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function grantPhrase(grant: { edit: boolean; delete: boolean }): string {
  if (grant.edit && grant.delete) return 'View, edit, delete'
  if (grant.edit) return 'View, edit'
  if (grant.delete) return 'View, delete'
  return 'View'
}

/**
 * Toggle one permission on one glade, keeping the rule that edit and delete sit on top of
 * view: turning either on turns view on, and turning view off takes the glade out.
 */
function toggle(grants: Grants, boardId: string, permission: Permission): Grants {
  const current = grants[boardId]
  const next = { ...grants }
  if (permission === 'read') {
    if (current === undefined) next[boardId] = { edit: false, delete: false }
    else delete next[boardId]
    return next
  }
  const base = current ?? { edit: false, delete: false }
  next[boardId] = { ...base, [permission]: !base[permission] }
  return next
}

function toInput(grants: Grants): AccessTokenGrantInput[] {
  return Object.entries(grants).map(([board_id, grant]) => ({ board_id, read: true, ...grant }))
}

type PickerProps = {
  boards: Board[] | null
  grants: Grants
  onChange: (grants: Grants) => void
}

/**
 * Which glades a fine-grained token may open, and what it may do on each.
 *
 * One row per glade, three toggles per row. Edit and delete are disabled on a glade
 * where your own role cannot write: the token could never do more than you, and a toggle
 * that silently does nothing is worse than one that says so.
 */
function GladePicker({ boards, grants, onChange }: PickerProps) {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (boards ?? []).filter(
      (board) => needle === '' || board.title.toLowerCase().includes(needle),
    )
  }, [boards, filter])

  if (boards === null) return <p className="faint">Loading your glades...</p>
  if (boards.length === 0) return <p className="hint">You have no glades to grant yet.</p>

  const chosen = Object.keys(grants).length
  return (
    <div className="grant-picker">
      <div className="grant-picker-head">
        <span className="faint">
          {chosen === 0
            ? 'No glades chosen'
            : chosen === 1
              ? '1 glade chosen'
              : `${chosen} glades chosen`}
        </span>
        {boards.length > 6 && (
          <input
            className="grant-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter glades"
            aria-label="Filter glades"
          />
        )}
      </div>
      <ul className="grant-list">
        {visible.map((board) => {
          const grant = grants[board.id]
          const writable = roleCanWrite(board.role)
          return (
            <li key={board.id} className={grant === undefined ? 'grant-row' : 'grant-row on'}>
              <span className="grant-title">
                {board.title}
                {!writable && <span className="faint"> ({board.role})</span>}
              </span>
              <span
                className="grant-toggles"
                role="group"
                aria-label={`Permissions on ${board.title}`}
              >
                {PERMISSIONS.map((permission) => {
                  const pressed =
                    grant !== undefined && (permission.id === 'read' || grant[permission.id])
                  const disabled = permission.id !== 'read' && !writable
                  return (
                    <button
                      key={permission.id}
                      type="button"
                      className={pressed ? 'grant-toggle on' : 'grant-toggle'}
                      aria-pressed={pressed}
                      disabled={disabled}
                      title={disabled ? `Your role on this glade is ${board.role}` : undefined}
                      onClick={() => onChange(toggle(grants, board.id, permission.id))}
                    >
                      {permission.label}
                    </button>
                  )
                })}
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}

/**
 * Personal access tokens, for AI assistants and scripts.
 *
 * Its own component because the page it sits on is already long, and because this card
 * is the only one holding a secret: the raw token lives in `created` for as long as the
 * person needs to copy it and is dropped the moment they dismiss it. It is never written
 * anywhere else, and the list the server sends back cannot reproduce it.
 */
export function AccessTokensCard() {
  const toast = useToast()
  const confirm = useConfirm()
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [failed, setFailed] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('fine_grained')
  const [grants, setGrants] = useState<Grants>({})
  const [lifetime, setLifetime] = useState<number | null>(90)
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  // The token whose glades are being changed, and the draft of them.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Grants>({})
  const [saving, setSaving] = useState(false)

  const reload = async (): Promise<void> => {
    try {
      setTokens(await api.listAccessTokens())
      setFailed(false)
    } catch {
      setFailed(true)
    }
  }

  useEffect(() => {
    void reload()
    api.listBoards().then(setBoards, () => setBoards([]))
  }, [])

  const canCreate =
    name.trim() !== '' && !creating && (kind === 'classic' || Object.keys(grants).length > 0)

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!canCreate) return
    setCreating(true)
    try {
      const expiry = lifetime === null ? {} : { expires_in_days: lifetime }
      const token = await api.createAccessToken(
        kind === 'classic'
          ? { name: name.trim(), kind, ...expiry }
          : { name: name.trim(), kind, grants: toInput(grants), ...expiry },
      )
      setCreated(token)
      setName('')
      setGrants({})
      await reload()
    } catch (caught) {
      toast.error(
        caught instanceof ApiError && caught.status === 409
          ? 'You have as many tokens as an account may hold. Revoke one first.'
          : 'Could not create the token.',
      )
    } finally {
      setCreating(false)
    }
  }

  const startEditing = (token: AccessToken) => {
    setEditing(token.id)
    setDraft(
      Object.fromEntries(
        (token.grants ?? []).map((grant) => [
          grant.board_id,
          { edit: grant.edit, delete: grant.delete },
        ]),
      ),
    )
  }

  const saveGrants = async (token: AccessToken) => {
    if (Object.keys(draft).length === 0) return
    setSaving(true)
    try {
      await api.updateAccessToken(token.id, { grants: toInput(draft) })
      toast.success(
        `${token.name} was updated. Anything using it picks up the change straight away.`,
      )
      setEditing(null)
      await reload()
    } catch {
      toast.error('Could not update the token.')
    } finally {
      setSaving(false)
    }
  }

  const revoke = async (token: AccessToken) => {
    const ok = await confirm({
      title: `Revoke ${token.name}?`,
      body:
        'Anything using it stops working straight away, including a glade it has open ' +
        'right now. Nothing on your glades changes.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    })
    if (!ok) return
    setRevoking(token.id)
    try {
      await api.revokeAccessToken(token.id)
      if (created?.id === token.id) setCreated(null)
      toast.success(`${token.name} was revoked.`)
    } catch (caught) {
      if (!(caught instanceof ApiError && caught.status === 404)) {
        toast.error('Could not revoke that token.')
      }
    } finally {
      setRevoking(null)
      await reload()
    }
  }

  const copyCreated = async () => {
    if (created === null) return
    if (await copy(created.token)) toast.success('Token copied.')
    else toast.error('Could not copy. Select the token and copy it by hand.')
  }

  return (
    <section className="card">
      <h2>Access tokens</h2>
      <p className="hint">
        For AI assistants and scripts that read or edit your glades through the Meadow MCP server. A
        token acts as you, and can never do more than you can.
      </p>

      {created !== null && (
        <div className="token-created" role="status">
          <p>
            <strong>Copy {created.name} now.</strong> This is the only time it is shown.
          </p>
          <div className="token-secret">
            <code>{created.token}</code>
            <button type="button" className="primary" onClick={() => void copyCreated()}>
              <IconCopy size={16} />
              Copy
            </button>
          </div>
          <button
            type="button"
            className="ghost profile-inline-action"
            onClick={() => setCreated(null)}
          >
            I have saved it
          </button>
        </div>
      )}

      <form className="token-form" onSubmit={create} noValidate>
        <div className="profile-row">
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={80}
            placeholder="What will use it, e.g. Claude Code on my laptop"
            aria-label="Token name"
          />
          <button type="submit" className="primary" disabled={!canCreate}>
            {creating ? 'Creating...' : 'Create token'}
          </button>
        </div>
        <div className="token-options">
          <div className="theme-choices" role="radiogroup" aria-label="Kind of token">
            {KINDS.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={kind === choice.id}
                className={kind === choice.id ? 'theme-choice active' : 'theme-choice'}
                onClick={() => setKind(choice.id)}
              >
                <span>{choice.label}</span>
                <span className="token-kind-hint">{choice.hint}</span>
              </button>
            ))}
          </div>
          <div className="theme-choices" role="radiogroup" aria-label="When the token expires">
            {LIFETIMES.map((choice) => (
              <button
                key={choice.label}
                type="button"
                role="radio"
                aria-checked={lifetime === choice.days}
                className={lifetime === choice.days ? 'theme-choice active' : 'theme-choice'}
                onClick={() => setLifetime(choice.days)}
              >
                <span>{choice.label}</span>
              </button>
            ))}
          </div>
        </div>
        {kind === 'classic' ? (
          <p className="hint">
            Can do anything you can do on every glade, including creating glades. Prefer a
            fine-grained token when an assistant only needs a few.
          </p>
        ) : (
          <GladePicker boards={boards} grants={grants} onChange={setGrants} />
        )}
      </form>

      {tokens === null ? (
        failed ? (
          <p className="faint">Could not load your tokens. Reload the page to try again.</p>
        ) : (
          <p className="faint">Loading...</p>
        )
      ) : tokens.length === 0 ? (
        <p className="hint">No tokens yet.</p>
      ) : (
        <ul className="session-list">
          {tokens.map((token) => (
            <li key={token.id} className="session token-row">
              <span className="session-icon" aria-hidden="true">
                <IconKey size={20} />
              </span>
              <span className="session-text">
                <span className="session-title">
                  {token.name}
                  <span className="token-kind">
                    {token.kind === 'classic' ? 'Classic' : 'Fine-grained'}
                  </span>
                </span>
                <span className="session-meta faint">
                  <span>
                    <code>{token.prefix}...</code>
                  </span>
                  <span>
                    {token.grants === null
                      ? 'All glades'
                      : token.grants.length === 1
                        ? '1 glade'
                        : `${token.grants.length} glades`}
                  </span>
                  <span
                    title={
                      token.last_used_at === null ? undefined : absoluteTime(token.last_used_at)
                    }
                  >
                    {token.last_used_at === null
                      ? 'Never used'
                      : `Used ${relativeTime(token.last_used_at)}`}
                  </span>
                  <span
                    title={token.expires_at === null ? undefined : absoluteTime(token.expires_at)}
                  >
                    {token.expires_at === null
                      ? 'Never expires'
                      : `Expires ${shortDate(token.expires_at)}`}
                  </span>
                </span>
                {token.grants !== null && editing !== token.id && (
                  <span className="token-grants">
                    {token.grants.map((grant) => (
                      <span key={grant.board_id} className="token-grant">
                        {grant.title}: {grantPhrase(grant)}
                      </span>
                    ))}
                  </span>
                )}
              </span>
              <span className="token-actions">
                {token.grants !== null && editing !== token.id && (
                  <button
                    type="button"
                    className="ghost profile-connect"
                    onClick={() => startEditing(token)}
                  >
                    Change glades
                  </button>
                )}
                <button
                  type="button"
                  className="danger profile-connect"
                  disabled={revoking === token.id}
                  onClick={() => void revoke(token)}
                >
                  {revoking === token.id ? 'Revoking...' : 'Revoke'}
                </button>
              </span>
              {editing === token.id && (
                <div className="token-edit">
                  <GladePicker boards={boards} grants={draft} onChange={setDraft} />
                  <div className="token-edit-actions">
                    <button type="button" className="ghost" onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="primary"
                      disabled={saving || Object.keys(draft).length === 0}
                      onClick={() => void saveGrants(token)}
                    >
                      {saving ? 'Saving...' : 'Save permissions'}
                    </button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
