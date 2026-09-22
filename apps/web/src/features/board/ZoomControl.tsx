/**
 * The zoom readout, and the three ways of setting it.
 *
 * A wheel zoom is a gesture: it lands on 129% because that is where your fingers
 * stopped, and it is the right way to move around a board. It is the wrong and only
 * way to arrive at a number. Anyone who wants a board at half size, or two people who
 * want to be looking at the same thing, need to be able to say which zoom they mean.
 *
 * So the readout is a field you can type into, with a rung either side of it. The
 * buttons and the plus and minus keys walk a ladder in tens, and the field takes any
 * number at all and the camera clamps it - on a lea, to the band that page allows.
 *
 * The readout used to be a button that reset to 100%, which is now what typing 100
 * does, and what the 0 key has always done.
 */

import { useEffect, useRef, useState } from 'react'

import { IconFit, IconMinus, IconPlus } from '../../ui/icons'

type Props = {
  /** The camera's zoom, as a fraction. 1 is 100%. */
  zoom: number
  step(direction: 1 | -1): void
  setPercent(percent: number): void
  /**
   * Fitting the content of a page whose width is the whole point of the surface is a
   * button that undoes the surface, so a lea does not get one.
   */
  onFit: (() => void) | null
}

export function ZoomControl({ zoom, step, setPercent, onFit }: Props) {
  const percent = Math.round(zoom * 100)
  /** What is being typed, or null when the field is showing the camera. */
  const [draft, setDraft] = useState<string | null>(null)
  const field = useRef<HTMLInputElement>(null)

  /*
   * A zoom that changed under the field closes the edit.
   *
   * The field is only the truth while it has the caret. Someone who starts typing and
   * then reaches for the wheel, or a peer's action that moves the camera, would
   * otherwise leave a stale number sitting in a box that says it is the current zoom.
   */
  useEffect(() => {
    if (draft !== null && document.activeElement !== field.current) setDraft(null)
  }, [zoom, draft])

  const commit = (value: string): void => {
    const typed = Number.parseFloat(value.replace('%', '').trim())
    // A field left empty, or with something that is not a number in it, is not an
    // instruction to zoom anywhere. It goes back to showing the camera.
    if (Number.isFinite(typed)) setPercent(typed)
    setDraft(null)
  }

  return (
    <div className="zoom" role="group" aria-label="Zoom">
      <button
        type="button"
        className="zoom-step"
        onClick={() => step(-1)}
        title="Zoom out (-)"
        aria-label="Zoom out"
      >
        <IconMinus size={14} />
      </button>

      <input
        ref={field}
        className="readout"
        // Not `type="number"`: its spinners are a second pair of step buttons in a
        // control that already has two, and its own arrow-key stepping walks in ones
        // rather than along the ladder these buttons use.
        type="text"
        inputMode="numeric"
        aria-label="Zoom percentage"
        title="Zoom. Type a percentage, or press 0 for 100%"
        value={draft ?? `${percent}%`}
        onChange={(event) => setDraft(event.target.value)}
        // Selected on focus, so the common case is click and overtype rather than
        // click, select the old number, delete it, then type.
        onFocus={(event) => {
          setDraft(String(percent))
          event.target.select()
        }}
        onBlur={(event) => commit(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            // Blurring commits, and it also hands the keyboard back to the board,
            // which is where somebody who has finished with this field is looking.
            field.current?.blur()
            return
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(null)
            field.current?.blur()
          }
        }}
      />

      <button
        type="button"
        className="zoom-step"
        onClick={() => step(1)}
        title="Zoom in (+)"
        aria-label="Zoom in"
      >
        <IconPlus size={14} />
      </button>

      {onFit !== null && (
        <button type="button" onClick={onFit} title="Zoom to fit">
          <IconFit size={15} />
          {/* Wrapped so a narrow bar can drop the word and keep the icon. A bare text
              node has no box to hide. */}
          <span className="label">Fit</span>
        </button>
      )}
    </div>
  )
}
