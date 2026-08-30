/**
 * A one-field dialog, in place of `window.prompt`.
 *
 * The same native `<dialog>` as `ConfirmDialog`, and for the same reasons: the top
 * layer, an inert page behind it, trapped focus, Escape. What it adds is a text field
 * and a starting value, which is the whole point of it here: a new glade is named
 * before it exists, with a suggestion already in the box, so keeping the offered name
 * is one keypress and choosing your own is one field away.
 *
 * Resolves to the trimmed text, or null if the person backed out. Empty is a cancel:
 * a dialog whose only field is blank has not been answered.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type PromptOptions = {
  title: string
  /** One sentence under the title. Optional. */
  body?: string
  label: string
  /** What the field starts with, and what it selects on open. */
  initial?: string
  placeholder?: string
  confirmLabel?: string
  cancelLabel?: string
}

type Prompt = (options: PromptOptions) => Promise<string | null>

const PromptContext = createContext<Prompt | null>(null)

type Request = { options: PromptOptions; settle: (answer: string | null) => void }

export function PromptProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null)
  const [value, setValue] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const fieldRef = useRef<HTMLInputElement>(null)

  const prompt = useCallback<Prompt>(
    (options) =>
      new Promise<string | null>((resolve) => {
        setValue(options.initial ?? '')
        setRequest((current) => {
          // As in ConfirmDialog: a second question answers the first as a cancel rather
          // than leaving its promise pending forever.
          current?.settle(null)
          return { options, settle: resolve }
        })
      }),
    [],
  )

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return

    if (request !== null && !dialog.open) {
      dialog.showModal()
      // Selected, not just focused. The suggestion is a starting point, and typing over
      // it should not mean clearing it first.
      fieldRef.current?.select()
    }
    if (request === null && dialog.open) dialog.close()
  }, [request])

  const answer = useCallback((next: string | null) => {
    setRequest((current) => {
      current?.settle(next)
      return null
    })
  }, [])

  const submit = useCallback(() => {
    const next = value.trim()
    answer(next === '' ? null : next)
  }, [answer, value])

  const options = request?.options

  return (
    <PromptContext.Provider value={prompt}>
      {children}

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby="prompt-title"
        aria-describedby={options?.body === undefined ? undefined : 'prompt-body'}
        onCancel={(event) => {
          event.preventDefault()
          answer(null)
        }}
        onMouseDown={(event) => {
          if (event.target === dialogRef.current) answer(null)
        }}
      >
        {options !== undefined && (
          <form
            className="modal-card"
            onSubmit={(event) => {
              event.preventDefault()
              submit()
            }}
          >
            <h2 id="prompt-title">{options.title}</h2>
            {options.body !== undefined && (
              <p id="prompt-body" className="modal-body">
                {options.body}
              </p>
            )}

            <label className="modal-field">
              <span>{options.label}</span>
              <input
                ref={fieldRef}
                value={value}
                placeholder={options.placeholder}
                maxLength={200}
                onChange={(event) => setValue(event.target.value)}
              />
            </label>

            <div className="modal-actions">
              <button type="button" className="ghost" onClick={() => answer(null)}>
                {options.cancelLabel ?? 'Cancel'}
              </button>
              <button type="submit" className="primary" disabled={value.trim() === ''}>
                {options.confirmLabel ?? 'Create'}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </PromptContext.Provider>
  )
}

export function usePrompt(): Prompt {
  const prompt = useContext(PromptContext)
  if (prompt === null) throw new Error('usePrompt outside a PromptProvider')
  return prompt
}
