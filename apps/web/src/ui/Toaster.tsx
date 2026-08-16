/**
 * Toasts, bottom right.
 *
 * For things that happened, not for things that are true. A glade you failed to
 * delete is an event and belongs here; "you have viewer access to this glade" is a
 * standing fact about the page and belongs in the page. The distinction matters
 * because a toast is the one piece of UI that takes itself away, and putting a
 * durable condition in one means the user has four seconds to read it and no way back.
 *
 * The clock is a CSS animation on the progress bar, and dismissal happens when that
 * animation ends. That is deliberate. A `setTimeout` and an animation are two clocks
 * that have to be kept in step, and they drift the moment anything pauses one of them:
 * the bar empties and the toast sits there, or it vanishes with the bar half full.
 * One clock cannot disagree with itself. It also means a background tab does not burn
 * through its toasts unseen, because the browser stops animating what nobody is
 * looking at, and that is the behaviour you would have written by hand anyway.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { IconAlert, IconCheck, IconClose, IconInfo } from './icons'
import {
  type Toast,
  type ToastAction,
  type ToastInput,
  dismissToast,
  pushToast,
  removeToast,
} from './toastStore'

type ToastOptions = { action?: ToastAction; life?: number }

export type ToastApi = {
  success(message: string, options?: ToastOptions): void
  error(message: string, options?: ToastOptions): void
  info(message: string, options?: ToastOptions): void
}

const ToastContext = createContext<ToastApi | null>(null)

/**
 * How long the exit transition takes. Kept in step with `.toast.leaving` in
 * styles.css: too short and the node is gone before it has moved, too long and the
 * gap it leaves in the stack outlives anyone's interest in it.
 */
const EXIT_MS = 200

const GLYPH = {
  success: IconCheck,
  error: IconAlert,
  info: IconInfo,
} as const

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])

  const dismiss = useCallback((id: string) => {
    setToasts((list) => dismissToast(list, id))
    // The exit is a transition rather than an animation, and a transition on a node
    // that is unmounted in the same tick never runs. Removal is what the timeout is
    // for; it is not a second clock for the lifetime, only for the 200ms of leaving.
    window.setTimeout(() => setToasts((list) => removeToast(list, id)), EXIT_MS)
  }, [])

  const api = useMemo<ToastApi>(() => {
    const push = (input: ToastInput) => setToasts((list) => pushToast(list, input))
    return {
      success: (message, options) => push({ kind: 'success', message, ...options }),
      error: (message, options) => push({ kind: 'error', message, ...options }),
      info: (message, options) => push({ kind: 'info', message, ...options }),
    }
  }, [])

  return (
    <ToastContext.Provider value={api}>
      {children}

      {/*
        * One live region for the stack, announced politely. An error is `role="alert"`
        * on the toast itself, which interrupts, because an error is the one kind worth
        * interrupting for.
        *
        * `aria-live` has to be on a container that exists before anything is announced.
        * A region mounted at the same moment as its first message is frequently not
        * announced at all, which is why this renders even when the list is empty.
        */}
      <div className="toaster" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((toast) => {
          const Glyph = GLYPH[toast.kind]
          return (
            <div
              key={toast.id}
              className={`toast toast-${toast.kind}${toast.leaving === true ? ' leaving' : ''}`}
              role={toast.kind === 'error' ? 'alert' : undefined}
            >
              <span className="toast-glyph" aria-hidden="true">
                <Glyph size={16} />
              </span>

              <p className="toast-message">
                {toast.message}
                {toast.count > 1 && (
                  <span className="toast-count" aria-label={`${toast.count} times`}>
                    {toast.count}
                  </span>
                )}
              </p>

              {toast.action !== undefined && (
                <button
                  type="button"
                  className="toast-action"
                  onClick={() => {
                    toast.action?.run()
                    dismiss(toast.id)
                  }}
                >
                  {toast.action.label}
                </button>
              )}

              <button
                type="button"
                className="toast-close"
                aria-label="Dismiss"
                onClick={() => dismiss(toast.id)}
              >
                <IconClose size={14} />
              </button>

              {/*
                * Keyed on `seq` so a repeat of the same message remounts this one node
                * and replays the animation. Nothing else about the toast changes, so
                * the text does not flicker and the stack does not move.
                */}
              <span
                key={toast.seq}
                className="toast-progress"
                style={{ animationDuration: `${toast.life}ms` }}
                onAnimationEnd={() => dismiss(toast.id)}
              />
            </div>
          )
        })}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const api = useContext(ToastContext)
  if (api === null) throw new Error('useToast outside a ToastProvider')
  return api
}
