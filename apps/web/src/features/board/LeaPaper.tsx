/**
 * What this lea is printed on.
 *
 * The diary's, not the page's: a notebook is bound with one stock, and turning to the
 * next page to find a different paper reads as a bug rather than as a choice. So it is
 * one value for the whole document, even though ruling, length and subject belong to
 * each page.
 *
 * One setting, two places to reach it. This menu and the profile's "Diary paper" are
 * the same value - the reader's own default, in `ui/paper.ts` - so changing it here
 * moves the profile and changing it there moves the page. It was a document value with
 * the profile as a fallback under it, and two controls that disagreed after either one
 * was touched read as a bug however carefully the fallback was labelled.
 *
 * Opens in place, under its own row, for the reason `BoardGrid` does: a popup opening
 * out of a popup is a second thing to dismiss for a choice of three, and the row can
 * name the paper that is on without being opened at all.
 *
 * Being this browser's preference rather than the document's, it is not a permission:
 * a viewer chooses what a page they can only read looks like to them.
 */

import { useState } from 'react'

import { IconCheck, IconChevronDown, IconPaper } from '../../ui/icons'
import { PAPERS, PAPER_LABEL, type Paper } from '../../ui/paper'

export function LeaPaper({
  value,
  onChange,
}: {
  value: Paper
  onChange: (paper: Paper) => void
}) {
  const [open, setOpen] = useState(false)

  return (
    <div className="menu-section">
      <button
        type="button"
        // A menu item that opens a group inside the same menu, so it stays a
        // `menuitem` and says whether the group under it is showing. The choices below
        // are radios in that group: one paper is on, and picking one is picking all of
        // them differently.
        role="menuitem"
        className="menu-item"
        aria-expanded={open}
        onClick={() => setOpen((shown) => !shown)}
      >
        <IconPaper size={16} />
        <span>Paper</span>
        <span className="menu-value">{PAPER_LABEL[value]}</span>
        <IconChevronDown size={14} className={open ? 'menu-caret open' : 'menu-caret'} />
      </button>

      {open && (
        <div className="menu-options" role="group" aria-label="Paper">
          {PAPERS.map((option) => (
            <button
              key={option}
              type="button"
              role="menuitemradio"
              aria-checked={option === value}
              className={option === value ? 'menu-item selected' : 'menu-item'}
              onClick={() => onChange(option)}
            >
              <span className="menu-label">{PAPER_LABEL[option]}</span>
              {option === value && <IconCheck size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
