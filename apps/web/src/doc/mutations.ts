/**
 * Every write to the Y.Doc goes through this file. No component mutates a Y.Map.
 *
 * Three reasons it is a chokepoint. Each mutation is wrapped in one `Y.transact` with
 * a consistent origin, so `Y.UndoManager` can scope undo to local edits and remote
 * changes never land in the local undo stack. It keeps `objects` and `order` in step,
 * which nothing else enforces. And it is the one place a read-only role can be stopped
 * on the client.
 *
 * The read-only check is the half of ARCHITECTURE 6 that is easy to skip. The server
 * drops a viewer's updates, but a viewer's own Y.Doc applies them locally regardless,
 * so without this they watch their edits appear, persist across a refresh via
 * y-indexeddb, and then vanish once the server's state wins. Refusing the write up
 * front is what makes that impossible; the server drop is the backstop for a client
 * that has been tampered with.
 */

import {
  type ObjectData,
  type ObjectType,
  createObjectMap,
  docRoots,
  nanoid,
  objectData,
  readObject,
  writeObject,
} from '@meadow/schema'
import * as Y from 'yjs'

import type { BoardRole } from '../lib/api'

/** Origin tag for local edits. Undo filters on it; the provider ignores it. */
export const LOCAL_ORIGIN = 'local'

export class ReadOnlyError extends Error {
  constructor() {
    super('This field is read-only for your role')
    this.name = 'ReadOnlyError'
  }
}

export type DocSession = {
  readonly doc: Y.Doc
  readonly objects: Y.Map<Y.Map<unknown>>
  readonly bindings: Y.Map<Y.Map<unknown>>
  readonly order: Y.Array<string>
  readonly meta: Y.Map<unknown>
  readonly undo: Y.UndoManager
  readonly role: BoardRole
  readonly canWrite: boolean
}

/** Owner and editor may write. Commenter is inert in v1 and reads like viewer. */
export function roleCanWrite(role: BoardRole): boolean {
  return role === 'owner' || role === 'editor'
}

export function createDocSession(doc: Y.Doc, role: BoardRole): DocSession {
  const roots = docRoots(doc)

  const undo = new Y.UndoManager([roots.objects, roots.bindings, roots.order], {
    // Scoped to this client's own edits. Without the filter, undo would revert a
    // collaborator's change, which is never what the user meant.
    trackedOrigins: new Set([LOCAL_ORIGIN]),
    // A drag emits one transaction per frame. Merging anything within this window
    // keeps the whole gesture as a single undo step; gesture boundaries call
    // stopCapturing so two separate drags never merge into one.
    captureTimeout: 400,
  })

  return {
    doc,
    objects: roots.objects,
    bindings: roots.bindings,
    order: roots.order,
    meta: roots.meta,
    undo,
    role,
    canWrite: roleCanWrite(role),
  }
}

function write<T>(session: DocSession, fn: () => T): T {
  if (!session.canWrite) throw new ReadOnlyError()
  let result!: T
  session.doc.transact(() => {
    result = fn()
  }, LOCAL_ORIGIN)
  return result
}

/** Close the current undo step, so the next edit starts a new one. */
export function endGesture(session: DocSession): void {
  session.undo.stopCapturing()
}

export function readObjectById(session: DocSession, id: string): ObjectData | undefined {
  const map = session.objects.get(id)
  return map === undefined ? undefined : readObject(map)
}

export type NewObject = Partial<ObjectData> & { type: ObjectType }

/** Insert one object. Must be called inside a transaction. */
function insert(session: DocSession, input: NewObject): string {
  const id = input.id ?? nanoid()
  const data = objectData.parse({ x: 0, y: 0, w: 120, h: 80, ...input, id })
  session.objects.set(id, createObjectMap(data))
  // New objects go on top. `order` is the z-order, index equals depth.
  session.order.push([id])
  return id
}

export function addObject(session: DocSession, input: NewObject): string {
  return write(session, () => insert(session, input))
}

export function addObjects(session: DocSession, inputs: NewObject[]): string[] {
  // One transaction for the batch, so undo removes them together.
  return write(session, () => inputs.map((input) => insert(session, input)))
}

/** Apply a patch to one object. */
export function updateObject(session: DocSession, id: string, patch: Partial<ObjectData>): void {
  write(session, () => {
    const map = session.objects.get(id)
    if (map === undefined) return
    writeObject(map, patch)
  })
}

/**
 * Apply a patch per object in a single transaction.
 *
 * Dragging a multi-selection has to be one transaction. Separate transactions would
 * let a peer observe the selection half-moved, and would push one undo entry per
 * object instead of one per gesture.
 */
export function updateObjects(
  session: DocSession,
  patches: { id: string; patch: Partial<ObjectData> }[],
): void {
  write(session, () => {
    for (const { id, patch } of patches) {
      const map = session.objects.get(id)
      if (map === undefined) continue
      writeObject(map, patch)
    }
  })
}

export function deleteObjects(session: DocSession, ids: readonly string[]): void {
  if (ids.length === 0) return
  const doomed = new Set(ids)

  write(session, () => {
    for (const id of doomed) session.objects.delete(id)

    // Walk `order` backwards: deleting shifts every later index.
    for (let index = session.order.length - 1; index >= 0; index -= 1) {
      if (doomed.has(session.order.get(index))) session.order.delete(index, 1)
    }

    // ARCHITECTURE 4: a binding to a deleted object becomes a free endpoint. The
    // arrow survives with a loose end rather than disappearing along with its target.
    for (const binding of session.bindings.values()) {
      if (doomed.has(binding.get('targetId') as string)) binding.set('targetId', null)
    }
  })
}

export function clearObjects(session: DocSession): void {
  write(session, () => {
    for (const key of Array.from(session.objects.keys())) session.objects.delete(key)
    if (session.order.length > 0) session.order.delete(0, session.order.length)
  })
}

// --- z-order ------------------------------------------------------------------
//
// `order` is a Y.Array of ids, index equals depth. Reordering is delete-then-insert.
// Every mover reads the array once, computes the new arrangement in plain JS, and
// writes it back, because interleaving reads and writes on a Y.Array while indices
// are shifting underneath is how off-by-one reorder bugs happen.

function applyOrder(session: DocSession, next: string[]): void {
  session.order.delete(0, session.order.length)
  session.order.insert(0, next)
}

export function bringToFront(session: DocSession, ids: readonly string[]): void {
  const selected = new Set(ids)
  write(session, () => {
    const current = session.order.toArray()
    applyOrder(session, [
      ...current.filter((id) => !selected.has(id)),
      ...current.filter((id) => selected.has(id)),
    ])
  })
}

export function sendToBack(session: DocSession, ids: readonly string[]): void {
  const selected = new Set(ids)
  write(session, () => {
    const current = session.order.toArray()
    applyOrder(session, [
      ...current.filter((id) => selected.has(id)),
      ...current.filter((id) => !selected.has(id)),
    ])
  })
}

/** Move each selected object one step towards the front, preserving relative order. */
export function bringForward(session: DocSession, ids: readonly string[]): void {
  const selected = new Set(ids)
  write(session, () => {
    const next = session.order.toArray()
    for (let index = next.length - 2; index >= 0; index -= 1) {
      if (selected.has(next[index]) && !selected.has(next[index + 1])) {
        ;[next[index], next[index + 1]] = [next[index + 1], next[index]]
      }
    }
    applyOrder(session, next)
  })
}

export function sendBackward(session: DocSession, ids: readonly string[]): void {
  const selected = new Set(ids)
  write(session, () => {
    const next = session.order.toArray()
    for (let index = 1; index < next.length; index += 1) {
      if (selected.has(next[index]) && !selected.has(next[index - 1])) {
        ;[next[index], next[index - 1]] = [next[index - 1], next[index]]
      }
    }
    applyOrder(session, next)
  })
}

/**
 * Ensure `order` lists every object exactly once.
 *
 * A document written by an older client, or one where a concurrent delete raced an
 * insert, can leave `order` missing an id or holding a stale one. An object absent
 * from `order` would never be drawn or hit-tested, so it would look deleted while
 * still occupying the map. Cheap to check on load, and it repairs rather than throws.
 */
export function reconcileOrder(session: DocSession): void {
  if (!session.canWrite) return

  const listed = session.order.toArray()
  const seen = new Set<string>()
  const kept: string[] = []

  for (const id of listed) {
    if (session.objects.has(id) && !seen.has(id)) {
      seen.add(id)
      kept.push(id)
    }
  }

  const missing = Array.from(session.objects.keys()).filter((id) => !seen.has(id))
  if (missing.length === 0 && kept.length === listed.length) return

  write(session, () => applyOrder(session, [...kept, ...missing]))
}
