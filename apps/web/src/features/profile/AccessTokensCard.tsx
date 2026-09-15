import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'

import { IconCopy, IconKey, IconPlus } from '../../ui/icons'
import { absoluteTime, relativeTime } from '../../ui/time'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import type { AccessToken, AccessTokenGrantInput, Board, CreatedAccessToken } from '../../lib/api'
import { copy } from '../../lib/clipboard'
import { roleCanWrite } from '../../doc/mutations'
import { boardKind } from '../boards/kinds'

type Kind = AccessToken['kind']
type Permission = 'read' | 'edit' | 'delete'
/** Glade id to what is granted on it. A glade that is not a key is not granted. */
export type Grants = Record<string, { edit: boolean; delete: boolean }>

const KINDS: { id: Kind; label: string; hint: string }[] = [
  {
    id: 'classic',
    label: 'Classic',
    hint: 'Everything you can do, on every glade and lea',
  },
  {
    id: 'fine_grained',
    label: 'Fine-grained',
    hint: 'Only what you pick, with the permissions you pick',
  },
]

/** Days, 'custom' for a date picked by hand, or null for never. Never is not the default. */
type Lifetime = number | 'custom' | null

const LIFETIMES: { days: Lifetime; label: string }[] = [
  { days: 7, label: '7 days' },
  { days: 30, label: '30 days' },
  { days: 90, label: '90 days' },
  { days: 'custom', label: 'Custom' },
  { days: null, label: 'Never' },
]

/** The server's own ceiling on `expires_in_days`. */
const MAX_LIFETIME_DAYS = 366

const DAY_MS = 86_400_000

/** Midnight today, local time, plus some days. */
function daysFromToday(days: number): Date {
  const when = new Date()
  when.setHours(0, 0, 0, 0)
  when.setDate(when.getDate() + days)
  return when
}

/** A local date as the `yyyy-mm-dd` a date input reads and writes. */
function inputDate(when: Date): string {
  const month = String(when.getMonth() + 1).padStart(2, '0')
  const day = String(when.getDate()).padStart(2, '0')
  return `${when.getFullYear()}-${month}-${day}`
}

/**
 * Whole days from today to a picked `yyyy-mm-dd`, or null when it is not a date in range.
 * Parsed as local midnight, not with `new Date(text)`, which reads a bare date as UTC and
 * lands on the day before for anyone west of Greenwich.
 */
function daysUntil(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text)
  if (match === null) return null
  const picked = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  const days = Math.round((picked.getTime() - daysFromToday(0).getTime()) / DAY_MS)
  return days >= 1 && days <= MAX_LIFETIME_DAYS ? days : null
}

/** "12 Dec 2026", for the date a lifetime ends on. Estimated: it counts from creation. */
function endsOn(days: number): string {
  return shortDate(daysFromToday(days).toISOString())
}

const PERMISSIONS: { id: Permission; label: string }[] = [
  { id: 'read', label: 'View' },
  { id: 'edit', label: 'Edit' },
  { id: 'delete', label: 'Delete' },
]

/** "12 Dec 2026". `relativeTime` only speaks about the past, and an expiry is ahead. */
function shortDate(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

/**
 * "1 glade, 2 leas". Counted per kind, because a list that called every lea a glade was
 * technically right and read as wrong: nobody thinks of their diary as a glade.
 */
function reachPhrase(kinds: (string | undefined)[]): string {
  if (kinds.length === 0) return 'Nothing chosen'
  const counts = new Map<string, number>()
  for (const kind of kinds) {
    const spec = boardKind(kind)
    counts.set(spec.id, (counts.get(spec.id) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([id, count]) => {
      const spec = boardKind(id)
      return `${count} ${(count === 1 ? spec.label : spec.plural).toLowerCase()}`
    })
    .join(', ')
}

/** The kind's mark and name, as a small badge. */
function KindMark({ kind }: { kind: string | undefined }) {
  const spec = boardKind(kind)
  return (
    <span className={`kind-mark kind-mark-${spec.id}`} title={spec.label}>
      <spec.Icon size={13} />
      {spec.label}
    </span>
  )
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

export function toInput(grants: Grants): AccessTokenGrantInput[] {
  return Object.entries(grants).map(([board_id, grant]) => ({
    board_id,
    read: true,
    ...grant,
  }))
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
export function GladePicker({ boards, grants, onChange }: PickerProps) {
  const [filter, setFilter] = useState('')
  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    return (boards ?? []).filter(
      (board) => needle === '' || board.title.toLowerCase().includes(needle),
    )
  }, [boards, filter])

  if (boards === null) return <p className="faint">Loading your glades...</p>
  if (boards.length === 0) return <p className="hint">You have no glades or leas to grant yet.</p>

  const chosen = Object.keys(grants).length
  const kindOf = new Map(boards.map((board) => [board.id, board.kind]))
  return (
    <div className="grant-picker">
      <div className="grant-picker-head">
        <span className="faint">
          {chosen === 0
            ? 'Nothing chosen yet'
            : `${reachPhrase(Object.keys(grants).map((id) => kindOf.get(id)))} chosen`}
        </span>
        {boards.length > 6 && (
          <input
            className="grant-filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter by name"
            aria-label="Filter by name"
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
                <KindMark kind={board.kind} />
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
 * Whether a fine-grained token may make new glades.
 *
 * Its own control rather than a fourth column in the picker: making a glade is not
 * something done *to* a glade, and what it grants is on glades that do not exist yet. A
 * glade the token makes joins its list with edit and delete, which is said here rather
 * than left to be discovered, since it is the one way a token's reach grows without its
 * owner editing it.
 */
export function CreateToggle({ on, onChange }: { on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      className={on ? 'token-create on' : 'token-create'}
      onClick={() => onChange(!on)}
    >
      <span className="switch-track" aria-hidden="true">
        <span className="switch-thumb" />
      </span>
      <span className="token-create-text">
        <span className="token-create-label">Allow making new glades and leas</span>
        <span className="token-create-hint">
          {on
            ? 'It can make new ones in your workspace, and gets edit and delete on each one it makes.'
            : 'Off: it can only open what you ticked in the list.'}
        </span>
      </span>
    </button>
  )
}

/**
 * Personal access tokens, for AI assistants and scripts.
 *
 * Two cards, the tokens you have and the form for a new one. Its own component because
 * this is the only part of the profile holding a secret: the raw token lives in `created` for as long as the
 * person needs to copy it and is dropped the moment they dismiss it. It is never written
 * anywhere else, and the list the server sends back cannot reproduce it.
 */
export function AccessTokensCard() {
  const toast = useToast()
  const confirm = useConfirm()
  const [tokens, setTokens] = useState<AccessToken[] | null>(null)
  const [boards, setBoards] = useState<Board[] | null>(null)
  const [failed, setFailed] = useState(false)
  // The steps stay folded until asked for, so the card is a title and a button until
  // somebody actually wants a token.
  const [composing, setComposing] = useState(false)
  const [name, setName] = useState('')
  const [kind, setKind] = useState<Kind>('fine_grained')
  const [grants, setGrants] = useState<Grants>({})
  // Whether a new fine-grained token may make glades. Off by default: a token that can
  // make things is a wider token, so it is asked for rather than assumed.
  const [mayCreate, setMayCreate] = useState(false)
  const [lifetime, setLifetime] = useState<Lifetime>(90)
  const [customDate, setCustomDate] = useState(() => inputDate(daysFromToday(60)))
  const [creating, setCreating] = useState(false)
  const [created, setCreated] = useState<CreatedAccessToken | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  // The token whose glades are being changed, and the draft of them.
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState<Grants>({})
  const [draftCreate, setDraftCreate] = useState(false)
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

  // A fine-grained token has to be able to reach something: either glades it names, or
  // leave to make its own.
  const customDays = daysUntil(customDate)
  const canCreate =
    name.trim() !== '' &&
    !creating &&
    (kind === 'classic' || mayCreate || Object.keys(grants).length > 0) &&
    (lifetime !== 'custom' || customDays !== null)

  const resetComposer = () => {
    setComposing(false)
    setName('')
    setKind('fine_grained')
    setGrants({})
    setMayCreate(false)
    setLifetime(90)
    setCustomDate(inputDate(daysFromToday(60)))
  }

  const create = async (event: FormEvent) => {
    event.preventDefault()
    if (!canCreate) return
    setCreating(true)
    try {
      // Counted again here rather than taken from the render: a form left open past
      // midnight would otherwise send yesterday's count and expire a day late.
      const days = lifetime === 'custom' ? daysUntil(customDate) : lifetime
      if (lifetime === 'custom' && days === null) {
        toast.error('Pick an expiry date between tomorrow and a year from now.')
        return
      }
      const expiry = days === null ? {} : { expires_in_days: days }
      const token = await api.createAccessToken(
        kind === 'classic'
          ? { name: name.trim(), kind, ...expiry }
          : {
              name: name.trim(),
              kind,
              grants: toInput(grants),
              can_create: mayCreate,
              ...expiry,
            },
      )
      setCreated(token)
      resetComposer()
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
    setDraftCreate(token.can_create)
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
    if (Object.keys(draft).length === 0 && !draftCreate) return
    setSaving(true)
    try {
      await api.updateAccessToken(token.id, {
        grants: toInput(draft),
        can_create: draftCreate,
      })
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

  // A grant carries a title but not a kind, so the kind is looked up from your glades.
  // One you have since lost access to falls back to the default mark.
  const kindOf = new Map((boards ?? []).map((board) => [board.id, board.kind]))

  const renderToken = (token: AccessToken) => (
    <li key={token.id} className="token-row">
      <div className="token-row-head">
        <span className="token-icon" aria-hidden="true">
          <IconKey size={18} />
        </span>
        <span className="token-row-title">
          <span className="token-name">{token.name}</span>
          <span className={token.kind === 'classic' ? 'token-kind classic' : 'token-kind'}>
            {token.kind === 'classic' ? 'Classic' : 'Fine-grained'}
          </span>
        </span>
        <span className="token-actions">
          {token.grants !== null && editing !== token.id && (
            <button
              type="button"
              className="ghost profile-connect"
              onClick={() => startEditing(token)}
            >
              Change permissions
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
      </div>

      <dl className="token-facts">
        <div>
          <dt>Prefix</dt>
          <dd>
            <code>{token.prefix}...</code>
          </dd>
        </div>
        <div>
          <dt>Reach</dt>
          <dd>
            {token.grants === null
              ? 'Everything'
              : reachPhrase(token.grants.map((grant) => kindOf.get(grant.board_id)))}
            {token.kind === 'fine_grained' && token.can_create && ', can create'}
          </dd>
        </div>
        <div>
          <dt>Last used</dt>
          <dd title={token.last_used_at === null ? undefined : absoluteTime(token.last_used_at)}>
            {token.last_used_at === null ? 'Never' : relativeTime(token.last_used_at)}
          </dd>
        </div>
        <div>
          <dt>Expires</dt>
          <dd title={token.expires_at === null ? undefined : absoluteTime(token.expires_at)}>
            {token.expires_at === null ? 'Never' : shortDate(token.expires_at)}
          </dd>
        </div>
      </dl>

      {token.grants !== null && token.grants.length > 0 && editing !== token.id && (
        <span className="token-grants">
          {token.grants.map((grant) => (
            <span key={grant.board_id} className="token-grant">
              <KindMark kind={kindOf.get(grant.board_id)} />
              <strong>{grant.title}</strong> {grantPhrase(grant)}
            </span>
          ))}
        </span>
      )}

      {editing === token.id && (
        <div className="token-edit">
          <GladePicker boards={boards} grants={draft} onChange={setDraft} />
          <CreateToggle on={draftCreate} onChange={setDraftCreate} />
          <div className="token-edit-actions">
            <button type="button" className="ghost" onClick={() => setEditing(null)}>
              Cancel
            </button>
            <button
              type="button"
              className="primary"
              disabled={saving || (Object.keys(draft).length === 0 && !draftCreate)}
              onClick={() => void saveGrants(token)}
            >
              {saving ? 'Saving...' : 'Save permissions'}
            </button>
          </div>
        </div>
      )}
    </li>
  )

  // Tokens made by hand and tokens an assistant was handed by signing in are the same
  // credential, but they are looked for in different places: one by the name you gave
  // it, the other by the assistant that asked.
  const personal = tokens?.filter((token) => token.client_name === null) ?? []
  const connected = tokens?.filter((token) => token.client_name !== null) ?? []

  return (
    <>
      <section className="card token-card">
        <h3>Your tokens</h3>
        <p className="hint">
          For AI assistants and scripts that read or edit your glades and leas through the Meadow
          MCP server. A token acts as you, and can never do more than you can.
        </p>

        {tokens === null ? (
          failed ? (
            <p className="faint token-empty">
              Could not load your tokens. Reload the page to try again.
            </p>
          ) : (
            <p className="faint token-empty">Loading...</p>
          )
        ) : tokens.length === 0 ? (
          <div className="token-empty-state">
            <IconKey size={22} />
            <p className="hint">
              No tokens yet. Create one below to connect an assistant or a script.
            </p>
          </div>
        ) : (
          <>
            {personal.length > 0 && (
              <div className="token-group">
                <h4 className="token-group-title">
                  Personal tokens <span className="token-count">{personal.length}</span>
                </h4>
                <ul className="token-list">{personal.map(renderToken)}</ul>
              </div>
            )}
            {connected.length > 0 && (
              <div className="token-group">
                <h4 className="token-group-title">
                  Connected by signing in <span className="token-count">{connected.length}</span>
                </h4>
                <p className="hint">
                  Handed to an assistant when you approved it on the consent screen.
                </p>
                <ul className="token-list">{connected.map(renderToken)}</ul>
              </div>
            )}
          </>
        )}
      </section>

      {/* Its own card, after the list: making a token is a separate job from looking
          after the ones you have, and the form is long enough to deserve the room. */}
      <section className="card token-card">
        <div className="token-create-head">
          <div>
            <h3>Create a token</h3>
            <p className="hint">
              Four steps. The token is shown once, right here, when you create it.
            </p>
          </div>
          {!composing && (
            <button type="button" className="primary" onClick={() => setComposing(true)}>
              <IconPlus size={16} />
              Create new access token
            </button>
          )}
        </div>

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

        {composing && (
          <form className="token-compose" onSubmit={create} noValidate>
            <div className="token-step">
              <span className="token-step-num" aria-hidden="true">
                1
              </span>
              <div className="token-step-body">
                <h5>Name</h5>
                <p className="hint">
                  Name it after what will use it, so you can tell it apart later.
                </p>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={80}
                  placeholder="e.g. AI assistant on my laptop"
                  aria-label="Token name"
                  autoFocus
                />
              </div>
            </div>

            <div className="token-step">
              <span className="token-step-num" aria-hidden="true">
                2
              </span>
              <div className="token-step-body">
                <h5>Kind</h5>
                <div className="token-kinds" role="radiogroup" aria-label="Kind of token">
                  {KINDS.map((choice) => (
                    <button
                      key={choice.id}
                      type="button"
                      role="radio"
                      aria-checked={kind === choice.id}
                      className={
                        kind === choice.id ? 'token-kind-choice active' : 'token-kind-choice'
                      }
                      onClick={() => setKind(choice.id)}
                    >
                      <span className="token-kind-label">{choice.label}</span>
                      <span className="token-kind-hint">{choice.hint}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="token-step">
              <span className="token-step-num" aria-hidden="true">
                3
              </span>
              <div className="token-step-body">
                <h5>Access</h5>
                {kind === 'classic' ? (
                  <p className="hint">
                    Can do anything you can do on every glade and lea, including making new ones.
                    Prefer a fine-grained token when an assistant only needs a few.
                  </p>
                ) : (
                  <>
                    <p className="hint">Tick what it may open, and what it may do on each.</p>
                    <GladePicker boards={boards} grants={grants} onChange={setGrants} />
                    <CreateToggle on={mayCreate} onChange={setMayCreate} />
                  </>
                )}
              </div>
            </div>

            <div className="token-step">
              <span className="token-step-num" aria-hidden="true">
                4
              </span>
              <div className="token-step-body">
                <h5>Expires</h5>
                <p className="hint">
                  Dates are estimated from today. The clock starts when you create the token.
                </p>
                <div
                  className="token-lifetimes"
                  role="radiogroup"
                  aria-label="When the token expires"
                >
                  {LIFETIMES.map((choice) => (
                    <button
                      key={choice.label}
                      type="button"
                      role="radio"
                      aria-checked={lifetime === choice.days}
                      className={lifetime === choice.days ? 'grant-toggle on' : 'grant-toggle'}
                      onClick={() => setLifetime(choice.days)}
                    >
                      {choice.label}
                      {typeof choice.days === 'number' && (
                        <span className="token-lifetime-date">({endsOn(choice.days)})</span>
                      )}
                    </button>
                  ))}
                </div>
                {lifetime === 'custom' && (
                  <div className="token-custom-expiry">
                    <input
                      type="date"
                      value={customDate}
                      min={inputDate(daysFromToday(1))}
                      max={inputDate(daysFromToday(MAX_LIFETIME_DAYS))}
                      onChange={(event) => setCustomDate(event.target.value)}
                      aria-label="Expiry date"
                    />
                    <span className={customDays === null ? 'hint token-expiry-error' : 'hint'}>
                      {customDays === null
                        ? `Pick a date between tomorrow and ${endsOn(MAX_LIFETIME_DAYS)}.`
                        : `Expires in ${customDays} ${customDays === 1 ? 'day' : 'days'}.`}
                    </span>
                  </div>
                )}
                {lifetime === null && (
                  <p className="hint token-expiry-warning">
                    A token that never expires keeps working until you revoke it. Prefer a date for
                    anything you do not watch closely.
                  </p>
                )}
              </div>
            </div>

            <div className="token-compose-actions">
              <button type="button" className="ghost" onClick={resetComposer}>
                Cancel
              </button>
              <button type="submit" className="primary" disabled={!canCreate}>
                {creating ? 'Creating...' : 'Create token'}
              </button>
            </div>
          </form>
        )}
      </section>
    </>
  )
}
