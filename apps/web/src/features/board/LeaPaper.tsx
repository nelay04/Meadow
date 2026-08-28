/**
 * What this page is printed on.
 *
 * The choice belongs to the page and so it goes in the document, which is why this
 * takes the raw stored string rather than a `Paper`: '' means the page has no opinion
 * and each reader's own default decides. That row is offered first and names the
 * default it would fall back to, so "Default" is never a choice you have to open the
 * profile to understand.
 *
 * A viewer sees the same menu with the rows disabled rather than no menu at all: the
 * stock is worth being able to read off the page you are looking at.
 */

import { useEffect, useRef, useState } from 'react'

import { IconCheck, IconPaper } from '../../ui/icons'
import { PAPERS, PAPER_LABEL, type Paper } from '../../ui/paper'

export function LeaPaper({
  value,
  fallback,
  editable,
  onChange,
}: {
  value: string
  fallback: Paper
  editable: boolean
  onChange: (paper: string) => void
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

  const options: readonly { id: string; label: string }[] = [
    { id: '', label: `Default (${PAPER_LABEL[fallback]})` },
    ...PAPERS.map((paper) => ({ id: paper as string, label: PAPER_LABEL[paper] })),
  ]

  const pick = (id: string): void => {
    setOpen(false)
    if (editable) onChange(id)
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
          {options.map((option) => (
            <button
              key={option.id === '' ? 'default' : option.id}
              type="button"
              role="option"
              aria-selected={option.id === value}
              disabled={!editable}
              className={option.id === value ? 'menu-item selected' : 'menu-item'}
              onClick={() => pick(option.id)}
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
