/**
 * What the board is ruled with: a grid, a dot lattice, or nothing.
 *
 * A picker rather than a toggle, and it earned that the hard way: three states behind
 * one button means two of every three clicks land somewhere you did not want, and the
 * button can only ever say what the *next* click does. Three named rows say what the
 * choices are before you commit to one, which is what every board tool worth copying
 * does with its paper.
 *
 * The three rows now open *inside* the menu that holds them rather than in a second
 * popup beside it. A dropdown within a dropdown is two surfaces to dismiss and a
 * second place for the pointer to fall off, for a choice of three; opening in place
 * keeps it one menu, and the row can say which paper is on without being pressed -
 * it wears the chosen pattern's own icon and names it.
 *
 * Not a permission and not a property of the board. This is the reader's own paper -
 * it is remembered in this browser, and nobody else on the glade sees it change - so
 * a viewer chooses it as freely as an editor does. Offered on a glade only: a lea's
 * rules are the leading its writing sits on, and a writing line with its middle
 * rubbed out is not a writing line.
 */

import { useState } from 'react'

import type { GridPattern } from '../../canvas/surface'
import {
  IconCheck,
  IconChevronDown,
  IconGridDots,
  IconGridLines,
  IconGridNone,
} from '../../ui/icons'

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

  const current = CHOICES.find((choice) => choice.id === value) ?? CHOICES[0]
  const Face = current.Icon

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
        {/* The row wears the paper that is on, the way the rail's shape button wears
            the shape it will draw. */}
        <Face size={16} />
        <span>Page background</span>
        <span className="menu-value">{current.label}</span>
        <IconChevronDown size={14} className={open ? 'menu-caret open' : 'menu-caret'} />
      </button>

      {open && (
        <div className="menu-options" role="group" aria-label="Page background">
          {CHOICES.map((choice) => (
            <button
              key={choice.id}
              type="button"
              role="menuitemradio"
              aria-checked={choice.id === value}
              className={choice.id === value ? 'menu-item selected' : 'menu-item'}
              // The list stays open on a choice, and so does the menu around it. There
              // are three papers and the whole point of seeing them together is trying
              // them against what is actually on the canvas.
              onClick={() => onChange(choice.id)}
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
