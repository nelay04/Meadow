/**
 * The receipt for having typed a board's password, kept for this tab.
 *
 * `sessionStorage` and not `localStorage`, and that is the whole design decision here.
 * A board password is the owner saying "only the people I am telling this to", and a
 * pass that outlived the tab would quietly turn every shared machine - a meeting room
 * display, a library desk, a laptop handed over for five minutes - into a copy of that
 * password. Per tab is also what makes closing the tab the obvious way to lock it
 * again, which is the gesture people already expect from anything that asked them for a
 * password.
 *
 * What is stored is not the password. It is a short-lived signed token naming one
 * board and the password version it was minted against - see
 * `app/services/board_password.py` - so it stops working when the owner changes the
 * password, and it is no use anywhere else. The password itself is never written down
 * on this side at all.
 *
 * Every accessor is wrapped, because `sessionStorage` *throws* rather than returning
 * null in a private window or with site data blocked, and a board that will not open
 * because the browser refused to remember something is a worse failure than being asked
 * to type the password again.
 */

const KEY = 'meadow.boardpass'

type Store = Record<string, string>

function read(): Store {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw === null) return {}
    const parsed: unknown = JSON.parse(raw)
    // Anything that is not the shape we wrote is treated as nothing. It is a cache of
    // credentials, so the safe reading of a corrupt one is "you have none".
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Store
  } catch {
    return {}
  }
}

function write(store: Store): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(store))
  } catch {
    // Nothing to do and nothing to say. The pass is still held in memory by the caller
    // for this page's life; only surviving a reload is lost.
  }
}

/** The pass held for this board, or null. */
export function boardPass(boardId: string): string | null {
  const held = read()[boardId]
  return typeof held === 'string' && held !== '' ? held : null
}

/** Remember the pass just minted for this board. */
export function rememberBoardPass(boardId: string, pass: string): void {
  write({ ...read(), [boardId]: pass })
}

/**
 * Forget this board's pass.
 *
 * Called when the server stops accepting it - the owner changed the password, or took
 * it off and put a different one on - so the next connect asks rather than presenting a
 * receipt that has already been refused once.
 */
export function forgetBoardPass(boardId: string): void {
  const store = read()
  if (!(boardId in store)) return
  delete store[boardId]
  write(store)
}

/**
 * Which boards this browser has been told are locked.
 *
 * `localStorage`, unlike the pass above, and for the opposite reason: this is not a
 * credential and not a secret. It is the answer to "does opening this ask for a
 * password", which the server gives only after a round trip - and before that round
 * trip comes back, the page has to decide whether to draw the glade. Without this it
 * has nothing to go on and draws it. Somebody else on a shared machine reading this
 * list learns only what trying to open the board would tell them anyway.
 *
 * It is a hint and never an authority. A glade is opened on the server's answer and
 * nothing else, so a stale entry costs a password screen that disappears a moment
 * later, and the entry is dropped the first time the board opens without one. What it
 * buys is the two cases where the server's answer is not there to be had: the second
 * or two before it arrives, and an offline tab, where a cached copy of a locked glade
 * would otherwise open with nothing asked.
 */
const LOCKED_KEY = 'meadow.lockedboards'

function readLocked(): string[] {
  try {
    const raw = localStorage.getItem(LOCKED_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string')
  } catch {
    return []
  }
}

function writeLocked(ids: readonly string[]): void {
  try {
    localStorage.setItem(LOCKED_KEY, JSON.stringify(ids))
  } catch {
    // A private window, or site data blocked. The round trip still answers; all that
    // is lost is answering before it.
  }
}

/** Has this browser been told this board is locked? */
export function boardWasLocked(boardId: string): boolean {
  return readLocked().includes(boardId)
}

/** Remember that it is, so the next visit asks before it draws. */
export function rememberBoardLocked(boardId: string): void {
  const ids = readLocked()
  if (ids.includes(boardId)) return
  writeLocked([...ids, boardId])
}

/**
 * Forget it, because the board has just opened without asking.
 *
 * The owner taking a password off is the case this exists for: the hint would
 * otherwise outlive the lock and put a screen in front of a glade that no longer has
 * one, which the person could not get past - they have no password to type.
 */
export function forgetBoardLocked(boardId: string): void {
  const ids = readLocked()
  if (!ids.includes(boardId)) return
  writeLocked(ids.filter((id) => id !== boardId))
}
