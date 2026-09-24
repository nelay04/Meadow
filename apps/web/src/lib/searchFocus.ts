/**
 * Which object to open a board on, handed from the search dropdown to the board view.
 *
 * Kept in memory for the same reason as a pending import in `gladeFile.ts`: the app is
 * hash-routed, so the list and the board are the same page and nothing between them
 * reloads it. Not in the URL, because it is a one-off instruction about where to look
 * on arrival, not an address anybody should bookmark or send on.
 */
const pending = new Map<string, string>()

export function stashFocus(boardId: string, objectId: string): void {
  pending.set(boardId, objectId)
}

export function hasPendingFocus(boardId: string): boolean {
  return pending.has(boardId)
}

export function takeFocus(boardId: string): string | null {
  const objectId = pending.get(boardId) ?? null
  pending.delete(boardId)
  return objectId
}
