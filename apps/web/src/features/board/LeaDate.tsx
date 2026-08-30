/**
 * The date at the top of a lea, and the calendar that sets it.
 *
 * Its own file rather than more of BoardPage, because a calendar is a month of
 * arithmetic and BoardPage is already the longest view in the app.
 *
 * A calendar of our own rather than `<input type="date">`. The native control is the
 * better answer on paper - it knows about locales, keyboards and screen readers, and
 * costs nothing - and it was what this was first built with. Two things ruled it out.
 * Its face cannot be told to print `28th May, 2026`, which is how a diary writes a
 * date and no locale does; and the popup it opens is the browser's, which on a page of
 * kraft paper arrives looking like a different application. What is kept from the
 * native control is what mattered: a real button, real keys, and a labelled dialog.
 */

import { useEffect, useMemo, useRef, useState } from 'react'

import { IconCalendar } from '../../ui/icons'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
]
const DOW = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']
const ORDINALS = ['th', 'st', 'nd', 'rd']

/**
 * A date the way a diary writes one: 28th May, 2026.
 *
 * Built by hand rather than through `toLocaleDateString`, because no locale prints the
 * ordinal, and parsed by hand rather than through `new Date(iso)`, because that reads a
 * bare `YYYY-MM-DD` as UTC and prints it in the local zone - which is the previous day
 * for everybody west of Greenwich.
 */
export function formatDiaryDate(iso: string): string {
  const parts = parseIso(iso)
  if (parts === null) return ''

  const { year, month, day } = parts
  const teen = day % 100
  const suffix = teen >= 11 && teen <= 13 ? 'th' : (ORDINALS[day % 10] ?? 'th')
  return `${day}${suffix} ${MONTHS[month - 1]}, ${year}`
}

/**
 * The same date with the month abbreviated: 28 May 2026.
 *
 * For the contents list, where a page's own date is worth more than its length and
 * there is one line to say it in. The long form eats a row that has a title in it, and
 * the ordinal is the first thing to go: it is a flourish that belongs on the page
 * itself rather than in an index of them. Written from the same parts as the long form
 * so the two can never disagree about what day a page is.
 */
export function formatDiaryDateShort(iso: string): string {
  const parts = parseIso(iso)
  if (parts === null) return ''

  const { year, month, day } = parts
  return `${day} ${MONTHS[month - 1]?.slice(0, 3)} ${year}`
}

type Parts = { year: number; month: number; day: number }

function parseIso(iso: string): Parts | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (match === null) return null

  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return null
  return { year, month, day }
}

function toIso({ year, month, day }: Parts): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function daysInMonth(year: number, month: number): number {
  // Day zero of the next month is the last day of this one, and it gets leap years
  // right without anybody writing the leap year rule down again.
  return new Date(year, month, 0).getDate()
}

function todayParts(): Parts {
  const now = new Date()
  return { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() }
}

/** Monday-first index of the first of the month, 0 to 6. */
function leadingBlanks(year: number, month: number): number {
  return (new Date(year, month - 1, 1).getDay() + 6) % 7
}

export type LeaDateProps = {
  /** `YYYY-MM-DD`, or '' for a page with no date on it yet. */
  value: string
  editable: boolean
  onChange(iso: string): void
}

export function LeaDate({ value, editable, onChange }: LeaDateProps) {
  const [open, setOpen] = useState(false)
  const chosen = useMemo(() => parseIso(value), [value])
  const today = useMemo(todayParts, [])

  // Which month the calendar is showing. Opening it starts on the chosen date's
  // month, or on this one for a page with no date yet.
  const [view, setView] = useState(() => chosen ?? today)
  useEffect(() => {
    if (open) setView(chosen ?? today)
  }, [open, chosen, today])

  /*
   * Close on a click anywhere else, and on Escape.
   *
   * `mousedown` rather than `click`: the canvas under this starts writing on
   * pointerdown, so waiting for the click would let the page take the caret first and
   * the calendar would appear to close by itself.
   */
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return

    const onDown = (event: MouseEvent): void => {
      if (!(event.target instanceof Node)) return
      if (root.current?.contains(event.target) === true) return
      setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('mousedown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const step = (months: number): void => {
    const raw = view.month - 1 + months
    const year = view.year + Math.floor(raw / 12)
    const month = ((raw % 12) + 12) % 12 + 1
    // Clamp the day so stepping off the 31st into February lands on a real date.
    setView({ year, month, day: Math.min(view.day, daysInMonth(year, month)) })
  }

  const pick = (day: number): void => {
    onChange(toIso({ year: view.year, month: view.month, day }))
    setOpen(false)
  }

  const days = daysInMonth(view.year, view.month)
  const blanks = leadingBlanks(view.year, view.month)
  const same = (a: Parts | null, day: number): boolean =>
    a !== null && a.year === view.year && a.month === view.month && a.day === day

  return (
    <div className="lea-field lea-field-date" ref={root}>
      <span className="lea-field-label">Date:</span>
      <span className="lea-field-slot">
        <button
          type="button"
          className="lea-date"
          disabled={!editable}
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen((shown) => !shown)}
        >
          <span className={value === '' ? 'lea-date-value empty' : 'lea-date-value'}>
            {value === '' ? 'Pick a date' : formatDiaryDate(value)}
          </span>
          <IconCalendar size={15} />
        </button>
      </span>

      {open && (
        <div className="lea-calendar" role="dialog" aria-label="Pick a date">
          <div className="lea-calendar-head">
            <button type="button" onClick={() => step(-1)} aria-label="Previous month">
              &#8249;
            </button>
            <span className="lea-calendar-month">
              {MONTHS[view.month - 1]} {view.year}
            </span>
            <button type="button" onClick={() => step(1)} aria-label="Next month">
              &#8250;
            </button>
          </div>

          <div className="lea-calendar-grid">
            {DOW.map((day) => (
              <span className="lea-calendar-dow" key={day}>
                {day}
              </span>
            ))}
            {/* The blanks before the first, so the first lands under its weekday. */}
            {Array.from({ length: blanks }, (_, index) => (
              <span key={`blank-${index}`} />
            ))}
            {Array.from({ length: days }, (_, index) => {
              const day = index + 1
              const classes = ['lea-calendar-day']
              if (same(chosen, day)) classes.push('chosen')
              else if (same(today, day)) classes.push('today')
              return (
                <button
                  type="button"
                  key={day}
                  className={classes.join(' ')}
                  onClick={() => pick(day)}
                >
                  {day}
                </button>
              )
            })}
          </div>

          <div className="lea-calendar-foot">
            <button
              type="button"
              onClick={() => {
                onChange(toIso(today))
                setOpen(false)
              }}
            >
              Today
            </button>
            {value !== '' && (
              <button
                type="button"
                onClick={() => {
                  onChange('')
                  setOpen(false)
                }}
              >
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
