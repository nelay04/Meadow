import { useEffect, useId, useMemo, useRef, useState } from 'react'

import type { Board, BoardSearchHit, BoardSearchMatch } from '../../lib/api'
import {
  IconArrow,
  IconCircle,
  IconClose,
  IconCylinder,
  IconDiamond,
  IconDiary,
  IconLine,
  IconLock,
  IconParallelogram,
  IconPolygon,
  IconSearch,
  IconSquare,
  IconSticky,
  IconText,
  IconTrapezoid,
  IconTriangle,
} from '../../ui/icons'
import { relativeTime } from '../../ui/time'
import { boardKind } from './kinds'
import { CONTENT_MIN_CHARS, type ContentSearch } from './useContentSearch'

/** Names shown before the dropdown says "and more": the grid below has the rest. */
const MAX_NAMES = 5
/** Boards shown with their matching objects. The server names three objects each. */
const MAX_INSIDE = 8

type ElementKind = { label: string; Icon: typeof IconText }

/*
 * What each kind of object is called in a result, so a match reads as "in a sticky"
 * rather than as a bare line of text with no idea where it was found.
 */
const ELEMENT_KINDS: Record<string, ElementKind> = {
  text: { label: 'Text', Icon: IconText },
  sticky: { label: 'Sticky', Icon: IconSticky },
  rect: { label: 'Rectangle', Icon: IconSquare },
  frame: { label: 'Frame', Icon: IconSquare },
  ellipse: { label: 'Ellipse', Icon: IconCircle },
  diamond: { label: 'Diamond', Icon: IconDiamond },
  parallelogram: { label: 'Parallelogram', Icon: IconParallelogram },
  triangle: { label: 'Triangle', Icon: IconTriangle },
  trapezoid: { label: 'Trapezoid', Icon: IconTrapezoid },
  polygon: { label: 'Polygon', Icon: IconPolygon },
  cylinder: { label: 'Cylinder', Icon: IconCylinder },
  arrow: { label: 'Arrow label', Icon: IconArrow },
  line: { label: 'Line label', Icon: IconLine },
  page: { label: 'Page subject', Icon: IconDiary },
}

function elementKind(match: BoardSearchMatch, board: Board): ElementKind {
  // On a lea, a text object is a line of writing, and "Text" undersells it.
  if (match.object_type === 'text' && boardKind(board.kind).column !== null) {
    return { label: 'Writing', Icon: IconText }
  }
  return ELEMENT_KINDS[match.object_type] ?? { label: 'Object', Icon: IconText }
}

/** `text` with every case-insensitive occurrence of `needle` marked. */
export function Highlight({ text, needle }: { text: string; needle: string }) {
  const lower = text.toLowerCase()
  const target = needle.trim().toLowerCase()
  const parts: { text: string; hit: boolean }[] = []
  let from = 0
  while (target !== '') {
    const at = lower.indexOf(target, from)
    if (at < 0) break
    if (at > from) parts.push({ text: text.slice(from, at), hit: false })
    parts.push({ text: text.slice(at, at + target.length), hit: true })
    from = at + target.length
  }
  if (from < text.length) parts.push({ text: text.slice(from), hit: false })

  return (
    <>
      {parts.map((part, index) =>
        part.hit ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  )
}

type Option = { key: string; board: Board; objectId: string | null }

type Props = {
  query: string
  onQueryChange: (query: string) => void
  /** The boards this search may answer with: the view's, before the query narrows it. */
  scope: readonly Board[]
  content: ContentSearch
  /** What is being searched, plural and lower case: "glades", "leas", "everything". */
  noun: string
  placeholder: string
  /** Show each board's kind beside it, for the views that mix them. */
  showKind: boolean
  variant: 'bar' | 'sidebar'
  onOpen: (board: Board, objectId: string | null) => void
}

/**
 * The search field, and the dropdown that answers it as you type.
 *
 * Two sections, in the order they can be answered. Names come from the list already in
 * the browser and are there on the first keystroke. What is written inside comes from
 * the server a moment later, grouped by board, each group naming the objects the words
 * were found in so that choosing one opens the board on that object rather than
 * dropping you at its origin to go and look.
 *
 * A combobox in the ARIA sense: focus stays in the field, the arrow keys move a
 * highlight through the options, Enter opens the highlighted one (or the first), and
 * Escape closes the dropdown and then, pressed again, clears the field. The grid under
 * it filters by the same query throughout, so closing the dropdown never loses the
 * answer.
 */
export function GladeSearch({
  query,
  onQueryChange,
  scope,
  content,
  noun,
  placeholder,
  showKind,
  variant,
  onOpen,
}: Props) {
  const listId = useId()
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)

  const needle = query.trim()
  const lower = needle.toLowerCase()

  const inScope = useMemo(() => new Map(scope.map((board) => [board.id, board])), [scope])

  const names = useMemo(() => {
    if (lower === '') return []
    return scope
      .filter((board) => board.title.toLowerCase().includes(lower))
      .sort((a, b) => {
        // A name that starts with what was typed is the one being typed.
        const startsA = a.title.toLowerCase().startsWith(lower) ? 0 : 1
        const startsB = b.title.toLowerCase().startsWith(lower) ? 0 : 1
        return startsA - startsB || b.updated_at.localeCompare(a.updated_at)
      })
  }, [scope, lower])

  const inside = useMemo(() => {
    const found: { board: Board; hit: BoardSearchHit }[] = []
    for (const hit of content.hits.values()) {
      const board = inScope.get(hit.id)
      if (board !== undefined) found.push({ board, hit })
    }
    return found
  }, [content.hits, inScope])

  const shownNames = names.slice(0, MAX_NAMES)
  const shownInside = inside.slice(0, MAX_INSIDE)

  const options = useMemo(() => {
    const list: Option[] = []
    for (const board of shownNames) list.push({ key: `n:${board.id}`, board, objectId: null })
    for (const { board, hit } of shownInside) {
      list.push({ key: `b:${board.id}`, board, objectId: null })
      for (const match of hit.matches) {
        list.push({ key: `o:${board.id}:${match.object_id}`, board, objectId: match.object_id })
      }
    }
    return list
  }, [shownNames, shownInside])

  const indexOf = new Map(options.map((option, index) => [option.key, index]))

  // A new query is a new list; a highlight carried over would point at something else.
  useEffect(() => setActive(-1), [lower])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  useEffect(() => {
    if (active < 0) return
    document
      .getElementById(`${listId}-${active}`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, listId])

  const choose = (option: Option) => {
    setOpen(false)
    input.current?.blur()
    onOpen(option.board, option.objectId)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length === 0) return
      event.preventDefault()
      setOpen(true)
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((current) => {
        if (current < 0) return step > 0 ? 0 : options.length - 1
        return (current + step + options.length) % options.length
      })
    } else if (event.key === 'Enter') {
      const option = options[active >= 0 ? active : 0]
      if (open && option !== undefined) {
        event.preventDefault()
        choose(option)
      }
    } else if (event.key === 'Escape') {
      if (open && needle !== '') {
        setOpen(false)
      } else {
        onQueryChange('')
      }
    }
  }

  const showing = open && needle !== ''
  const searchingInside = needle.length >= CONTENT_MIN_CHARS
  const nothing = shownNames.length === 0 && shownInside.length === 0

  const row = (option: Option, children: React.ReactNode, className: string) => {
    const index = indexOf.get(option.key) ?? -1
    return (
      <li
        key={option.key}
        id={`${listId}-${index}`}
        role="option"
        aria-selected={index === active}
        className={`search-option ${className}${index === active ? ' active' : ''}`}
        onMouseMove={() => {
          if (index !== active) setActive(index)
        }}
        onClick={() => choose(option)}
      >
        {children}
      </li>
    )
  }

  return (
    <div
      ref={root}
      className={`glade-search in-${variant}`}
      // Clicking inside the dropdown must not take focus from the field, or the blur
      // would close it before the click lands.
      onMouseDown={(event) => {
        if (event.target !== input.current) event.preventDefault()
      }}
    >
      <div className="glade-search-field">
        <IconSearch size={16} />
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
          aria-label={`Search ${noun}`}
          autoComplete="off"
          spellCheck={false}
          value={query}
          placeholder={placeholder}
          onChange={(event) => {
            onQueryChange(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />
        {content.pending && <span className="search-spinner" aria-hidden="true" />}
        {query !== '' && (
          <button
            type="button"
            className="search-clear"
            aria-label="Clear the search"
            title="Clear (Esc)"
            onClick={() => {
              onQueryChange('')
              input.current?.focus()
            }}
          >
            <IconClose size={14} />
          </button>
        )}
      </div>

      {showing && (
        <div className="search-pop">
          <ul id={listId} role="listbox" aria-label={`Results for ${needle}`} className="search-list">
            {shownNames.length > 0 && (
              <li role="presentation" className="search-heading">
                Names
                {names.length > shownNames.length && (
                  <span className="search-more">{names.length - shownNames.length} more below</span>
                )}
              </li>
            )}
            {shownNames.map((board) => {
              const spec = boardKind(board.kind)
              return row(
                { key: `n:${board.id}`, board, objectId: null },
                <>
                  <span className="search-icon">
                    <spec.Icon size={16} />
                  </span>
                  <span className="search-main">
                    <span className="search-title">
                      <span className="search-title-text">
                        <Highlight text={board.title} needle={needle} />
                      </span>
                      {board.has_password && (
                        <IconLock size={11} className="search-lock" aria-label="Password" />
                      )}
                    </span>
                    <span className="search-sub">
                      {showKind && `${spec.label} · `}Edited {relativeTime(board.updated_at)}
                    </span>
                  </span>
                </>,
                'is-board',
              )
            })}

            {searchingInside && shownInside.length > 0 && (
              <li role="presentation" className="search-heading">
                Inside
                {inside.length > shownInside.length && (
                  <span className="search-more">{inside.length - shownInside.length} more below</span>
                )}
              </li>
            )}
            {shownInside.map(({ board, hit }) => {
              const spec = boardKind(board.kind)
              const unnamed = hit.match_count - hit.matches.length
              return [
                row(
                  { key: `b:${board.id}`, board, objectId: null },
                  <>
                    <span className="search-icon">
                      <spec.Icon size={16} />
                    </span>
                    <span className="search-main">
                      <span className="search-title">
                        <span className="search-title-text">{board.title}</span>
                      </span>
                    </span>
                    <span className="search-count">
                      {hit.match_count} {hit.match_count === 1 ? 'match' : 'matches'}
                    </span>
                  </>,
                  'is-board is-group',
                ),
                ...hit.matches.map((match, position) => {
                  const element = elementKind(match, board)
                  // The last object is where the thread ends, in its own bend.
                  const last = position === hit.matches.length - 1
                  return row(
                    { key: `o:${board.id}:${match.object_id}`, board, objectId: match.object_id },
                    <>
                      <span className="search-icon is-element" title={element.label}>
                        <element.Icon size={14} />
                      </span>
                      <span className="search-main">
                        <span className="search-snippet">
                          <Highlight text={match.snippet} needle={needle} />
                        </span>
                      </span>
                      <span className="search-kind">{element.label}</span>
                    </>,
                    last ? 'is-element is-last' : 'is-element',
                  )
                }),
                unnamed > 0 && (
                  <li key={`m:${board.id}`} role="presentation" className="search-unnamed">
                    and {unnamed} more on this {spec.label.toLowerCase()}
                  </li>
                ),
              ]
            })}

            {searchingInside && content.pending && shownInside.length === 0 && (
              <li role="presentation" className="search-status">
                <span className="search-spinner" aria-hidden="true" />
                Looking inside {noun}...
              </li>
            )}

            {nothing && !content.pending && (
              <li role="presentation" className="search-status">
                {searchingInside
                  ? `Nothing in ${noun} is called or contains "${needle}".`
                  : `No names match. Type another letter to search inside ${noun} too.`}
              </li>
            )}
          </ul>

          <div className="search-foot" aria-hidden="true">
            {/* Only the keys that do something: with nothing listed, there is nothing
                to move through or open. */}
            {options.length > 0 && (
              <>
                <span>
                  <kbd>↑</kbd>
                  <kbd>↓</kbd> to move
                </span>
                <span>
                  <kbd>Enter</kbd> to open
                </span>
              </>
            )}
            <span>
              <kbd>Esc</kbd> to close
            </span>
            <span className="search-foot-note">Password-protected contents are never searched</span>
          </div>
        </div>
      )}
    </div>
  )
}
