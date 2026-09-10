/**
 * Six boxes for a code that arrived in an email.
 *
 * One input per character rather than one field of six, and the reason is not
 * decoration: a code read off a phone is read a character at a time, and six boxes hold
 * the reader's place while their eyes go back and forth between two screens. It also
 * says how many characters to expect before the first one is typed, which a single
 * field can only do after the fact by refusing a seventh.
 *
 * The awkward part of the pattern is that the obvious implementation - six pieces of
 * state, one per box - has six ways to be half-updated. So the value here is one string
 * and the boxes are a view of it: box `i` shows `value[i]`, every edit produces a whole
 * new string, and there is no state that can disagree with itself. Focus is the only
 * thing the component owns.
 *
 * Pasting is the case worth getting right, because it is what people actually do: the
 * code is copied out of a mail client, and a paste landing in the first box must fill
 * all six rather than putting six characters in one. That is handled once, on the
 * wrapper, so it works whichever box the paste lands in - and it strips whatever came
 * along with the digits, since a code selected in a mail client usually arrives with a
 * space or a newline attached.
 */

import { useEffect, useRef } from 'react'

type Props = {
  /** The characters typed so far, shortest-first. Never longer than `length`. */
  value: string
  onChange: (next: string) => void
  /**
   * Called when the last box is filled, with the complete value.
   *
   * The screen submits from here rather than from a button: a code is finished the
   * moment its last character lands, and asking somebody to then reach for Confirm is a
   * step that exists only because the form has one.
   */
  onComplete?: (value: string) => void
  length?: number
  disabled?: boolean
  autoFocus?: boolean
  /** Names the group for a screen reader, since the boxes have only numbers in them. */
  label: string
  /** Marks every box as wrong, for the refusal that follows a complete code. */
  invalid?: boolean
}

/** Digits only. The codes this app sends are numeric, and so is every code like them. */
export const clean = (raw: string): string => raw.replace(/\D/g, '')

/**
 * The value after one character is typed into box `index`.
 *
 * Exported and pure because it is the part with the edge cases in it, and this repo has
 * no way to drive a React tree in a test - so the logic worth asserting is kept in a
 * function that needs no tree. The component is then a view over it.
 */
export function nextValue(
  value: string,
  index: number,
  char: string,
  length: number,
): string {
  const chars = value.split('')
  // Clamped to the end of what has been typed, so the value can never grow a hole in
  // the middle. Arrow keys can put the caret in box five over an empty code, and a
  // character landing there would make `value` four characters of nothing followed by
  // one real one - which reads as complete to nobody and as length-five to the code.
  chars[Math.min(index, chars.length)] = char
  return chars.join('').slice(0, length)
}

/**
 * The value after Backspace in box `index`, and where the caret goes.
 *
 * Backspace in an *empty* box steps back and takes the character behind it. Without
 * that, deleting a mistyped code means six presses that do nothing followed by six that
 * do, because every box the caret passes through is already empty.
 */
export function afterBackspace(
  value: string,
  index: number,
): { value: string; focus: number } {
  if ((value[index] ?? '') === '') {
    return { value: value.slice(0, Math.max(0, index - 1)), focus: index - 1 }
  }
  return { value: value.slice(0, index), focus: index }
}

export function OtpInput({
  value,
  onChange,
  onComplete,
  length = 6,
  disabled = false,
  autoFocus = false,
  label,
  invalid = false,
}: Props) {
  const boxes = useRef<(HTMLInputElement | null)[]>([])
  const mounted = useRef(false)

  /*
   * Put the caret where the next character goes.
   *
   * On mount when asked to, and again whenever the value is emptied - which is what a
   * refused code does. Clearing the boxes and leaving focus on the last one would make
   * the retry start at the wrong end.
   */
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true
      if (!autoFocus) return
    } else if (value !== '') {
      return
    }
    boxes.current[0]?.focus()
  }, [value, autoFocus])

  /** Replace one position, then move on. The whole string is rebuilt, never patched. */
  const put = (index: number, char: string): void => {
    const at = Math.min(index, value.length)
    const next = nextValue(value, index, char, length)
    onChange(next)
    if (at < length - 1) boxes.current[at + 1]?.focus()
    if (next.length === length) onComplete?.(next)
  }

  const onKeyDown = (index: number, event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      const { value: next, focus } = afterBackspace(value, index)
      onChange(next)
      boxes.current[focus]?.focus()
      return
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      boxes.current[index - 1]?.focus()
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      boxes.current[index + 1]?.focus()
    }
  }

  const onPaste = (event: React.ClipboardEvent<HTMLDivElement>): void => {
    const pasted = clean(event.clipboardData.getData('text')).slice(0, length)
    if (pasted === '') return
    // Always from the start, whichever box was under the cursor: somebody pasting a
    // whole code means the whole code, and dropping it into box four because that is
    // where they happened to click is never what they meant.
    event.preventDefault()
    onChange(pasted)
    boxes.current[Math.min(pasted.length, length - 1)]?.focus()
    if (pasted.length === length) onComplete?.(pasted)
  }

  return (
    <div
      className="otp"
      role="group"
      aria-label={label}
      onPaste={onPaste}
      data-invalid={invalid ? '' : undefined}
    >
      {Array.from({ length }, (_, index) => (
        <input
          key={index}
          ref={(element) => {
            boxes.current[index] = element
          }}
          className="otp-box"
          // Not `type="number"`: it would strip a leading zero, offer spinners for a
          // value nothing increments, and let somebody type "e" into it.
          inputMode="numeric"
          // The one-time-code hint is what makes a phone offer the code from the SMS or
          // mail it just received. On the first box only - six fields all claiming to be
          // the code is how autofill puts the whole code into each of them.
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`${label}, character ${index + 1} of ${length}`}
          aria-invalid={invalid || undefined}
          disabled={disabled}
          value={value[index] ?? ''}
          // maxLength 1 with a select-on-focus: typing into a full box replaces it
          // rather than being swallowed, which is what a reader retyping one wrong
          // character expects.
          maxLength={1}
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => {
            const typed = clean(event.target.value)
            if (typed === '') return
            // The last character, so typing over a full box takes the new one.
            put(index, typed.slice(-1))
          }}
          onKeyDown={(event) => onKeyDown(index, event)}
        />
      ))}
    </div>
  )
}
