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
  IconPencil,
  IconRestore,
  IconTrash,
} from '../../ui/icons'
import { useConfirm } from '../../ui/ConfirmDialog'
import { usePrompt } from '../../ui/PromptDialog'
import { useToast } from '../../ui/Toaster'
import { relativeTime } from '../../ui/time'
import { roleCanWrite } from '../../doc/mutations'
import * as api from '../../lib/api'
import type { Board, BoardKind, TrashedBoard } from '../../lib/api'
import { useTrashRetentionHours } from '../../lib/appConfig'
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

/**
 * The trash, which is a place and not a filter.
 *
 * Deliberately outside `FILTERS`: every entry there is a predicate over the list of
 * boards, and this one is a different list entirely - a different request, different
 * cards, and two actions no board card has. Keeping it out of that array is what stops
 * a filter's predicate ever being asked about a board that has been deleted.
 */
const TRASH_VIEW = 'trash'

/** "30 days", "6 hours" - the retention window, said the way a person would say it. */
function windowLabel(hours: number): string {
  if (hours <= 0) return 'no time at all'
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'}`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'}`
}

/** "in 3 days" - what is left before a board in the trash goes for good. */
function timeLeft(purgeAfter: string): string {
  const ms = new Date(purgeAfter).getTime() - Date.now()
  if (!Number.isFinite(ms)) return ''
  if (ms <= 0) return 'any moment now'

  const hours = ms / 3600_000
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (hours < 1) return format.format(Math.max(1, Math.round(ms / 60_000)), 'minute')
  if (hours < 48) return format.format(Math.round(hours), 'hour')
  return format.format(Math.round(hours / 24), 'day')
}

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
  const [trashed, setTrashed] = useState<TrashedBoard[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // How long this deployment keeps things. For the sentence under the heading; the
  // countdown on each card is the server's own arithmetic, off `purge_after`.
  const retentionHours = useTrashRetentionHours()
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

  /*
   * The trash, which is its own request.
   *
   * Loaded whenever it is looked at rather than with the board list, because it is a
   * list most people never open and a second query on every visit to pay for a view
   * nobody asked for. Refreshed after a delete too, so the count beside it is right
   * without having to go and look.
   */
  const reloadTrash = useCallback(async () => {
    try {
      setTrashed(await api.listTrash())
    } catch {
      // Quiet: the trash is a place you go, and the empty state below says what it
      // says. A toast here would fire on a page nobody navigated to.
    }
  }, [])

  useEffect(() => {
    void reload()
    void reloadTrash()
  }, [reload, reloadTrash])

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

  /*
   * Renaming from the list.
   *
   * The name field on the board itself was the only place to do this, which is fine
   * when you are already inside - and wrong when you are looking at a wall of cards and
   * one of them is called "Untitled meadow". Opening a glade to rename it means loading
   * a canvas, a document and a websocket to change one string.
   *
   * Offered to editors, not only owners: renaming is what `PATCH /boards/{id}` has
   * always allowed an editor to do, and the field inside the board has always let them.
   * The list refusing it would be a third opinion about a permission, which is the
   * thing ARCHITECTURE 7 is about.
   */
  const rename = async (board: Board) => {
    const kind = boardKind(board.kind).label.toLowerCase()
    const chosen = await prompt({
      title: `Rename “${board.title}”`,
      label: 'Name',
      initial: board.title,
      placeholder: `A name for this ${kind}`,
      confirmLabel: 'Rename',
    })
    if (chosen === null) return

    const next = chosen.trim()
    // Nothing to say about either: an empty answer is a cancel that went through the
    // field, and the same name is not a change.
    if (next === '' || next === board.title) return

    try {
      await api.renameBoard(board.id, next)
      await reload()
      toast.success(`Renamed to “${next}”.`)
    } catch {
      toast.error(`Could not rename that ${kind}.`)
    }
  }

  const remove = async (board: Board) => {
    const kind = boardKind(board.kind).label.toLowerCase()
    const agreed = await confirm({
      title: `Delete "${board.title}"?`,
      body:
        `The ${kind} and everything on it leaves your list and goes to the trash, ` +
        `where you can put it back for ${windowLabel(retentionHours)}.`,
      confirmLabel: 'Delete',
      tone: 'danger',
    })
    if (!agreed) return

    try {
      await api.deleteBoard(board.id)
      await Promise.all([reload(), reloadTrash()])
      // Deliberately not a success toast, even now that it can be undone. Nothing
      // green happened: something left, and the message should read the way the news
      // does. What it adds is where the thing went.
      toast.error(`Deleted the ${kind} "${board.title}". It is in the trash.`)
    } catch {
      toast.error(`Could not delete that ${kind}.`)
    }
  }

  const restore = async (board: TrashedBoard) => {
    const kind = boardKind(board.kind).label.toLowerCase()
    try {
      await api.restoreBoard(board.id)
      await Promise.all([reload(), reloadTrash()])
      // The one green message in this view, and it earns it: something that was gone
      // is back, with everything that was on it.
      toast.success(`Put "${board.title}" back.`)
    } catch {
      toast.error(`Could not restore that ${kind}.`)
    }
  }

  const purge = async (board: TrashedBoard) => {
    const kind = boardKind(board.kind).label.toLowerCase()
    const agreed = await confirm({
      title: `Delete "${board.title}" for good?`,
      body: `The ${kind} and everything on it goes now, rather than when its time is up. This cannot be undone.`,
      confirmLabel: 'Delete for good',
      tone: 'danger',
    })
    if (!agreed) return

    try {
      await api.purgeBoard(board.id)
      await reloadTrash()
      toast.error(`Deleted "${board.title}" for good.`)
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

  // The trash is not one of `FILTERS`, so `active` falls back to Everything while it
  // is open. That fallback is only ever read by the board list, which is not what is
  // on screen then; the heading and the body both branch on this instead.
  const showingTrash = view === TRASH_VIEW
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

        {/*
          * The trash, pinned to the foot of the menu above the account.
          *
          * Not one of the groups. Those are ways of looking at what you have, and this
          * is a different list entirely - a different request and different cards - so
          * putting it among them would make it read as a fourth filter. It sits at the
          * bottom because that is where a trash is in every app that has one, and it
          * stays there whatever the kinds list grows to.
          */}
        <nav className="sidebar-nav sidebar-trash" aria-label="Trash">
          <button
            type="button"
            className={showingTrash ? 'nav-item active' : 'nav-item'}
            aria-current={showingTrash ? 'page' : undefined}
            onClick={() => {
              setView(TRASH_VIEW)
              writeView(TRASH_VIEW)
              setNavOpen(false)
              void reloadTrash()
            }}
          >
            <IconTrash size={17} />
            <span className="nav-label">Trash</span>
            <span className="nav-count">{trashed.length}</span>
          </button>
        </nav>

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
          <h1>{showingTrash ? 'Trash' : active.label}</h1>
          <span className="faint">{showingTrash ? trashed.length : visible.length}</span>
          <div className="spacer" />

          {/*
            Two filters and no create control.
            Making something happens on a kind's own page, where the composer already
            knows what it is making. A New button here would be a third place to start
            one and the only one that has to ask an extra question first.
          */}
          {/* Neither narrows the trash. Everything in it is yours - it is the one
              list only an owner can see a row of - and it is ordered by when things
              were thrown away, which is the only order anybody looks for here. */}
          {!showingTrash && (
            <>
              <Dropdown label="Show" value={owner} options={OWNERS} onChange={setOwner} />
              <Dropdown label="Sort by" value={sort} options={SORTS} onChange={setSort} />
            </>
          )}
        </header>

        {composing !== null && !showingTrash && (
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

        {showingTrash ? (
          trashed.length === 0 ? (
            <div className="empty-state">
              <Mark className="mark empty-mark" />
              <p>The trash is empty.</p>
              <p className="faint">
                A glade or lea you delete waits here for {windowLabel(retentionHours)} before it
                goes for good.
              </p>
            </div>
          ) : (
            <>
              <p className="trash-note">
                Anything here can be put back until its time is up. After that it is deleted for
                good, with everything on it.
              </p>

              <ul className="board-grid">
                {trashed.map((board) => {
                  const spec = boardKind(board.kind)
                  return (
                    <li key={board.id} className={`board-card trashed kind-${spec.id}`}>
                      {/*
                        * Not a button. Every other card in this app opens what it
                        * shows, and a board in the trash cannot be opened by anybody -
                        * the server refuses it at the same place it refuses a stranger.
                        * A card that looked clickable and did nothing would be a worse
                        * answer than one that plainly is not.
                        */}
                      <div className="board-open static">
                        {/* The kind's mark rather than a preview. A thumbnail is a
                            picture of a board you are about to open, and this is not
                            one you can open. */}
                        <span className="board-thumb" aria-hidden="true">
                          <spec.Icon size={26} className="placeholder" />
                        </span>
                        <span className="board-meta">
                          <span className="board-text">
                            <span className="board-title">{board.title}</span>
                            <span className="board-sub">
                              <span className="kind-badge">
                                <spec.Icon size={12} />
                                {spec.label}
                              </span>
                              Goes {timeLeft(board.purge_after)}
                            </span>
                          </span>
                        </span>
                      </div>

                      <div className="card-actions">
                        <button
                          type="button"
                          className="card-action card-restore"
                          title={`Put ${board.title} back`}
                          aria-label={`Put ${board.title} back`}
                          onClick={() => void restore(board)}
                        >
                          <IconRestore size={15} />
                        </button>
                        <button
                          type="button"
                          className="card-action card-delete"
                          title={`Delete ${board.title} for good`}
                          aria-label={`Delete ${board.title} for good`}
                          onClick={() => void purge(board)}
                        >
                          <IconTrash size={15} />
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            </>
          )
        ) : loading ? (
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

                  {/* A row rather than one absolutely placed button each, so a card
                      with only one of them puts it in the same corner as a card with
                      both, and adding a third later is not a fourth set of offsets. */}
                  <div className="card-actions">
                    {roleCanWrite(board.role) && (
                      <button
                        type="button"
                        className="card-action card-rename"
                        title={`Rename ${board.title}`}
                        aria-label={`Rename ${board.title}`}
                        onClick={() => void rename(board)}
                      >
                        <IconPencil size={14} />
                      </button>
                    )}
                    {board.role === 'owner' && (
                      <button
                        type="button"
                        className="card-action card-delete"
                        title={`Delete ${board.title}`}
                        aria-label={`Delete ${board.title}`}
                        onClick={() => void remove(board)}
                      >
                        <IconTrash size={15} />
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </main>
    </div>
  )
}
