import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Avatar } from '../../ui/Avatar'
import { Mark, Wordmark } from '../../ui/Brand'
import {
  IconCheck,
  IconChevronDown,
  IconClock,
  IconGrid,
  IconMenu,
  IconPlus,
  IconSearch,
  IconTrash,
} from '../../ui/icons'
import { useConfirm } from '../../ui/ConfirmDialog'
import { usePrompt } from '../../ui/PromptDialog'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import type { Board, BoardKind } from '../../lib/api'
import { useAuth } from '../auth/AuthContext'
import { BOARD_KINDS, boardKind } from './kinds'

type Props = {
  onOpen: (boardId: string, kind: BoardKind) => void
}

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

const VIEW_KEY = 'meadow.view'

/**
 * The view you were last on.
 *
 * Remembered so that coming back from a board returns you where you were rather than
 * to Everything. Back out of a lea and you are on Leas again, which is the only place
 * "back" could sensibly mean. Kept here rather than in the URL because the board's own
 * address already carries what it needs, and a second thing in the hash would make the
 * list's address change as you click around it.
 */
function readView(): string {
  try {
    return localStorage.getItem(VIEW_KEY) ?? 'all'
  } catch {
    // Private-mode Safari throws. A remembered filter is not worth a crash.
    return 'all'
  }
}

function writeView(id: string): void {
  try {
    localStorage.setItem(VIEW_KEY, id)
  } catch {
    // As above: it still applies for this session.
  }
}

/**
 * One entry in the sidebar.
 *
 * A filter carries its own predicate rather than being decoded by a switch further
 * down. That is what lets the kind group be generated from the registry: adding a kind
 * of glade adds a filter and a count with no edit to this file.
 */
type Filter = {
  id: string
  label: string
  Icon: typeof IconGrid
  match: (board: Board) => boolean
}

/**
 * What the sidebar is for: what a thing is, and how recently you touched it.
 *
 * Ownership used to be two more entries here, and it did not belong. "Owned by me" and
 * "Shared with me" are not places, they are a question you occasionally ask about the
 * list you are already looking at, and giving them the same weight as a whole kind of
 * board made a four-item menu out of one dropdown. They are in the header now.
 */
const VIEWS: readonly Filter[] = [
  { id: 'all', label: 'Everything', Icon: IconGrid, match: () => true },
  {
    id: 'recent',
    label: 'Recent',
    Icon: IconClock,
    match: (board) => Date.now() - new Date(board.updated_at).getTime() < RECENT_WINDOW_MS,
  },
]

const KIND_VIEWS: readonly Filter[] = BOARD_KINDS.map((kind) => ({
  id: `kind:${kind.id}`,
  label: kind.plural,
  Icon: kind.Icon,
  match: (board: Board) => board.kind === kind.id,
}))

const FILTERS: readonly Filter[] = [...VIEWS, ...KIND_VIEWS]

/** Whose it is. A header control, because it narrows whatever the sidebar selected. */
type OwnerId = 'anyone' | 'mine' | 'shared'

const OWNERS: { id: OwnerId; label: string; match: (board: Board) => boolean }[] = [
  { id: 'anyone', label: 'Anyone', match: () => true },
  { id: 'mine', label: 'Owned by me', match: (board) => board.role === 'owner' },
  { id: 'shared', label: 'Shared with me', match: (board) => board.role !== 'owner' },
]

type SortId = 'modified' | 'created' | 'title'

const SORTS: { id: SortId; label: string }[] = [
  { id: 'modified', label: 'Last modified' },
  { id: 'created', label: 'Date created' },
  { id: 'title', label: 'Name' },
]

/** "Edited 3 days ago", the way every file browser says it. */
function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''

  const seconds = Math.max(0, (Date.now() - then) / 1000)
  if (seconds < 90) return 'just now'

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2592000, 'month'],
    [31536000, 'year'],
  ]

  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let divisor = 60
  for (const [size, name] of units) {
    if (seconds < size * 60 || name === 'year') {
      unit = name
      divisor = size
      break
    }
  }

  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    -Math.round(seconds / divisor),
    unit,
  )
}

/**
 * A board's preview image.
 *
 * Loaded per card rather than with the list, because the list response is metadata and
 * a board that has never been opened has no preview at all. The object URL is revoked
 * on unmount; leaking one per card would hold the decoded image alive for the session.
 */
function BoardThumbnail({ board }: { board: Board }) {
  const [url, setUrl] = useState<string | null>(null)
  const spec = boardKind(board.kind)
  const wantsImage = spec.preview === 'thumbnail'

  useEffect(() => {
    if (!wantsImage) return
    let revoked: string | null = null
    let cancelled = false

    void api.fetchThumbnail(board.id).then((next) => {
      if (next === null) return
      if (cancelled) {
        URL.revokeObjectURL(next)
        return
      }
      revoked = next
      setUrl(next)
    })

    return () => {
      cancelled = true
      if (revoked !== null) URL.revokeObjectURL(revoked)
    }
  }, [board.id, wantsImage])

  // The frame keeps its aspect ratio whether or not a preview arrives, so cards do not
  // resize under the pointer once the images land. On a kind that does not want an
  // image at all, the mark is the preview and every card of that kind matches - which
  // is the point: three leas, two of which had been opened and so had a capture of a
  // blank page, looked like three different things.
  return (
    <span className="board-thumb" aria-hidden="true">
      {url === null ? <spec.Icon size={26} className="placeholder" /> : <img src={url} alt="" />}
    </span>
  )
}

/**
 * A filter dropdown.
 *
 * A real menu rather than a native `<select>`, and the reason is the options list: a
 * browser draws that as an operating-system popup with square corners and its own
 * typography, so on a page built out of soft-edged cards the one control with a list
 * behind it looked like it came from somewhere else. This is the same `.menu` the rest
 * of the app uses, so it rounds, shadows and themes with everything around it.
 *
 * Closed by a pointer anywhere outside it or by Escape, both bound only while it is
 * open. `pointerdown` in the capture phase, so a click aimed at another control closes
 * this first rather than leaving two menus on screen.
 */
function Dropdown<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string
  value: T
  options: readonly { id: T; label: string }[]
  onChange: (id: T) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.id === value) ?? options[0]

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="dropdown" ref={root}>
      <button
        type="button"
        className="dropdown-button"
        aria-label={label}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        {current.label}
        <IconChevronDown size={14} />
      </button>

      {open && (
        <div className="menu menu-compact" role="listbox" aria-label={label}>
          {options.map((option) => (
            <button
              key={option.id}
              type="button"
              role="option"
              aria-selected={option.id === value}
              className={option.id === value ? 'menu-item selected' : 'menu-item'}
              onClick={() => {
                setOpen(false)
                onChange(option.id)
              }}
            >
              <span className="menu-label">{option.label}</span>
              {option.id === value && <IconCheck size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function BoardsPage({ onOpen }: Props) {
  const { user, logout } = useAuth()
  const confirm = useConfirm()
  const prompt = usePrompt()
  const toast = useToast()
  const [boards, setBoards] = useState<Board[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState(readView)
  const [title, setTitle] = useState('')
  const [owner, setOwner] = useState<OwnerId>('anyone')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortId>('modified')
  /*
   * The sidebar is a column on a desktop and a drawer on a phone, and this is the only
   * part of that the JSX has to know about. Which of the two it is at any width is CSS.
   */
  const [navOpen, setNavOpen] = useState(false)

  /*
   * A failed load is the only one of the three that stays on the page.
   *
   * It is not an event, it is the state of the view: there is nothing here and the
   * reason is not "you have no glades". A toast for that would take the explanation
   * away four seconds later and leave an empty page that looks like an empty account.
   */
  const reload = useCallback(async () => {
    try {
      setBoards(await api.listBoards())
      setError(null)
    } catch {
      setError('Could not load your glades.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  /*
   * Naming happens before the board exists, in a dialog with a name already in it.
   *
   * The field in the composer is still where you start, and anything typed into it is
   * what the dialog opens with; leave it blank and the dialog asks the server for the
   * same generated name `create_board` would have applied anyway. Either way the name
   * is on screen and editable at the moment it is chosen, rather than being discovered
   * afterwards in the board's own title bar.
   */
  const create = async (kind: BoardKind, name = '') => {
    if (user?.default_workspace_id == null) return
    const workspaceId = user.default_workspace_id
    const label = boardKind(kind).label.toLowerCase()

    let initial = name.trim()
    if (initial === '') {
      try {
        initial = (await api.suggestBoardTitle(workspaceId)).title
      } catch {
        // Not worth refusing to create over. An empty field means the person types a
        // name, which is what the dialog is for.
        initial = ''
      }
    }

    const chosen = await prompt({
      title: `Name your new ${label}`,
      body: `You can keep the suggested name or write your own. It is editable later, on the ${label} itself.`,
      label: 'Name',
      initial,
      placeholder: `A name for this ${label}`,
      confirmLabel: `Create ${label}`,
    })
    if (chosen === null) return

    try {
      const board = await api.createBoard(workspaceId, chosen, kind)
      setTitle('')
      toast.success(`Created the ${label} "${board.title}".`)
      onOpen(board.id, board.kind)
    } catch {
      toast.error(`Could not create that ${label}.`)
    }
  }

  const remove = async (board: Board) => {
    const kind = boardKind(board.kind).label.toLowerCase()
    const agreed = await confirm({
      title: `Delete "${board.title}"?`,
      body: `The ${kind} and everything on it goes. This cannot be undone.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!agreed) return

    try {
      await api.deleteBoard(board.id)
      await reload()
      // Deliberately not a success toast. Nothing green happened: something is gone,
      // and the card should read the way the news does.
      toast.error(`Deleted the ${kind} "${board.title}".`)
    } catch {
      toast.error(`Could not delete that ${kind}.`)
    }
  }

  // Counts come off the unfiltered list, so a sidebar number does not change as you
  // type in the search box or narrow by owner.
  const counts = useMemo(() => {
    const out: Record<string, number> = {}
    for (const filter of FILTERS) out[filter.id] = boards.filter(filter.match).length
    return out
  }, [boards])

  const active = FILTERS.find((filter) => filter.id === view) ?? VIEWS[0]
  /*
   * The kind this page is about, or null on the mixed views.
   *
   * The composer below only appears when this is set, and that is the whole answer to
   * what was wrong with it before: a card offering to name a new *glade* is the right
   * card under a heading that says Glades and a lie under one that says Everything.
   * Where there is no answer, there is no card, and the header's New menu asks.
   */
  const composing = BOARD_KINDS.find((kind) => `kind:${kind.id}` === view) ?? null
  const activeOwner = OWNERS.find((entry) => entry.id === owner) ?? OWNERS[0]

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    const filtered = boards.filter((board) => {
      if (needle !== '' && !board.title.toLowerCase().includes(needle)) return false
      return active.match(board) && activeOwner.match(board)
    })

    const by: Record<SortId, (a: Board, b: Board) => number> = {
      modified: (a, b) => b.updated_at.localeCompare(a.updated_at),
      created: (a, b) => b.created_at.localeCompare(a.created_at),
      title: (a, b) => a.title.localeCompare(b.title),
    }
    return [...filtered].sort(by[sort])
  }, [boards, query, active, activeOwner, sort])

  const group = (label: string | null, filters: readonly Filter[]) => (
    <nav className="sidebar-nav" aria-label={label ?? 'Views'}>
      {label !== null && <p className="nav-heading">{label}</p>}
      {filters.map((filter) => (
        <button
          key={filter.id}
          type="button"
          className={view === filter.id ? 'nav-item active' : 'nav-item'}
          aria-current={view === filter.id ? 'page' : undefined}
          onClick={() => {
            setView(filter.id)
            writeView(filter.id)
            // On a phone the drawer is covering the thing it just filtered.
            setNavOpen(false)
          }}
        >
          <filter.Icon size={17} />
          <span className="nav-label">{filter.label}</span>
          <span className="nav-count">{counts[filter.id]}</span>
        </button>
      ))}
    </nav>
  )

  return (
    <div className="workspace">
      {/*
        * A backdrop, not a button. Nothing here is a control: Escape closes the drawer,
        * and so does choosing any view in it.
        */}
      {navOpen && (
        <div className="sidebar-scrim" aria-hidden="true" onClick={() => setNavOpen(false)} />
      )}

      <aside className={navOpen ? 'sidebar open' : 'sidebar'}>
        <div className="sidebar-brand">
          <Wordmark />
        </div>

        <div className="sidebar-search">
          <IconSearch size={16} />
          <input
            value={query}
            placeholder="Search glades"
            aria-label="Search glades"
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>

        <div className="sidebar-groups">
          {group(null, VIEWS)}
          {group('Kinds', KIND_VIEWS)}
        </div>

        {/* The account, and the one action that is about the account. The theme
            control used to live here too; it is a setting rather than a place, and it
            is on the profile page under Appearance now. */}
        <div className="sidebar-foot">
          <button
            type="button"
            className="user-chip"
            onClick={() => {
              location.hash = '#/profile'
            }}
          >
            <Avatar name={user?.display_name ?? '?'} url={user?.avatar_url} />
            <span className="name">{user?.display_name}</span>
          </button>
          <button type="button" className="sign-out" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="workspace-head">
          <button
            type="button"
            className="icon ghost nav-toggle"
            aria-label="Menu"
            aria-expanded={navOpen}
            onClick={() => setNavOpen(true)}
          >
            <IconMenu />
          </button>
          <h1>{active.label}</h1>
          <span className="faint">{visible.length}</span>
          <div className="spacer" />

          {/*
            Two filters and no create control.
            Making something happens on a kind's own page, where the composer already
            knows what it is making. A New button here would be a third place to start
            one and the only one that has to ask an extra question first.
          */}
          <Dropdown label="Show" value={owner} options={OWNERS} onChange={setOwner} />
          <Dropdown label="Sort by" value={sort} options={SORTS} onChange={setSort} />
        </header>

        {composing !== null && (
          <div className={`composer kind-${composing.id}`}>
            <div className="composer-row">
              {/* The kind, stated rather than offered. The page has already chosen it,
                  and a picker here would be a second control disagreeing with the
                  heading above it. */}
              <span className="composer-kind">
                <composing.Icon size={16} />
                {composing.label}
              </span>
              <input
                value={title}
                placeholder={composing.placeholder}
                aria-label={`New ${composing.label.toLowerCase()} name`}
                onChange={(event) => setTitle(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void create(composing.id, title)
                }}
              />
              <button
                type="button"
                className="primary"
                onClick={() => void create(composing.id, title)}
              >
                <IconPlus size={16} />
                Create {composing.label.toLowerCase()}
              </button>
            </div>

            <p className="composer-hint">{composing.blurb}</p>
          </div>
        )}

        {error !== null && (
          <p className="error">
            {error}
            <button type="button" className="link" onClick={() => void reload()}>
              Try again
            </button>
          </p>
        )}

        {loading ? (
          <ul className="board-grid">
            {[0, 1, 2, 3].map((slot) => (
              <li key={slot} className="skeleton" aria-hidden="true" />
            ))}
          </ul>
        ) : visible.length === 0 ? (
          <div className="empty-state">
            <Mark className="mark empty-mark" />
            {boards.length === 0 ? (
              <>
                <p>Nothing here yet.</p>
                <p className="faint">
                  Pick a kind on the left: a glade to draw on, or a lea to write in.
                </p>
              </>
            ) : (
              <>
                <p>Nothing here.</p>
                <p className="faint">
                  Nothing matches {query.trim() === '' ? `"${active.label}"` : `"${query.trim()}"`}.
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="board-grid">
            {visible.map((board) => {
              const spec = boardKind(board.kind)
              return (
                <li key={board.id} className={`board-card kind-${spec.id}`}>
                  <button
                    type="button"
                    className="board-open"
                    onClick={() => onOpen(board.id, board.kind)}
                  >
                    <BoardThumbnail board={board} />
                    <span className="board-meta">
                      <span className="board-text">
                        <span className="board-title">{board.title}</span>
                        <span className="board-sub">
                          {/* Only where the list is mixed. Under a heading that says
                              Leas, a Lea badge on every card is the heading repeated
                              once per row. */}
                          {composing === null && (
                            <span className="kind-badge">
                              <spec.Icon size={12} />
                              {spec.label}
                            </span>
                          )}
                          Edited {relativeTime(board.updated_at)}
                        </span>
                      </span>
                      <span className={`role role-${board.role}`}>{board.role}</span>
                    </span>
                  </button>

                  {board.role === 'owner' && (
                    <button
                      type="button"
                      className="card-delete"
                      title={`Delete ${board.title}`}
                      aria-label={`Delete ${board.title}`}
                      onClick={() => void remove(board)}
                    >
                      <IconTrash size={15} />
                    </button>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}
