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
 * Being this browser's preference rather than the document's, it is not a permission:
 * a viewer chooses what a page they can only read looks like to them.
 */

import { useEffect, useRef, useState } from 'react'

import { IconCheck, IconPaper } from '../../ui/icons'
import { PAPERS, PAPER_LABEL, type Paper } from '../../ui/paper'

export function LeaPaper({
  value,
  onChange,
}: {
  value: Paper
  onChange: (paper: Paper) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

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

  const pick = (paper: Paper): void => {
    setOpen(false)
    onChange(paper)
  }

  return (
    <div className="dropdown" ref={root}>
      <button
        type="button"
        className={open ? 'icon ghost active' : 'icon ghost'}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Paper"
        aria-label="Paper"
        onClick={() => setOpen((shown) => !shown)}
      >
        <IconPaper />
      </button>

      {open && (
        <div className="menu menu-compact" role="listbox" aria-label="Paper">
          {PAPERS.map((option) => (
            <button
              key={option}
              type="button"
              role="option"
              aria-selected={option === value}
              className={option === value ? 'menu-item selected' : 'menu-item'}
              onClick={() => pick(option)}
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
