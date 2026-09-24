import { type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react'

import type { Board } from '../../lib/api'
import { IconClose, IconLock, IconSearch, IconUser } from '../../ui/icons'
import { relativeTime } from '../../ui/time'
import { PROFILE_SECTIONS, SETTINGS, settingPath } from '../profile/settingsIndex'
import { Highlight } from './GladeSearch'
import { boardKind } from './kinds'

/** Glades and leas listed by name before the rest are left to the page. */
const MAX_BOARDS = 6
const MAX_SETTINGS = 6

export type JumpView = {
  id: string
  label: string
  Icon: typeof IconUser
  count: number
}

type Entry = {
  key: string
  group: 'boards' | 'pages' | 'settings'
  label: string
  /** The second line, or the trailing note, depending on the group. */
  note: string
  Icon: typeof IconUser
  locked?: boolean
  keywords?: string
  run: () => void
}

const GROUP_LABEL: Record<Entry['group'], string> = {
  boards: 'Glades and leas',
  pages: 'Pages',
  settings: 'Settings',
}

/**
 * How well `needle` fits an entry, lower is better, or null for no match.
 *
 * The label beginning with what was typed beats a word inside it beginning with it,
 * which beats the letters turning up anywhere, which beats only a keyword matching:
 * "the" should find "Theme" through Appearance's keywords, but below anything that is
 * actually called "the...".
 */
function score(entry: Entry, needle: string): number | null {
  const label = entry.label.toLowerCase()
  if (label.startsWith(needle)) return 0
  if (label.split(/[\s/&-]+/).some((word) => word.startsWith(needle))) return 1
  if (label.includes(needle)) return 2
  // Keywords only where a word starts: "the" is "theme", not the middle of "others".
  const keywords = entry.keywords?.toLowerCase() ?? ''
  if (keywords.split(' ').some((word) => word.startsWith(needle))) return 3
  if (needle.includes(' ') && keywords.includes(needle)) return 3
  return null
}

type Props = {
  boards: readonly Board[]
  views: readonly JumpView[]
  collapsed: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onView: (id: string) => void
  onOpenBoard: (board: Board) => void
  onNavigate: (hash: string) => void
}

/**
 * The sidebar's search: somewhere to go, not something to find inside.
 *
 * It answers with names only - a glade or lea by what it is called, a page of this
 * app, a section or a single card of the profile - and choosing one goes there. What
 * is written on glades is the bar at the head of the list, which filters the grid as
 * it searches; this one leaves the grid alone, because it is for leaving the page.
 *
 * Everything it searches is already in the browser, so there is no request and no
 * wait: the list is complete on every keystroke.
 */
export function QuickJump({
  boards,
  views,
  collapsed,
  inputRef,
  onView,
  onOpenBoard,
  onNavigate,
}: Props) {
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const needle = query.trim().toLowerCase()

  const entries = useMemo(() => {
    const list: Entry[] = []
    for (const board of boards) {
      const spec = boardKind(board.kind)
      list.push({
        key: `b:${board.id}`,
        group: 'boards',
        label: board.title,
        note: `${spec.label} · Edited ${relativeTime(board.updated_at)}`,
        Icon: spec.Icon,
        locked: board.has_password,
        run: () => onOpenBoard(board),
      })
    }
    for (const view of views) {
      list.push({
        key: `v:${view.id}`,
        group: 'pages',
        label: view.label,
        note: String(view.count),
        Icon: view.Icon,
        run: () => onView(view.id),
      })
    }
    list.push({
      key: 'v:profile',
      group: 'pages',
      label: 'Profile',
      note: '',
      Icon: IconUser,
      keywords: 'account settings me',
      run: () => onNavigate('#/profile'),
    })
    for (const section of PROFILE_SECTIONS) {
      list.push({
        key: `s:${section.id}`,
        group: 'settings',
        label: section.label,
        note: 'Section',
        Icon: section.Icon,
        run: () => onNavigate(`#/profile/${section.id}`),
      })
    }
    for (const setting of SETTINGS) {
      const section = PROFILE_SECTIONS.find((entry) => entry.id === setting.section)
      list.push({
        key: `i:${setting.id}`,
        group: 'settings',
        label: setting.label,
        note: section?.label ?? '',
        Icon: section?.Icon ?? IconUser,
        keywords: setting.keywords,
        run: () => onNavigate(settingPath(setting)),
      })
    }
    return list
  }, [boards, views, onOpenBoard, onView, onNavigate])

  const groups = useMemo(() => {
    if (needle === '') return []
    const ranked = entries
      .map((entry, order) => ({ entry, order, rank: score(entry, needle) }))
      .filter((row): row is { entry: Entry; order: number; rank: number } => row.rank !== null)
      .sort((a, b) => a.rank - b.rank || a.order - b.order)
      .map((row) => row.entry)
    const pick = (group: Entry['group'], limit: number) => {
      const all = ranked.filter((entry) => entry.group === group)
      return { group, shown: all.slice(0, limit), more: Math.max(0, all.length - limit) }
    }
    return [pick('boards', MAX_BOARDS), pick('pages', Infinity), pick('settings', MAX_SETTINGS)].filter(
      (group) => group.shown.length > 0,
    )
  }, [entries, needle])

  const options = groups.flatMap((group) => group.shown)

  useEffect(() => setActive(-1), [needle])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])

  const choose = (entry: Entry) => {
    setOpen(false)
    setQuery('')
    inputRef.current?.blur()
    entry.run()
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return
      event.preventDefault()
      setOpen(true)
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) =>
        current < 0 ? (step > 0 ? 0 : options.length - 1) : (current + step + options.length) % options.length,
      )
    } else if (event.key === 'Enter') {
      const entry = options[active >= 0 ? active : 0]
      if (entry !== undefined) {
        event.preventDefault()
        choose(entry)
      }
    } else if (event.key === 'Escape') {
      if (open && query !== '') setOpen(false)
      else {
        setQuery('')
        inputRef.current?.blur()
      }
    }
  }

  const showing = open && needle !== ''
  let index = -1

  return (
    <div
      ref={root}
      className="glade-search in-sidebar"
      onMouseDown={(event) => {
        if (event.target !== inputRef.current) event.preventDefault()
      }}
    >
      <div className="glade-search-field">
        <IconSearch size={16} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
          aria-label="Jump to a glade, lea, page or setting"
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder="Jump to..."
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {query !== '' ? (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear"
            title="Clear (Esc)"
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <IconClose size={14} />
          </button>
        ) : (
          !collapsed && (
            <kbd className="jump-shortcut" aria-hidden="true">
              Ctrl K
            </kbd>
          )
        )}
      </div>

      {showing && (
        <div className="search-pop">
          <ul id={listId} role="listbox" aria-label={`Places matching ${query.trim()}`} className="search-list">
            {groups.map((group) => [
              <li key={`h:${group.group}`} role="presentation" className="search-heading">
                {GROUP_LABEL[group.group]}
                {group.more > 0 && <span className="search-more">{group.more} more</span>}
              </li>,
              ...group.shown.map((entry) => {
                index += 1
                const at = index
                return (
                  <li
                    key={entry.key}
                    id={`${listId}-${at}`}
                    role="option"
                    aria-selected={at === active}
                    className={`search-option${at === active ? ' active' : ''}`}
                    onMouseMove={() => {
                      if (at !== active) setActive(at)
                    }}
                    onClick={() => choose(entry)}
                  >
                    <span className="search-icon">
                      <entry.Icon size={16} />
                    </span>
                    <span className="search-main">
                      <span className="search-title">
                        <span className="search-title-text">
                          <Highlight text={entry.label} needle={query} />
                        </span>
                        {entry.locked === true && (
                          <IconLock size={11} className="search-lock" aria-label="Password" />
                        )}
                      </span>
                      {entry.group === 'boards' && <span className="search-sub">{entry.note}</span>}
                    </span>
                    {entry.group !== 'boards' && entry.note !== '' && (
                      <span className="search-kind">{entry.note}</span>
                    )}
                  </li>
                )
              }),
            ])}

            {options.length === 0 && (
              <li role="presentation" className="search-status">
                Nothing is called "{query.trim()}". To search what is written on glades, use the
                bar above the list.
              </li>
            )}
          </ul>

          <div className="search-foot" aria-hidden="true">
            {options.length > 0 && (
              <>
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> to move
                </span>
                <span>
                  <kbd>Enter</kbd> to go
                </span>
              </>
            )}
            <span>
              <kbd>Esc</kbd> to close
            </span>
          </div>
        </div>
      )}
    </div>
  )
}
