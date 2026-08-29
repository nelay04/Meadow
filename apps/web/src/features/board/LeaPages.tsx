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
 * One line per page: number, title, length, and the way to tear it out. The number was
 * a small ruled sheet with the numeral inside it for a while, and a column of identical
 * thumbnails of a thing every row already is says nothing at all; the length sat under
 * the title for a while after that, which made every row two lines tall and left three
 * different left edges down the list. A contents page is one line per entry.
 */

import { IconChevronRight, IconPlus, IconTrash } from '../../ui/icons'
import { useConfirm } from '../../ui/ConfirmDialog'
import type { PageMeta } from '../../doc/mutations'
import { formatDiaryDate } from './LeaDate'

export type LeaPagesProps = {
  pages: readonly PageMeta[]
  /** Which page is open. This client's own; two readers are rarely on the same one. */
  index: number
  editable: boolean
  onTurn(index: number): void
  onAdd(): void
  onRemove(index: number): void
  /** Close the list. The board bar's own button is what opens it again. */
  onCollapse(): void
}

export function LeaPages({
  pages,
  index,
  editable,
  onTurn,
  onAdd,
  onRemove,
  onCollapse,
}: LeaPagesProps) {
  /*
   * Removing a page takes the writing on it and cannot be undone - see `removePage` in
   * doc/mutations.ts - so it asks first, in the same modal the board list asks with.
   * One way of asking a destructive question in the app, and it is the one that puts
   * the question in the middle of the screen rather than inside the row being deleted.
   */
  const confirm = useConfirm()

  const tearOut = async (position: number, page: PageMeta): Promise<void> => {
    const named = page.subject.trim()
    const agreed = await confirm({
      title: named === '' ? `Tear out page ${position + 1}?` : `Tear out "${named}"?`,
      body: 'The page and everything written on it goes. This cannot be undone.',
      confirmLabel: 'Tear it out',
      tone: 'danger',
    })
    if (agreed) onRemove(position)
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

      <ol className="lea-pages-list">
        {pages.map((page, position) => {
          const titled = page.subject.trim() !== ''
          return (
            <li key={page.id} className="lea-page-slot">
              <button
                type="button"
                className={position === index ? 'lea-page open' : 'lea-page'}
                // The list is a set of destinations, so the open one is `aria-current`
                // rather than pressed: nothing here toggles.
                aria-current={position === index ? 'true' : undefined}
                // One line has no room for the date, and a page that has one should
                // still be able to say so.
                title={page.date === '' ? undefined : formatDiaryDate(page.date)}
                onClick={() => onTurn(position)}
              >
                <span className="lea-page-number" aria-hidden="true">
                  {position + 1}
                </span>
                <span className={titled ? 'lea-page-title' : 'lea-page-title untitled'}>
                  {titled ? page.subject : 'Untitled page'}
                </span>
                <span className="lea-page-meta">
                  {page.lines} line{page.lines === 1 ? '' : 's'}
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
    </aside>
  )
}
