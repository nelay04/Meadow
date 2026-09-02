/**
 * What the board is ruled with: a grid, a dot lattice, or nothing.
 *
 * A picker rather than a toggle, and it earned that the hard way: three states behind
 * one button means two of every three clicks land somewhere you did not want, and the
 * button can only ever say what the *next* click does. Three named rows say what the
 * choices are before you commit to one, which is what every board tool worth copying
 * does with its paper.
 *
 * Not a permission and not a property of the board. This is the reader's own paper -
 * it is remembered in this browser, and nobody else on the glade sees it change - so
 * a viewer chooses it as freely as an editor does. Offered on a glade only: a lea's
 * rules are the leading its writing sits on, and a writing line with its middle
 * rubbed out is not a writing line.
 */

import { useEffect, useRef, useState } from 'react'

import type { GridPattern } from '../../canvas/surface'
import { IconCheck, IconGridDots, IconGridLines, IconGridNone } from '../../ui/icons'

/** The picker's value: the two patterns, plus the paper with nothing printed on it. */
export type GridChoice = GridPattern | 'none'

const CHOICES: { id: GridChoice; label: string; Icon: typeof IconGridLines }[] = [
  { id: 'lines', label: 'Grid', Icon: IconGridLines },
  { id: 'dots', label: 'Dots', Icon: IconGridDots },
  { id: 'none', label: 'Plain', Icon: IconGridNone },
]

export function BoardGrid({
  value,
  onChange,
}: {
  value: GridChoice
  onChange: (choice: GridChoice) => void
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

  const current = CHOICES.find((choice) => choice.id === value) ?? CHOICES[0]
  const Face = current.Icon

  return (
    <div className="dropdown" ref={root}>
      <button
        type="button"
        className={open ? 'icon ghost active' : 'icon ghost'}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Grid"
        aria-label="Grid"
        onClick={() => setOpen((shown) => !shown)}
      >
        {/* The button wears the paper that is on, the way the shape button wears the
            shape it draws. */}
        <Face />
      </button>

      {open && (
        <div className="menu menu-compact menu-grid" role="listbox" aria-label="Grid">
          {CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="option"
              aria-selected={choice.id === value}
              className={choice.id === value ? 'menu-item selected' : 'menu-item'}
              onClick={() => {
                setOpen(false)
                onChange(choice.id)
              }}
            >
              <choice.Icon size={15} />
              <span className="menu-label">{choice.label}</span>
              {choice.id === value && <IconCheck size={15} />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
