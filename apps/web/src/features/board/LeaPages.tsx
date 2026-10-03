/**
 * The spine of a lea: every page in it, and which one is open.
 *
 * A diary is a stack of pages, and the one thing a stack of paper gives you that a
 * scroll does not is the ability to see what is in it and turn straight to a page. So
 * the list sits beside the paper rather than behind a menu, and a page's own subject is
 * its title in it - there is no second name to keep in step, and a page you titled is a
 * page you can find again.
 *
 * Chrome, not paper. The cards are the app's surface and the app's type: they are about
 * the diary rather than printed in it, and dressing them as little sheets of kraft would
 * put two kinds of paper on screen at once, neither of them the one being written on.
 *
 * One line per page: number, title, the date it carries or how long it is, and the way
 * to tear it out. The number was a small ruled sheet with the numeral inside it for a
 * while, and a column of identical thumbnails of a thing every row already is says
 * nothing at all; the length sat under the title for a while after that, which made
 * every row two lines tall and left three different left edges down the list. A
 * contents page is one line per entry.
 */

import { useRef, useState } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'

import { IconChevronRight, IconGrip, IconPlus, IconRestore, IconTrash } from '../../ui/icons'
import { useConfirm } from '../../ui/ConfirmDialog'
import type { PageMeta, TrashedPage } from '@meadow/document-core'
import { formatDiaryDate, formatDiaryDateShort } from './LeaDate'

export type LeaPagesProps = {
  pages: readonly PageMeta[]
  /** Which page is open. This client's own; two readers are rarely on the same one. */
  index: number
  editable: boolean
  onTurn(index: number): void
  onAdd(): void
  onRemove(index: number): void
  /** Move a page to another place in the diary; `to` is where it ends up. */
  onMove(from: number, to: number): void
  /** Pages torn out and not yet gone for good, newest first. */
  trashed: readonly TrashedPage[]
  onRestore(pageId: string): void
  onPurge(pageId: string): void
  /** How long a torn-out page is kept, in hours. For the wording, not for deciding. */
  retentionHours: number
  /** Close the list. The board bar's own button is what opens it again. */
  onCollapse(): void
}

/** "in 3 days", "in 5 hours" - what is left of a page's stay in the trash. */
function timeLeft(deletedAt: number, retentionHours: number): string {
  const ms = deletedAt + retentionHours * 3600_000 - Date.now()
  if (ms <= 0) return 'any moment now'

  const hours = ms / 3600_000
  const format = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (hours < 1) return format.format(Math.max(1, Math.round(ms / 60_000)), 'minute')
  if (hours < 48) return format.format(Math.round(hours), 'hour')
  return format.format(Math.round(hours / 24), 'day')
}

export function LeaPages({
  pages,
  index,
  editable,
  onTurn,
  onAdd,
  onRemove,
  onMove,
  trashed,
  onRestore,
  onPurge,
  retentionHours,
  onCollapse,
}: LeaPagesProps) {
  /*
   * The trash is folded away, and it is the only thing in this panel that is.
   *
   * A contents page is the pages you have. What you tore out is a second, smaller
   * question you ask occasionally, and a diary with a dozen discarded pages would
   * otherwise push its own contents off the top of the panel. It opens on a click and
   * stays open for as long as you are looking at it, which is all the state it needs.
   */
  const [trashOpen, setTrashOpen] = useState(false)
  /*
   * Tearing a page out still asks first, even though it is no longer final - see
   * `removePage` in @meadow/document-core, which moves the page to the trash below. It asks
   * because the page and its writing leave the diary either way, and being able to
   * get something back is not the same as not having lost it. The same modal the board
   * list asks with: one way of asking a destructive question in the app, and it is the
   * one that puts the question in the middle of the screen rather than inside the row.
   */
  const confirm = useConfirm()

  /*
   * Putting the pages in another order, by dragging a row by its grip.
   *
   * Pointer events rather than the browser's own drag and drop, which has no touch
   * support at all, and a grip rather than the whole row, because the row is already a
   * button that turns to its page and a list you scroll with a finger would otherwise
   * start a drag every time you tried to scroll it. The stack panel drags its rows the
   * same way.
   *
   * The page is held by id, not by where it started: a peer can move or tear out a page
   * while this one is in the air, and the drop should move the page you picked up.
   * `gap` is where it would land, counted between rows: 0 above the first, and
   * `pages.length` below the last.
   */
  const listRef = useRef<HTMLOListElement>(null)
  const [drag, setDrag] = useState<{ id: string; gap: number } | null>(null)

  const gapAt = (clientY: number): number => {
    const list = listRef.current
    if (list === null) return 0
    // Near an edge, the list scrolls, so a long diary can be reordered end to end.
    const bounds = list.getBoundingClientRect()
    if (clientY < bounds.top + 24) list.scrollTop -= 12
    else if (clientY > bounds.bottom - 24) list.scrollTop += 12
    let gap = 0
    for (const row of list.querySelectorAll<HTMLElement>(':scope > .lea-page-slot')) {
      const rect = row.getBoundingClientRect()
      if (clientY > rect.top + rect.height / 2) gap += 1
    }
    return gap
  }

  const pickUp = (event: PointerEvent<HTMLElement>, page: PageMeta, position: number): void => {
    if (event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    setDrag({ id: page.id, gap: position })
  }

  const carry = (event: PointerEvent<HTMLElement>): void => {
    if (drag === null) return
    const gap = gapAt(event.clientY)
    if (gap !== drag.gap) setDrag({ ...drag, gap })
  }

  const putDown = (): void => {
    if (drag === null) return
    setDrag(null)
    const from = pages.findIndex((page) => page.id === drag.id)
    if (from < 0) return
    // The gap counts the page being carried, and once it is lifted out every gap below
    // it is one fewer.
    const to = drag.gap > from ? drag.gap - 1 : drag.gap
    if (to !== from) onMove(from, to)
  }

  // The same thing from the keyboard, on the row that has the focus. The row keeps it
  // as it moves, because React keeps a keyed element when its place in the list changes.
  const nudge = (event: KeyboardEvent<HTMLButtonElement>, position: number): void => {
    if (!editable || !event.altKey || event.ctrlKey || event.metaKey) return
    const step = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0
    if (step === 0) return
    event.preventDefault()
    const to = position + step
    if (to >= 0 && to < pages.length) onMove(position, to)
  }

  const dragFrom = drag === null ? -1 : pages.findIndex((page) => page.id === drag.id)
  // No line where dropping would leave the page where it is.
  const dropGap =
    drag === null || dragFrom < 0 || drag.gap === dragFrom || drag.gap === dragFrom + 1
      ? -1
      : drag.gap
  const movable = editable && pages.length > 1

  const tearOut = async (position: number, page: PageMeta): Promise<void> => {
    const named = page.subject.trim()
    const agreed = await confirm({
      title: named === '' ? `Tear out page ${position + 1}?` : `Tear out "${named}"?`,
      body:
        'The page and everything written on it leaves the lea and goes to the trash ' +
        `below, where you can put it back for the next ${retentionHours} hours.`,
      confirmLabel: 'Tear it out',
      tone: 'danger',
    })
    if (agreed) onRemove(position)
  }

  /*
   * The one gesture here that is actually final, so it is the one that says so.
   *
   * Tearing out asks because the page leaves the diary; this asks because there is
   * nothing after it. Same modal, and the difference is entirely in the words.
   */
  const burn = async (page: TrashedPage): Promise<void> => {
    const named = page.subject.trim()
    const agreed = await confirm({
      title: named === '' ? 'Delete this page for good?' : `Delete "${named}" for good?`,
      body: 'The page and everything written on it goes now, rather than when its time is up. This cannot be undone.',
      confirmLabel: 'Delete it for good',
      tone: 'danger',
    })
    if (agreed) onPurge(page.id)
  }

  return (
    <aside className="lea-pages" aria-label="Pages in this lea">
      <div className="lea-pages-head">
        <h2>Pages</h2>
        <span className="lea-pages-count">{pages.length}</span>
        {/* Closed from the panel as well as from the bar. A control that is only
            somewhere else is a panel that looks like it cannot be got rid of. */}
        <button
          type="button"
          className="lea-pages-collapse"
          title="Hide the pages"
          aria-label="Hide the pages"
          onClick={onCollapse}
        >
          <IconChevronRight size={16} />
        </button>
      </div>

      <ol
        ref={listRef}
        className={['lea-pages-list', movable ? 'movable' : '', drag === null ? '' : 'dragging']
          .filter((name) => name !== '')
          .join(' ')}
      >
        {pages.map((page, position) => {
          const titled = page.subject.trim() !== ''
          /*
           * What a page says about itself, in the one slot the row has for it.
           *
           * The date when it has one. A diary is indexed by day before it is indexed
           * by anything else - "the one from the 12th" is how a page gets asked for -
           * and a column of line counts answers a question nobody has. The length is
           * still there for a page with no date, where it is the only thing that
           * distinguishes an untitled page from an empty one.
           */
          const dated = formatDiaryDateShort(page.date)
          return (
            <li
              key={page.id}
              className={[
                'lea-page-slot',
                position === dragFrom ? 'carried' : '',
                position === dropGap ? 'drop-before' : '',
                position === pages.length - 1 && dropGap === pages.length ? 'drop-after' : '',
              ]
                .filter((name) => name !== '')
                .join(' ')}
            >
              {movable && (
                // Not a button: it does nothing on a click, and the keyboard way to
                // move a page is on the row itself, which is where the focus already is.
                <span
                  className="lea-page-grip"
                  title="Drag to move this page"
                  aria-hidden="true"
                  onPointerDown={(event) => pickUp(event, page, position)}
                  onPointerMove={carry}
                  onPointerUp={putDown}
                  onPointerCancel={() => setDrag(null)}
                >
                  <IconGrip size={14} />
                </span>
              )}
              <button
                type="button"
                className={position === index ? 'lea-page open' : 'lea-page'}
                // The list is a set of destinations, so the open one is `aria-current`
                // rather than pressed: nothing here toggles.
                aria-current={position === index ? 'true' : undefined}
                // The row shows the short date; the full one, the way the page
                // itself prints it, is worth a hover.
                title={dated === '' ? undefined : formatDiaryDate(page.date)}
                aria-keyshortcuts={movable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
                onClick={() => onTurn(position)}
                onKeyDown={(event) => nudge(event, position)}
              >
                <span className="lea-page-number" aria-hidden="true">
                  {position + 1}
                </span>
                <span className={titled ? 'lea-page-title' : 'lea-page-title untitled'}>
                  {titled ? page.subject : 'Untitled page'}
                </span>
                <span className="lea-page-meta">
                  {dated === '' ? `${page.lines} line${page.lines === 1 ? '' : 's'}` : dated}
                </span>
              </button>

              {/* Never the last page: a diary with none has nothing to click to start
                  writing again. */}
              {editable && pages.length > 1 && (
                <button
                  type="button"
                  className="lea-page-remove"
                  title="Tear this page out"
                  aria-label={`Tear out page ${position + 1}`}
                  onClick={() => void tearOut(position, page)}
                >
                  <IconTrash size={14} />
                </button>
              )}
            </li>
          )
        })}
      </ol>

      {editable && (
        <button type="button" className="lea-pages-add" onClick={onAdd}>
          <IconPlus size={15} />
          New page
        </button>
      )}

      {/* Only where there is something in it. An empty trash is a heading explaining
          a feature to somebody who has not used it, on a panel whose whole job is to
          list what is actually in this diary. */}
      {trashed.length > 0 && (
        <div className={trashOpen ? 'lea-trash open' : 'lea-trash'}>
          <button
            type="button"
            className="lea-trash-head"
            aria-expanded={trashOpen}
            onClick={() => setTrashOpen((open) => !open)}
          >
            <IconTrash size={14} />
            <span className="lea-trash-label">Torn out</span>
            <span className="lea-pages-count">{trashed.length}</span>
            <IconChevronRight size={14} className="lea-trash-caret" />
          </button>

          {trashOpen && (
            <ol className="lea-trash-list">
              {trashed.map((page) => {
                const named = page.subject.trim()
                return (
                  <li key={page.id} className="lea-trash-slot">
                    <span className="lea-trash-text">
                      <span className={named === '' ? 'lea-page-title untitled' : 'lea-page-title'}>
                        {named === '' ? 'Untitled page' : named}
                      </span>
                      {/* What is left of its stay, not when it went. "Deleted 2 days
                          ago" is a fact about the past; the only thing anybody
                          actually wants from this row is how long they have. */}
                      <span className="lea-page-meta">
                        Goes {timeLeft(page.deletedAt, retentionHours)}
                      </span>
                    </span>

                    {editable && (
                      <>
                        <button
                          type="button"
                          className="lea-page-restore"
                          title="Put this page back"
                          aria-label={
                            named === '' ? 'Put this page back' : `Put "${named}" back`
                          }
                          onClick={() => onRestore(page.id)}
                        >
                          <IconRestore size={14} />
                        </button>
                        <button
                          type="button"
                          className="lea-page-remove"
                          title="Delete this page for good"
                          aria-label={
                            named === ''
                              ? 'Delete this page for good'
                              : `Delete "${named}" for good`
                          }
                          onClick={() => void burn(page)}
                        >
                          <IconTrash size={14} />
                        </button>
                      </>
                    )}
                  </li>
                )
              })}
            </ol>
          )}
        </div>
      )}
    </aside>
  )
}
