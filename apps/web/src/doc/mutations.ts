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
  type BindingData,
  type ObjectData,
  type ObjectType,
  type ArrowRoutingPatch,
  absolutePoints,
  arrowGeometry,
  bindingData,
  createBindingMap,
  createObjectMap,
  docRoots,
  isArrowLike,
  isTextBearing,
  nanoid,
  objectData,
  objectText,
  readBinding,
  readObject,
  resolveArrowProps,
  routeOrthogonal,
  solveArrowEnds,
  writeObject,
} from '@meadow/schema'
import * as Y from 'yjs'

import type { BoardRole } from '../lib/api'
import { setFragmentPlainText } from './richText'

/** Origin tag for local edits. Undo filters on it; the provider ignores it. */
export const LOCAL_ORIGIN = 'local'

export class ReadOnlyError extends Error {
  /**
   * The message names the actual cause. A refusal reaches the user as a notice, and
   * "read-only for your role" when they locked the glade themselves a moment ago is
   * the kind of wrong explanation that sends someone hunting through sharing settings.
   */
  constructor(reason: 'role' | 'locked' = 'role') {
    super(
      reason === 'locked'
        ? 'This glade is locked. Unlock it to edit.'
        : 'This glade is read-only for your role',
    )
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
  /** The local edit lock. Never persisted, never sent. */
  readonly locked: boolean
  readonly canWrite: boolean
}

/** Owner and editor may write. Commenter is inert in v1 and reads like viewer. */
export function roleCanWrite(role: BoardRole): boolean {
  return role === 'owner' || role === 'editor'
}

/**
 * The glade's local edit lock.
 *
 * A guard against your own hands, not a permission. Someone with an editor role who
 * is presenting, or reading, or just tired of nudging a shape every time they mean to
 * pan, flips this and the board stops accepting edits. It is per-client and per-tab,
 * it is not written to the document, and it is not sent to the server.
 *
 * Which is exactly why it goes here and nowhere else. Every mutation in this file runs
 * through `write`, which refuses when `canWrite` is false, so folding the lock into
 * that one boolean means the tools, the keyboard shortcuts, undo, redo, the text
 * editor and anything added later are all covered without any of them knowing the
 * feature exists. The alternative - a second flag checked in the toolbar and in the
 * engine and in the editor - is the shape of bug ARCHITECTURE warns about for roles,
 * and it would be wrong here for the same reason: the third place always gets missed.
 *
 * The server is still the authority on what this client may do. Unlocking cannot grant
 * a viewer anything, because the role half of this expression is unchanged.
 */
export function createDocSession(doc: Y.Doc, role: BoardRole, locked = false): DocSession {
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
    locked,
    canWrite: roleCanWrite(role) && !locked,
  }
}

function write<T>(session: DocSession, fn: () => T): T {
  if (!session.canWrite) throw new ReadOnlyError(session.locked ? 'locked' : 'role')
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
    reflowArrows(session, new Set([id]))
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
    const touched = new Set<string>()
    for (const { id, patch } of patches) {
      const map = session.objects.get(id)
      if (map === undefined) continue
      writeObject(map, patch)
      touched.add(id)
    }
    // After every patch, not per patch. Dragging a shape and an arrow bound to it in
    // one selection would otherwise solve the arrow against the shape's old position.
    reflowArrows(session, touched)
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
    // The endpoint is deliberately left where it was: it was last solved against the
    // target's final position, so the arrow stays pointing at the space the shape
    // occupied instead of snapping somewhere arbitrary.
    for (const [key, binding] of session.bindings.entries()) {
      // A binding whose arrow is gone is garbage, and it would resurrect the arrow's
      // geometry if the delete were undone and redone.
      if (doomed.has(String(binding.get('arrowId')))) {
        session.bindings.delete(key)
        continue
      }
      if (doomed.has(binding.get('targetId') as string)) binding.set('targetId', null)
    }
  })
}

// --- arrows and bindings ------------------------------------------------------
//
// An arrow's endpoints are derived, not authored. The document stores a binding, and
// the point is recomputed whenever the target moves. Doing that here rather than in
// the renderer is the whole design: the solved points land in the same transaction as
// the move that caused them, so a peer never observes an arrow detached from the shape
// it is attached to, and one undo step puts both back.

/** Write solved world points back as an origin plus relative points, in step. */
function writeArrowPoints(session: DocSession, arrowId: string, absolute: readonly number[]): void {
  const map = session.objects.get(arrowId)
  if (map === undefined) return

  // The arrow's own routing, read back out of the document rather than passed in.
  // Only a curved arrow's bounds differ from its endpoints' box, and every caller
  // here is writing endpoints without knowing or caring which kind it is.
  const style = resolveArrowProps(readObject(map))
  const geometry = arrowGeometry(absolute, style)
  writeObject(map, {
    x: geometry.x,
    y: geometry.y,
    w: geometry.w,
    h: geometry.h,
    props: { points: geometry.points },
  })
}

/**
 * Change how an arrow is routed, and rebuild its bounds to match.
 *
 * Two writes that have to be one. A curved arrow bows outside the box its endpoints
 * span, so setting `routing` without re-deriving `w`/`h` leaves the arrow drawn partly
 * outside its own entry in the spatial index: it disappears when the endpoints scroll
 * off screen while the bulge is still visible, and the bulge cannot be clicked.
 */
export function setArrowRouting(
  session: DocSession,
  arrowId: string,
  patch: ArrowRoutingPatch,
): void {
  write(session, () => {
    const map = session.objects.get(arrowId)
    if (map === undefined) return

    const arrow = readObject(map)
    if (!isArrowLike(arrow.type)) return

    writeObject(map, { props: { ...patch } })
    // Re-read: the props just written are what the new points have to be derived
    // from, and `arrow` is a snapshot from before them.
    const style = resolveArrowProps(readObject(map))

    // Only the two ends survive a change of routing. An elbow's waypoints are stored,
    // so switching away from it without dropping them would leave a dogleg on an
    // arrow that now claims to be straight, and switching *to* it has to generate
    // them - the routing is applied by the solver, and nothing here has solved yet.
    const points = absolutePoints(arrow, style)
    const last = points.length - 2
    const start = { x: points[0], y: points[1] }
    const end = { x: points[last], y: points[last + 1] }
    const routed =
      style.routing === 'orthogonal'
        ? routeOrthogonal(start, end, style.elbow)
        : [start.x, start.y, end.x, end.y]

    writeArrowPoints(session, arrowId, routed)
    // A bound arrow re-solves against its targets, because where an end sits depends
    // on the route: an elbow leaves a shape square to the edge, a straight line does
    // not.
    reflowArrows(session, new Set([arrowId]))
  })
}

type ArrowBindings = { start: BindingData | null; end: BindingData | null }

/**
 * Re-solve every arrow affected by a set of changed objects.
 *
 * Must be called inside a transaction. Two things make an arrow affected: one of its
 * bindings points at something that moved, or the arrow itself moved. The second case
 * matters as much as the first, since without it dragging a bound arrow's body would
 * peel it off its target and leave it floating.
 *
 * O(bindings) per call, walked in full rather than kept as an index. A board has tens
 * of bindings against thousands of objects, and an index would be a second structure
 * to keep correct across undo, remote edits, and deletion.
 */
function reflowArrows(session: DocSession, changed: ReadonlySet<string>): void {
  if (session.bindings.size === 0) return

  const byArrow = new Map<string, ArrowBindings>()
  const affected = new Set<string>()

  for (const map of session.bindings.values()) {
    const binding = readBinding(map)
    let entry = byArrow.get(binding.arrowId)
    if (entry === undefined) {
      entry = { start: null, end: null }
      byArrow.set(binding.arrowId, entry)
    }
    entry[binding.end] = binding

    if (changed.has(binding.arrowId)) affected.add(binding.arrowId)
    if (binding.targetId !== null && changed.has(binding.targetId)) affected.add(binding.arrowId)
  }

  for (const arrowId of affected) {
    const arrowMap = session.objects.get(arrowId)
    if (arrowMap === undefined) continue

    const arrow = readObject(arrowMap)
    if (!isArrowLike(arrow.type)) continue

    const entry = byArrow.get(arrowId)
    if (entry === undefined) continue

    const target = (binding: BindingData | null): ObjectData | null => {
      if (binding === null || binding.targetId === null) return null
      const map = session.objects.get(binding.targetId)
      return map === undefined ? null : readObject(map)
    }

    const style = resolveArrowProps(arrow)
    const solved = solveArrowEnds(
      absolutePoints(arrow, style),
      target(entry.start),
      entry.start,
      target(entry.end),
      entry.end,
      style.routing,
      style.elbow,
    )
    writeArrowPoints(session, arrowId, solved)
  }
}

/** Attach an arrow end to an object, or detach it by passing a null target. */
export function bindArrow(
  session: DocSession,
  input: Omit<BindingData, 'id'> & { id?: string },
): string {
  return write(session, () => {
    const data = bindingData.parse({ ...input, id: input.id ?? nanoid() })

    // One binding per arrow end. Replacing rather than adding, because two bindings on
    // the same end would both solve and the later one would silently win.
    for (const [key, map] of session.bindings.entries()) {
      const existing = readBinding(map)
      if (existing.arrowId === data.arrowId && existing.end === data.end) {
        session.bindings.delete(key)
      }
    }

    session.bindings.set(data.id, createBindingMap(data))
    reflowArrows(session, new Set([data.arrowId]))
    return data.id
  })
}

/** Drop an arrow end's attachment. The endpoint stays where it currently is. */
export function unbindArrow(session: DocSession, arrowId: string, end: BindingData['end']): void {
  write(session, () => {
    for (const [key, map] of session.bindings.entries()) {
      const binding = readBinding(map)
      if (binding.arrowId === arrowId && binding.end === end) session.bindings.delete(key)
    }
  })
}

/** Every binding belonging to an arrow. */
export function arrowBindings(session: DocSession, arrowId: string): ArrowBindings {
  const entry: ArrowBindings = { start: null, end: null }
  for (const map of session.bindings.values()) {
    const binding = readBinding(map)
    if (binding.arrowId === arrowId) entry[binding.end] = binding
  }
  return entry
}

/** Move an arrow's endpoints directly, for the arrow tool while drawing. */
export function setArrowPoints(
  session: DocSession,
  arrowId: string,
  absolute: readonly number[],
): void {
  write(session, () => writeArrowPoints(session, arrowId, absolute))
}

/**
 * Re-solve every bound arrow on the board.
 *
 * For load, where the document may have been written by a client that solved
 * differently, or where a target moved while this client was offline. Cheap, and it
 * repairs rather than throws, like `reconcileOrder`.
 */
export function reconcileBindings(session: DocSession): void {
  if (!session.canWrite || session.bindings.size === 0) return
  write(session, () => reflowArrows(session, new Set(session.objects.keys())))
}

// --- text ---------------------------------------------------------------------

/**
 * The live `Y.XmlFragment` for a text-bearing object, or null.
 *
 * Handed straight to TipTap. Deliberately not snapshotted: the editor binds to the
 * CRDT node itself, which is what makes two people typing in one object merge rather
 * than overwrite. A copy would be a save step, and a save step can be missed.
 */
export function objectFragment(session: DocSession, id: string): Y.XmlFragment | null {
  const map = session.objects.get(id)
  return map === undefined ? null : objectText(map)
}

/**
 * The fragment for an object, attaching one if it should have it and does not.
 *
 * `TEXT_BEARING` grew in M6 to include the primitive shapes, so a rectangle drawn
 * before that has no `text` key. Migrating every document to add empty fragments
 * would be a write per shape for a feature most of them never use; attaching one the
 * first time somebody edits costs nothing and leaves untouched shapes untouched.
 *
 * Returns null for a type that should not carry text at all, and for a viewer, whose
 * refusal has to happen here rather than in the editor: attaching the fragment is a
 * document write like any other.
 */
export function ensureObjectFragment(session: DocSession, id: string): Y.XmlFragment | null {
  const map = session.objects.get(id)
  if (map === undefined) return null

  const existing = objectText(map)
  if (existing !== null) return existing

  const type = String(map.get('type'))
  if (!isTextBearing(type as ObjectType)) return null
  if (!session.canWrite) return null

  return write(session, () => {
    // Re-read inside the transaction: a peer may have attached one while this client
    // was deciding, and two fragments would mean two people typing into different
    // documents that both claim to be this shape's text.
    const current = objectText(map)
    if (current !== null) return current

    const fragment = new Y.XmlFragment()
    map.set('text', fragment)
    return fragment
  })
}

/**
 * Replace an object's text with plain text.
 *
 * For seeding and for callers with no editor, such as the dev harness and tests. Real
 * editing goes through TipTap and never comes here.
 */
export function setObjectText(session: DocSession, id: string, value: string): void {
  write(session, () => {
    const map = session.objects.get(id)
    if (map === undefined) return
    const fragment = objectText(map)
    if (fragment === null) return
    setFragmentPlainText(fragment, value)
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
