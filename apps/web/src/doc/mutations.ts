/**
 * Every write to the Y.Doc goes through this file. No component mutates a Y.Map.
 *
 * Two reasons it is a chokepoint. Each mutation is wrapped in one `Y.transact` with a
 * consistent origin, so `Y.UndoManager` can scope undo to local edits and remote
 * changes never land in the local undo stack. And it is the one place a read-only
 * role can be enforced on the client.
 *
 * The read-only check is the half of ARCHITECTURE 6 that is easy to skip. The server
 * drops a viewer's updates, but a viewer's own Y.Doc applies them locally regardless -
 * so without this they watch their edits appear, persist across a refresh via
 * y-indexeddb, and then vanish once the server's state wins. Refusing the write up
 * front is what makes that impossible; the server drop is the backstop for a client
 * that has been tampered with.
 */

import * as Y from 'yjs'

import type { BoardRole } from '../lib/api'
import { OBJECTS_KEY, type CanvasObject, type ObjectType, nanoid } from './schema'

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
  readonly role: BoardRole
  readonly canWrite: boolean
}

/** Owner and editor may write. Commenter is inert in v1 and reads like viewer. */
export function roleCanWrite(role: BoardRole): boolean {
  return role === 'owner' || role === 'editor'
}

export function createDocSession(doc: Y.Doc, role: BoardRole): DocSession {
  return {
    doc,
    objects: doc.getMap<Y.Map<unknown>>(OBJECTS_KEY),
    role,
    canWrite: roleCanWrite(role),
  }
}

function assertWritable(session: DocSession): void {
  if (!session.canWrite) throw new ReadOnlyError()
}

function write(session: DocSession, fn: () => void): void {
  assertWritable(session)
  session.doc.transact(fn, LOCAL_ORIGIN)
}

export function addObject(
  session: DocSession,
  input: Partial<CanvasObject> & { type: ObjectType },
): string {
  const id = input.id ?? nanoid()
  write(session, () => {
    const object = new Y.Map<unknown>()
    object.set('id', id)
    object.set('type', input.type)
    object.set('x', input.x ?? Math.round(Math.random() * 2000))
    object.set('y', input.y ?? Math.round(Math.random() * 2000))
    object.set('w', input.w ?? 120)
    object.set('h', input.h ?? 80)
    object.set('rotation', input.rotation ?? 0)
    object.set('opacity', input.opacity ?? 1)
    object.set('locked', input.locked ?? false)
    object.set('parentId', input.parentId ?? null)
    session.objects.set(id, object)
  })
  return id
}

export function moveObject(session: DocSession, id: string, x: number, y: number): void {
  write(session, () => {
    const object = session.objects.get(id)
    if (object === undefined) return
    object.set('x', Math.round(x))
    object.set('y', Math.round(y))
  })
}

export function deleteObject(session: DocSession, id: string): void {
  write(session, () => {
    session.objects.delete(id)
  })
}

export function clearObjects(session: DocSession): void {
  // One transaction for the whole clear, so undo restores every object together
  // rather than one per press.
  write(session, () => {
    for (const key of Array.from(session.objects.keys())) session.objects.delete(key)
  })
}
