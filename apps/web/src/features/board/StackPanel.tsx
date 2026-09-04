/**
 * The stack: every object on the glade, front to back, and the handles to reorder it.
 *
 * Depth was a document fact with no face. `order` has been the z-order since M2 and the
 * four moves have been on the keyboard since then, but a chord you have to already know
 * is not a feature to anybody who does not - and worse, the four relative moves cannot
 * answer the question people actually have, which is not "one step forward" but "put
 * this one behind that one". You cannot do that with `]` without counting, and counting
 * against a stack you cannot see is guessing.
 *
 * So the list is the feature and the buttons are the shortcut, not the other way round.
 * It shows what is in front of what, points at the canvas when you point at a row, and
 * takes a drag, a typed number, or a keyboard nudge - three ways in, because "bring it
 * forward" and "make it the third one" are different thoughts and neither should have
 * to be spelled as the other.
 *
 * Chrome, never paper. Nothing here is written to the document except the reordering
 * itself and the lock toggle, both of which already existed; which rows you have
 * filtered to and where you scrolled are yours, and a collaborator sees none of it.
 */

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ObjectType } from '@meadow/schema'

import { type DocSession, moveBehind, moveToDepth, updateObject } from '../../doc/mutations'
import { useObjects } from '../../doc/useObjects'
import {
  IconArrow,
  IconBackward,
  IconChevronRight,
  IconCircle,
  IconCylinder,
  IconDiamond,
  IconForward,
  IconGrip,
  IconInk,
  IconLine,
  IconLock,
  IconParallelogram,
  IconPolygon,
  IconSearch,
  IconSquare,
  IconSticky,
  IconText,
  IconToBack,
  IconToFront,
  IconTrapezoid,
  IconTriangle,
  IconUnlock,
} from '../../ui/icons'
import { type StackRow, dropTarget, kindNoun, stackRows } from './stackRows'

/** The mark on a row, one per object type. Same set the shape rail draws from. */
const KIND_ICONS: Record<ObjectType, typeof IconSquare> = {
  text: IconText,
  sticky: IconSticky,
  rect: IconSquare,
  ellipse: IconCircle,
  diamond: IconDiamond,
  parallelogram: IconParallelogram,
  triangle: IconTriangle,
  trapezoid: IconTrapezoid,
  polygon: IconPolygon,
  cylinder: IconCylinder,
  line: IconLine,
  arrow: IconArrow,
  freedraw: IconInk,
  image: IconSquare,
  table: IconSquare,
  chart: IconSquare,
  frame: IconSquare,
  embed: IconSquare,
}

/**
 * How many rows there have to be before the panel offers to search them.
 *
 * A filter over six rows is a control that costs more attention than reading the six
 * rows would. Past about a dozen the list stops fitting on screen and finding a row
 * becomes the slow part, which is the moment the box earns its space.
 */
const SEARCH_FLOOR = 12

/** How close to an edge a drag has to get before the list scrolls itself, in pixels. */
const AUTOSCROLL_EDGE = 32
const AUTOSCROLL_STEP = 12

type Drag = {
  pointerId: number
  /** The ids being carried, in the order the document has them. */
  ids: string[]
  moving: ReadonlySet<string>
  /** Where in the rendered list the block would land. 0 is above the first row. */
  gap: number
  /** Each row's top and height inside the list's own scrollable content. */
  tops: readonly number[]
  heights: readonly number[]
  /** False until the pointer has actually travelled, so a click is not a drag. */
  moved: boolean
}

/** How far a pointer must travel before a press on a grip becomes a drag, in pixels. */
const DRAG_SLOP = 4

export type StackPanelProps = {
  session: DocSession
  /** The canvas selection, which is also this list's selection. One selection, two views. */
  selection: readonly string[]
  editable: boolean
  onSelect(ids: readonly string[]): void
  /** Ring an object on the canvas, or clear the ring. Called on row hover. */
  onSpotlight(id: string | null): void
  /** Bring these into view. A row you cannot find on the canvas is only half an answer. */
  onReveal(ids: readonly string[]): void
  onBringToFront(): void
  onSendToBack(): void
  onBringForward(): void
  onSendBackward(): void
  onCollapse(): void
}

export function StackPanel({
  session,
  selection,
  editable,
  onSelect,
  onSpotlight,
  onReveal,
  onBringToFront,
  onSendToBack,
  onBringForward,
  onSendBackward,
  onCollapse,
}: StackPanelProps) {
  const objects = useObjects(session)
  const rows = useMemo(() => stackRows(session, objects), [session, objects])

  const [query, setQuery] = useState('')
  const [drag, setDrag] = useState<Drag | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)

  /*
   * The anchor a shift-click measures from.
   *
   * The last row *clicked*, which is not the same as the last row selected: a marquee on
   * the canvas selects thirty objects and none of them is where a range should start
   * from. Cleared to null when a click lands with no shift held, so the anchor is always
   * somewhere the person actually put it.
   */
  const anchor = useRef<string | null>(null)

  const selected = useMemo(() => new Set(selection), [selection])

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return rows
    return rows.filter(
      (row) =>
        row.label.toLowerCase().includes(needle) ||
        kindNoun(row.type).toLowerCase().includes(needle),
    )
  }, [rows, query])

  /*
   * Dragging is off while a filter is on, and that is a correctness rule rather than a
   * simplification. A drop between two visible rows says nothing about where the block
   * goes relative to the rows the filter is hiding between them, so any answer the panel
   * picked would be a guess, and a guess that silently reorders somebody's work.
   */
  const filtered = shown.length !== rows.length
  const canDrag = editable && !filtered

  /*
   * Clear the ring when the panel goes.
   *
   * The ring lives in the engine, so a panel closed with the pointer still over a row
   * would leave one painted on the canvas with nothing left to take it off again.
   *
   * Through a ref, and that is not tidiness. `onSpotlight` is rebuilt by `useCanvas` on
   * every render of the board, so naming it as a dependency would run this effect's
   * cleanup on every render - which is to say it would clear the ring a moment after
   * every hover set it, and the feature would work only for as long as nothing else on
   * the page changed.
   */
  const spotlightRef = useRef(onSpotlight)
  spotlightRef.current = onSpotlight
  useEffect(() => () => spotlightRef.current(null), [])

  const commitSelection = useCallback(
    (row: StackRow, event: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      const additive = event.metaKey || event.ctrlKey
      if (event.shiftKey && anchor.current !== null) {
        // The range is taken over the rendered list, so a shift-click while filtered
        // selects what is between the two rows on screen rather than what is between
        // them in the document. That is the list the person is looking at.
        const from = shown.findIndex((entry) => entry.id === anchor.current)
        const to = shown.findIndex((entry) => entry.id === row.id)
        if (from >= 0 && to >= 0) {
          const [start, end] = from <= to ? [from, to] : [to, from]
          onSelect(shown.slice(start, end + 1).map((entry) => entry.id))
          return
        }
      }

      anchor.current = row.id
      if (additive) {
        onSelect(
          selected.has(row.id)
            ? selection.filter((id) => id !== row.id)
            : [...selection, row.id],
        )
        return
      }
      onSelect([row.id])
    },
    [onSelect, selected, selection, shown],
  )

  /**
   * Move one row to a depth typed into its badge.
   *
   * The number is one-based and counted from the back, so it reads the way z-index does:
   * a bigger number is nearer the front. `moveToDepth` clamps, so 0 and 900 both mean
   * an end of the stack rather than a refusal - somebody typing a big number to mean
   * "the top" has said something perfectly clear.
   */
  const setDepth = useCallback(
    (row: StackRow, value: string) => {
      const typed = Number(value)
      if (!Number.isFinite(typed) || value.trim() === '') return
      if (Math.round(typed) === row.z) return
      moveToDepth(session, [row.id], Math.round(typed) - 1)
    },
    [session],
  )

  /** Nudge a focused row one step, without leaving the keyboard or the list. */
  const nudge = useCallback(
    (row: StackRow, direction: 'up' | 'down') => {
      // Through the document rather than through the canvas selection, because the row
      // the keyboard is on is the row that should move, whatever happens to be selected.
      const at = rows.findIndex((entry) => entry.id === row.id)
      const to = direction === 'up' ? at - 1 : at + 1
      if (at < 0 || to < 0 || to >= rows.length) return
      moveBehind(session, [row.id], direction === 'up' ? rows[to - 1]?.id ?? null : rows[to].id)
    },
    [rows, session],
  )

  /** Where the press that might become a drag started, for the slop threshold. */
  const dragStartY = useRef(0)

  const beginDrag = useCallback(
    (event: ReactPointerEvent, row: StackRow) => {
      if (!canDrag) return
      const list = listRef.current
      if (list === null) return

      // Dragging a row that is not in the selection takes only that row, and takes the
      // selection with it. Dragging one that is takes the whole selection, because a
      // person who selected five things and then picked one of them up meant all five.
      const inSelection = selected.has(row.id)
      if (!inSelection) onSelect([row.id])
      const moving = inSelection ? selected : new Set([row.id])

      const elements = Array.from(list.children) as HTMLElement[]
      const start = event.clientY

      event.currentTarget.setPointerCapture(event.pointerId)
      setDrag({
        pointerId: event.pointerId,
        // In document order, front first, so the block keeps its own arrangement.
        ids: shown.filter((entry) => moving.has(entry.id)).map((entry) => entry.id),
        moving,
        gap: shown.findIndex((entry) => entry.id === row.id),
        // Measured once. These are offsets inside the scrollable content rather than
        // screen positions, so they stay true while the list auto-scrolls under the
        // pointer - which screen rectangles would not.
        tops: elements.map((element) => element.offsetTop),
        heights: elements.map((element) => element.offsetHeight),
        moved: false,
      })
      dragStartY.current = start
    },
    [canDrag, onSelect, selected, shown],
  )

  const onDragMove = useCallback(
    (event: ReactPointerEvent) => {
      const list = listRef.current
      if (drag === null || list === null || event.pointerId !== drag.pointerId) return

      const box = list.getBoundingClientRect()
      if (event.clientY < box.top + AUTOSCROLL_EDGE) list.scrollTop -= AUTOSCROLL_STEP
      else if (event.clientY > box.bottom - AUTOSCROLL_EDGE) list.scrollTop += AUTOSCROLL_STEP

      const y = event.clientY - box.top + list.scrollTop
      // The gap is the first row whose middle is below the pointer. Past the last
      // middle, the block goes to the end of the list.
      let gap = drag.tops.length
      for (let index = 0; index < drag.tops.length; index += 1) {
        if (y < drag.tops[index] + drag.heights[index] / 2) {
          gap = index
          break
        }
      }

      const moved = drag.moved || Math.abs(event.clientY - dragStartY.current) > DRAG_SLOP
      if (gap === drag.gap && moved === drag.moved) return
      setDrag({ ...drag, gap, moved })
    },
    [drag],
  )

  const endDrag = useCallback(
    (event: ReactPointerEvent) => {
      if (drag === null || event.pointerId !== drag.pointerId) return
      setDrag(null)
      // A press that never travelled is a click on the grip, not a drag, and reordering
      // on it would move a row somebody only meant to grab.
      if (!drag.moved) return
      moveBehind(session, drag.ids, dropTarget(shown, drag.moving, drag.gap))
    },
    [drag, session, shown],
  )

  const disabled = !editable || selection.length === 0

  return (
    <aside className="stack" aria-label="Stacking order">
      <div className="stack-head">
        <h2>Stack</h2>
        {/* The total, until a filter means the list is no longer showing it. Then both,
            because "2" over a glade with twenty-six objects on it is a lie about the
            glade and "26" over two rows is a lie about the list. */}
        <span className="stack-count">
          {filtered ? `${shown.length} of ${rows.length}` : rows.length}
        </span>
        <button
          type="button"
          className="stack-collapse"
          onClick={onCollapse}
          title="Hide the stack"
          aria-label="Hide the stack"
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      {/* Front at the top, and said in words once rather than left to be inferred from
          a list whose order is the entire point of it. */}
      <p className="stack-legend">Front of the glade first.</p>

      {rows.length >= SEARCH_FLOOR && (
        <label className="stack-search">
          <IconSearch size={14} />
          <input
            type="search"
            value={query}
            placeholder="Find an object"
            aria-label="Find an object"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}

      <div className="stack-moves" role="group" aria-label="Move the selection">
        <button type="button" disabled={disabled} onClick={onBringToFront} title="Bring to front">
          <IconToFront size={17} />
        </button>
        <button type="button" disabled={disabled} onClick={onBringForward} title="Forward (])">
          <IconForward size={17} />
        </button>
        <button type="button" disabled={disabled} onClick={onSendBackward} title="Backward ([)">
          <IconBackward size={17} />
        </button>
        <button type="button" disabled={disabled} onClick={onSendToBack} title="Send to back">
          <IconToBack size={17} />
        </button>
      </div>

      {rows.length === 0 ? (
        <p className="stack-empty">
          Nothing on this glade yet. Draw something and it will be the top of the stack.
        </p>
      ) : shown.length === 0 ? (
        <p className="stack-empty">No object here is called that.</p>
      ) : (
        <ol
          className={drag !== null && drag.moved ? 'stack-list dragging' : 'stack-list'}
          ref={listRef}
          aria-label="Objects, front first"
          onPointerMove={onDragMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onPointerLeave={() => onSpotlight(null)}
        >
          {shown.map((row, index) => (
            <li
              key={row.id}
              className={[
                'stack-row',
                selected.has(row.id) ? 'selected' : '',
                drag?.moved === true && drag.moving.has(row.id) ? 'lifting' : '',
                drag?.moved === true && drag.gap === index ? 'drop-above' : '',
                drag?.moved === true && drag.gap === shown.length && index === shown.length - 1
                  ? 'drop-below'
                  : '',
              ]
                .filter((name) => name !== '')
                .join(' ')}
              onPointerEnter={() => onSpotlight(row.id)}
            >
              <span
                className={canDrag ? 'stack-grip' : 'stack-grip idle'}
                aria-hidden="true"
                onPointerDown={(event) => beginDrag(event, row)}
                title={
                  canDrag
                    ? 'Drag to restack'
                    : filtered
                      ? 'Clear the search to drag rows'
                      : undefined
                }
              >
                <IconGrip size={14} />
              </span>

              {/*
                The depth, and the way to set it.
                An input rather than a label, because "put this one third" is a thought
                people have and no arrangement of arrows expresses it. It is styled as
                plain text until it is hovered or focused, so a column of forty of them
                reads as a column of numbers rather than a column of form fields.
              */}
              <DepthField
                row={row}
                total={rows.length}
                editable={editable}
                onCommit={(value) => setDepth(row, value)}
              />

              <button
                type="button"
                aria-pressed={selected.has(row.id)}
                className="stack-name"
                onClick={(event) => commitSelection(row, event)}
                onDoubleClick={() => onReveal([row.id])}
                onKeyDown={(event) => {
                  // Alt, so the arrows keep moving the focus through the list. The same
                  // two keys the canvas uses for a nudge, with the same modifier.
                  if (!event.altKey || !editable) return
                  if (event.key === 'ArrowUp') {
                    event.preventDefault()
                    nudge(row, 'up')
                  } else if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    nudge(row, 'down')
                  }
                }}
              >
                <KindMark type={row.type} />
                <span className={row.named ? 'stack-label' : 'stack-label kind'}>{row.label}</span>
              </button>

              {/*
                Lock, on the row rather than only on the canvas.
                It is here because it is the other half of the same job: the reason to
                push something to the back is usually that it is a backdrop, and the next
                thing you want is for it to stop catching your clicks. A locked row is
                still draggable in this list, which is the point - the lock guards the
                canvas, not the stack.
              */}
              <button
                type="button"
                className={row.locked ? 'stack-lock locked' : 'stack-lock'}
                disabled={!editable}
                aria-pressed={row.locked}
                title={row.locked ? 'Unlock on the canvas' : 'Lock on the canvas'}
                aria-label={`${row.locked ? 'Unlock' : 'Lock'} ${row.label}`}
                onClick={() => updateObject(session, row.id, { locked: !row.locked })}
              >
                {row.locked ? <IconLock size={13} /> : <IconUnlock size={13} />}
              </button>
            </li>
          ))}
        </ol>
      )}
    </aside>
  )
}

/**
 * The depth badge, which is also the way to set the depth.
 *
 * Its own component for one reason: the field has to hold what is being typed without
 * that being the document's answer yet. Committing per keystroke would read "1" while
 * somebody was on their way to typing "12" and restack the glade underneath them, and
 * `value={row.z}` with no draft would fight the caret on every character. So the draft
 * lives here, the document is written on Enter or on blur, and Escape puts the real
 * number back.
 */
function DepthField({
  row,
  total,
  editable,
  onCommit,
}: {
  row: StackRow
  total: number
  editable: boolean
  onCommit(value: string): void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  return (
    <input
      className="stack-z"
      type="number"
      inputMode="numeric"
      min={1}
      max={total}
      // The draft while one is being typed, the document's own answer the rest of the
      // time - including while a collaborator restacks this row from their own screen.
      value={draft ?? String(row.z)}
      readOnly={!editable}
      aria-label={`Depth of ${row.label}, ${row.z} of ${total}`}
      onChange={(event) => setDraft(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => {
        if (draft !== null) onCommit(draft)
        setDraft(null)
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') {
          setDraft(null)
          event.currentTarget.blur()
        }
      }}
    />
  )
}

function KindMark({ type }: { type: ObjectType }) {
  const Icon = KIND_ICONS[type] ?? IconSquare
  return (
    <span className="stack-kind" title={kindNoun(type)}>
      <Icon size={14} />
    </span>
  )
}
