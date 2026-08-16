/**
 * A confirmation dialog, in place of `window.confirm`.
 *
 * Built on the native `<dialog>` element rather than a positioned div, and that is
 * most of the value here. `showModal()` puts the element in the browser's top layer,
 * so it is above the canvas without anyone picking a z-index; it makes the rest of the
 * page inert, so a click cannot land on the board behind the question; it traps focus
 * and returns it afterwards; and Escape closes it. Every one of those is a bug in the
 * hand-rolled version, and the hand-rolled version is longer.
 *
 * What the browser's own dialog got wrong, and what this fixes: it is not styleable,
 * it says the origin rather than the app's name, it blocks the main thread, and on a
 * destructive action it puts OK where the eye goes first.
 *
 * Asked for as a promise, because the thing a caller wants is an answer:
 *
 *   if (!(await confirm({ title: 'Delete this?', tone: 'danger' }))) return
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

export type ConfirmOptions = {
  title: string
  /** The consequence, in one sentence. Optional, because some questions do not have one. */
  body?: string
  confirmLabel?: string
  cancelLabel?: string
  /** `danger` paints the confirm button red and starts with Cancel focused. */
  tone?: 'default' | 'danger'
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Confirm | null>(null)

type Request = { options: ConfirmOptions; settle: (answer: boolean) => void }

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<Request | null>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        setRequest((current) => {
          // A second question while one is open would replace it silently and leave the
          // first promise pending forever. Answer the old one first, as a cancel: the
          // user never saw it, so nothing may be taken as agreed.
          current?.settle(false)
          return { options, settle: resolve }
        })
      }),
    [],
  )

  // `showModal` is imperative and has no declarative equivalent. It has to be called
  // on the element, and calling it twice throws, hence the `open` guard.
  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog === null) return

    if (request !== null && !dialog.open) dialog.showModal()
    if (request === null && dialog.open) dialog.close()
  }, [request])

  const answer = useCallback((value: boolean) => {
    setRequest((current) => {
      current?.settle(value)
      return null
    })
  }, [])

  const options = request?.options
  const danger = options?.tone === 'danger'

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}

      <dialog
        ref={dialogRef}
        className="modal"
        aria-labelledby="confirm-title"
        aria-describedby={options?.body === undefined ? undefined : 'confirm-body'}
        // Escape, and anything else the browser counts as a cancel. Without this the
        // dialog closes and the promise is never settled, so the caller waits forever.
        onCancel={(event) => {
          event.preventDefault()
          answer(false)
        }}
        // The backdrop is part of the dialog element, so a click on it reports the
        // dialog itself as the target. A click inside the card reports the card.
        onMouseDown={(event) => {
          if (event.target === dialogRef.current) answer(false)
        }}
      >
        {options !== undefined && (
          <div className="modal-card">
            <h2 id="confirm-title">{options.title}</h2>
            {options.body !== undefined && (
              <p id="confirm-body" className="modal-body">
                {options.body}
              </p>
            )}

            <div className="modal-actions">
              <button
                type="button"
                className="ghost"
                // On a destructive question the safe answer holds the focus, so Enter
                // and Space do the harmless thing. A confirmation whose default is
                // "yes, destroy it" is a confirmation that does not confirm anything.
                autoFocus={danger}
                onClick={() => answer(false)}
              >
                {options.cancelLabel ?? 'Cancel'}
              </button>
              <button
                type="button"
                className={danger ? 'primary danger-solid' : 'primary'}
                autoFocus={!danger}
                onClick={() => answer(true)}
              >
                {options.confirmLabel ?? 'Confirm'}
              </button>
            </div>
          </div>
        )}
      </dialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): Confirm {
  const confirm = useContext(ConfirmContext)
  if (confirm === null) throw new Error('useConfirm outside a ConfirmProvider')
  return confirm
}
