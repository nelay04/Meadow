import { useCallback, useEffect, useMemo, useState } from 'react'

import { Avatar } from '../../ui/Avatar'
import { Mark, Wordmark } from '../../ui/Brand'
import {
  IconCanvas,
  IconClock,
  IconGrid,
  IconMenu,
  IconPlus,
  IconSearch,
  IconShared,
  IconTrash,
  IconUser,
} from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import type { Board } from '../../lib/api'
import { useAuth } from '../auth/AuthContext'

type Props = {
  onOpen: (boardId: string) => void
}

/**
 * The sidebar's filters.
 *
 * Every one of these is derived from data the list endpoint already returns, so none
 * of them is a label over an empty room: `recent` reads `updated_at`, and `owned` and
 * `shared` read the resolved role.
 */
type ViewId = 'all' | 'recent' | 'owned' | 'shared'

const VIEWS: { id: ViewId; label: string; Icon: typeof IconGrid }[] = [
  { id: 'all', label: 'All glades', Icon: IconGrid },
  { id: 'recent', label: 'Recent', Icon: IconClock },
  { id: 'owned', label: 'Owned by me', Icon: IconUser },
  { id: 'shared', label: 'Shared with me', Icon: IconShared },
]

const RECENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

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
function BoardThumbnail({ boardId }: { boardId: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let revoked: string | null = null
    let cancelled = false

    void api.fetchThumbnail(boardId).then((next) => {
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
  }, [boardId])

  // The frame keeps its aspect ratio whether or not a preview arrives, so cards do
  // not resize under the pointer once the images land.
  return (
    <span className="board-thumb" aria-hidden="true">
      {url === null ? <IconCanvas size={26} className="placeholder" /> : <img src={url} alt="" />}
    </span>
  )
}

export default function BoardsPage({ onOpen }: Props) {
  const { user, logout } = useAuth()
  const confirm = useConfirm()
  const toast = useToast()
  const [boards, setBoards] = useState<Board[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewId>('all')
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortId>('modified')
  /*
   * The sidebar is a column on a desktop and a drawer on a phone, and this is the
   * only part of that the JSX has to know about. Which of the two it is at any width
   * is CSS: at desktop widths the drawer class does nothing, so this can stay false
   * forever without the sidebar ever disappearing.
   */
  const [navOpen, setNavOpen] = useState(false)

  /*
   * A failed load is the only one of the three that stays on the page.
   *
   * It is not an event, it is the state of the view: there is nothing here and the
   * reason is not "you have no glades". A toast for that would take the explanation
   * away four seconds later and leave an empty page that looks like an empty account.
   * The two below are events, and they toast.
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

  // Escape closes the drawer, which is the keyboard's way out now that the backdrop
  // is not a control. Bound only while it is open, so nothing listens for nothing.
  useEffect(() => {
    if (!navOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setNavOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [navOpen])

  const create = async () => {
    if (user?.default_workspace_id == null) return
    try {
      const board = await api.createBoard(user.default_workspace_id, title.trim() || 'Untitled')
      setTitle('')
      onOpen(board.id)
    } catch {
      toast.error('Could not create that glade.')
    }
  }

  const remove = async (board: Board) => {
    const agreed = await confirm({
      title: `Delete "${board.title}"?`,
      body: 'The glade and everything on it goes. This cannot be undone.',
      confirmLabel: 'Delete glade',
      tone: 'danger',
    })
    if (!agreed) return

    try {
      await api.deleteBoard(board.id)
      await reload()
      toast.success(`Deleted "${board.title}".`)
    } catch {
      toast.error('Could not delete that glade.')
    }
  }

  // Counts come off the unfiltered list, so a sidebar number does not change as you
  // type in the search box.
  const counts = useMemo(
    () => ({
      all: boards.length,
      recent: boards.filter((b) => Date.now() - new Date(b.updated_at).getTime() < RECENT_WINDOW_MS)
        .length,
      owned: boards.filter((b) => b.role === 'owner').length,
      shared: boards.filter((b) => b.role !== 'owner').length,
    }),
    [boards],
  )

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase()

    const filtered = boards.filter((board) => {
      if (needle !== '' && !board.title.toLowerCase().includes(needle)) return false
      if (view === 'owned') return board.role === 'owner'
      if (view === 'shared') return board.role !== 'owner'
      if (view === 'recent') {
        return Date.now() - new Date(board.updated_at).getTime() < RECENT_WINDOW_MS
      }
      return true
    })

    const by: Record<SortId, (a: Board, b: Board) => number> = {
      modified: (a, b) => b.updated_at.localeCompare(a.updated_at),
      created: (a, b) => b.created_at.localeCompare(a.created_at),
      title: (a, b) => a.title.localeCompare(b.title),
    }
    return [...filtered].sort(by[sort])
  }, [boards, query, view, sort])

  const viewLabel = VIEWS.find((entry) => entry.id === view)?.label ?? 'All glades'

  return (
    <div className="workspace">
      {/*
        * A backdrop, not a button.
        *
        * It was a button, and the generic `button:hover` rule painted it opaque cream
        * over the whole page the moment a pointer crossed it. Raising its specificity
        * would have worked and would have been a lie about what it is: nothing here is
        * a control. Escape closes the drawer, and so does choosing any view in it.
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

        <nav className="sidebar-nav" aria-label="Views">
          {VIEWS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={view === entry.id ? 'nav-item active' : 'nav-item'}
              aria-current={view === entry.id ? 'page' : undefined}
              onClick={() => {
                setView(entry.id)
                // On a phone the drawer is covering the thing it just filtered.
                setNavOpen(false)
              }}
            >
              <entry.Icon size={17} />
              <span className="nav-label">{entry.label}</span>
              <span className="nav-count">{counts[entry.id]}</span>
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          {/* The chip was a label and is now the way to the profile page: it is
              already the one place on this screen that names the account. */}
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
          <div className="btn-row">
            <ThemeToggle />
            <button type="button" className="ghost" onClick={() => void logout()}>
              Log out
            </button>
          </div>
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
          <h1>{viewLabel}</h1>
          <span className="faint">{visible.length}</span>
          <div className="spacer" />
          <label className="sort">
            <span className="visually-hidden">Sort by</span>
            <select value={sort} onChange={(event) => setSort(event.target.value as SortId)}>
              {SORTS.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
        </header>

        <div className="composer">
          <input
            value={title}
            placeholder="Name a new glade, then press Enter"
            aria-label="New glade name"
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
          />
          <button type="button" className="primary" onClick={() => void create()}>
            <IconPlus size={16} />
            Create glade
          </button>
        </div>

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
                <p>No glades yet.</p>
                <p className="faint">Name one above and it opens straight onto the canvas.</p>
              </>
            ) : (
              <>
                <p>Nothing here.</p>
                <p className="faint">
                  No glade matches {query.trim() === '' ? `"${viewLabel}"` : `"${query.trim()}"`}.
                </p>
              </>
            )}
          </div>
        ) : (
          <ul className="board-grid">
            {visible.map((board) => (
              <li key={board.id} className="board-card">
                <button type="button" className="board-open" onClick={() => onOpen(board.id)}>
                  <BoardThumbnail boardId={board.id} />
                  <span className="board-meta">
                    <span className="board-text">
                      <span className="board-title">{board.title}</span>
                      <span className="board-sub">Edited {relativeTime(board.updated_at)}</span>
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
            ))}
          </ul>
        )}
      </main>
    </div>
  )
}
