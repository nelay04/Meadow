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
import {
  type RichNode,
  fragmentToNodes,
  setFragmentNodes,
  setFragmentPlainText,
} from './richText'

/** Origin tag for local edits. Undo filters on it; the provider ignores it. */
export const LOCAL_ORIGIN = 'local'

/**
 * Origin tag for a change to the diary's structure: removing a page and its writing.
 *
 * A second origin rather than a second flag, because `Y.UndoManager` selects on
 * exactly this. Anything written under it syncs like any other change and is simply
 * not on the undo stack, which is what a page removal has to be: see `removePage`.
 */
export const PAGE_ORIGIN = 'page'

/** Why a write was refused, in the order the session checks them. */
export type ReadOnlyReason = 'role' | 'board-locked' | 'locked'

const READ_ONLY_MESSAGE: Record<ReadOnlyReason, string> = {
  role: 'This glade is read-only for your role',
  // Not "unlock it": whoever is reading this cannot. Naming the owner's lock is what
  // stops somebody hunting for a control they do not have.
  'board-locked': 'The owner has locked this glade. Nobody can edit it until they unlock it.',
  locked: 'This glade is locked. Unlock it to edit.',
}

export class ReadOnlyError extends Error {
  /**
   * The message names the actual cause. A refusal reaches the user as a notice, and
   * "read-only for your role" when they locked the glade themselves a moment ago is
   * the kind of wrong explanation that sends someone hunting through sharing settings.
   * The owner's lock and the per-tab one are just as different: one has an unlock
   * button in front of the reader and the other does not.
   */
  constructor(reason: ReadOnlyReason = 'role') {
    super(READ_ONLY_MESSAGE[reason])
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
  /**
   * The owner's board-wide lock, as the server last reported it.
   *
   * Not the same feature as `locked` even though both end in the same refusal. This one
   * is everybody's, it arrives with the connection, and no button on this client lifts
   * it unless the person happens to be the owner.
   */
  readonly boardLocked: boolean
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
export function createDocSession(
  doc: Y.Doc,
  role: BoardRole,
  locked = false,
  boardLocked = false,
): DocSession {
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
    boardLocked,
    // Three reasons a write can be refused, folded into one boolean, for exactly the
    // reason the paragraph above gives: the tools, the shortcuts, undo, redo and the
    // text editor all read this and none of them has to know how many reasons there are.
    canWrite: roleCanWrite(role) && !locked && !boardLocked,
  }
}

function write<T>(session: DocSession, fn: () => T): T {
  if (!session.canWrite) throw new ReadOnlyError(readOnlyReason(session))
  let result!: T
  session.doc.transact(() => {
    result = fn()
  }, LOCAL_ORIGIN)
  return result
}

/**
 * Which of the three refusals applies, most specific first.
 *
 * Order matters and it is not the order they are checked in `canWrite`. Somebody's own
 * per-tab lock is named first because it is the one they can do something about, even
 * while the owner's lock is also in force: telling them to wait for the owner when
 * their own toggle is down would send them off to wait for nothing.
 */
function readOnlyReason(session: DocSession): ReadOnlyReason {
  if (session.locked) return 'locked'
  if (session.boardLocked) return 'board-locked'
  return 'role'
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
  write(session, () => purgeObjects(session, new Set(ids)))
}

/**
 * Take these objects out of the document, with `order` and the bindings in step.
 *
 * The body of a delete without the transaction around it, so a caller that has to
 * delete under a different origin - removing a page takes its writing with it, and
 * that one is not undoable - does not restate the bindings rule and get it subtly
 * different. Must be called inside a transaction, and after the role has been checked.
 */
function purgeObjects(session: DocSession, doomed: ReadonlySet<string>): void {
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

// --- copying ------------------------------------------------------------------
//
// Copy is a read into plain JSON and paste is an insert of it, and the two are here
// rather than in the engine for the reason the rest of this file exists: paste creates
// objects, rewrites their bindings and touches `order`, which is three invariants that
// have to hold together and one transaction that has to contain them.
//
// Ids are not carried across. A snapshot is pasted into the document it came from as
// often as anywhere else, and reusing an id there would not duplicate the object, it
// would overwrite it.

/** One object as it goes onto the clipboard: its fields, plus its text if it has any. */
export type ObjectSnapshot = { object: ObjectData; text: RichNode[] | null }

export type DocSnapshot = {
  objects: readonly ObjectSnapshot[]
  bindings: readonly BindingData[]
}

/**
 * Read objects out of the document as a snapshot.
 *
 * In z-order rather than in the order the ids were given, so a paste rebuilds the
 * stack it was taken from: a label copied along with the shape behind it must not come
 * back underneath it because the selection happened to be built by clicking the label
 * first.
 *
 * A binding is only carried when both ends of the relationship are in the copy. An
 * arrow copied away from the shape it points at arrives as an arrow with a free end,
 * which is the same thing that happens when its target is deleted (ARCHITECTURE 4) -
 * the alternative is a pasted arrow that silently re-attaches to the original's target
 * and moves when a shape somewhere else on the board moves.
 */
export function snapshotObjects(session: DocSession, ids: readonly string[]): DocSnapshot {
  const wanted = new Set(ids)
  const objects: ObjectSnapshot[] = []

  for (const id of session.order.toArray()) {
    if (!wanted.has(id)) continue
    const map = session.objects.get(id)
    if (map === undefined) continue
    const fragment = objectText(map)
    objects.push({
      object: readObject(map),
      text: fragment === null ? null : fragmentToNodes(fragment),
    })
  }

  const bindings: BindingData[] = []
  for (const map of session.bindings.values()) {
    const binding = readBinding(map)
    if (!wanted.has(binding.arrowId)) continue
    if (binding.targetId === null || !wanted.has(binding.targetId)) continue
    bindings.push(binding)
  }

  return { objects, bindings }
}

/**
 * Insert a snapshot, shifted by an offset, and return the ids it was given.
 *
 * Every stored geometry in this document is relative to the object's own x,y - an
 * arrow's points, a stroke's samples - so moving a pasted object is a write to x and y
 * and nothing else, and that is the whole of what the offset has to do.
 */
export function insertSnapshot(
  session: DocSession,
  snapshot: DocSnapshot,
  offset: { x: number; y: number },
): string[] {
  if (snapshot.objects.length === 0) return []

  return write(session, () => {
    const remap = new Map<string, string>()
    for (const { object } of snapshot.objects) remap.set(object.id, nanoid())

    const created: string[] = []
    for (const { object, text } of snapshot.objects) {
      const id = remap.get(object.id) as string
      insert(session, {
        ...object,
        id,
        x: object.x + offset.x,
        y: object.y + offset.y,
        // A parent that came along in the copy is followed to its new self; one that
        // did not is dropped, because pasting into a frame that is not there is a
        // child of nothing.
        parentId: object.parentId === null ? null : (remap.get(object.parentId) ?? null),
      })
      created.push(id)

      if (text === null) continue
      const fragment = objectText(session.objects.get(id) as Y.Map<unknown>)
      if (fragment !== null) setFragmentNodes(fragment, text)
    }

    for (const binding of snapshot.bindings) {
      const arrowId = remap.get(binding.arrowId)
      const targetId = binding.targetId === null ? null : remap.get(binding.targetId)
      if (arrowId === undefined || targetId === undefined) continue
      const data = bindingData.parse({ ...binding, id: nanoid(), arrowId, targetId })
      session.bindings.set(data.id, createBindingMap(data))
    }

    // The copies were solved against the originals and moved by the same offset as
    // their targets, so the geometry is already right. This is for the case where it
    // is not: an arrow whose target was left behind keeps a binding to nothing, and
    // re-solving is what settles which of its ends are still attached.
    reflowArrows(session, new Set(created))

    return created
  })
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
 * Put these objects at an exact depth, as one block.
 *
 * The other four movers are relative: they say "further up" or "all the way down" and
 * the answer depends on what else is there. This one is the absolute form, and it is
 * what a list you can drag rows around in needs - a drop lands *between* two named
 * neighbours, not one step from where it started, and expressing that as a count of
 * `bringForward` calls is both slower and wrong the moment the selection is not
 * contiguous.
 *
 * `depth` is an index into the finished array, counted from the back, and it is
 * clamped rather than rejected: the panel computes it from a drop position, and a drop
 * past the end of the list means the front, which is a sensible answer and not an
 * error.
 *
 * The moved ids keep their relative order and land contiguously. Two shapes that were
 * one in front of the other stay that way after being dragged somewhere else together,
 * which is the only behaviour that makes dragging a multi-selection predictable.
 */
export function moveToDepth(session: DocSession, ids: readonly string[], depth: number): void {
  if (ids.length === 0) return
  const selected = new Set(ids)
  write(session, () => {
    const current = session.order.toArray()
    // Read the block off `order` rather than out of `ids`, so it is in z-order and not
    // in whatever order the selection happened to be built in.
    const block = current.filter((id) => selected.has(id))
    if (block.length === 0) return
    const rest = current.filter((id) => !selected.has(id))
    const at = Math.max(0, Math.min(rest.length, Math.round(depth)))
    applyOrder(session, [...rest.slice(0, at), ...block, ...rest.slice(at)])
  })
}

/**
 * Put `ids` directly behind `beforeId`, or at the front when it is null.
 *
 * The drag-and-drop spelling of `moveToDepth`. The panel knows which row the drop
 * landed above; it does not know what that row's index will be *after* the dragged
 * rows have been lifted out, and computing that in the caller is the off-by-one this
 * file's z-order section already warns about. So the caller names a neighbour and the
 * index is worked out here, on the array with the block already removed.
 */
export function moveBehind(
  session: DocSession,
  ids: readonly string[],
  beforeId: string | null,
): void {
  if (ids.length === 0) return
  const selected = new Set(ids)
  write(session, () => {
    const current = session.order.toArray()
    const block = current.filter((id) => selected.has(id))
    if (block.length === 0) return
    const rest = current.filter((id) => !selected.has(id))
    const at = beforeId === null ? rest.length : rest.indexOf(beforeId)
    const where = at < 0 ? rest.length : at
    applyOrder(session, [...rest.slice(0, where), ...block, ...rest.slice(where)])
  })
}

/**
 * The pages of a lea.
 *
 * A diary has pages. Until now a lea had exactly one, and its length, its subject and
 * its date were three keys in `meta` - the right shape for a value with a single
 * answer, and the wrong one the moment there can be a second. Each is a field of an
 * entry in `meta.pages` now, and that array is the diary's spine.
 *
 * Nothing in the CRDT schema moved, per ARCHITECTURE 4. `objects` is still one flat
 * map, a row is still an ordinary `text` object, and a page is still not an object: it
 * is a strip of the world its rows are written in, plus the stationery printed above
 * them.
 *
 * Which strip is `slot`, and it is deliberately not this array's index. A row is
 * placed at `(slot * stride, band * spacing)` and carries no idea which page it is on,
 * exactly as it carries no idea which rule it is on. Geometry is a fact two clients
 * cannot disagree about; a page id stamped onto every row is one more thing to keep in
 * step and one more thing a concurrent edit can tear. Slots are handed out once and
 * never reused, so removing a page can never hand its writing to whichever page takes
 * its place in the list.
 */
export type PageMeta = {
  /** Stable across a removal, so a React key never follows the index. */
  id: string
  /** The strip of the world this page's rows are written in. */
  slot: number
  /** What the page is about. Printed at its top, and its title in the page list. */
  subject: string
  /** `YYYY-MM-DD`, or '' for a page nobody has dated. */
  date: string
  /** How many rules it has. */
  lines: number
}

/** A page's strip of world x. `pageSpan` in canvas/engine.ts is what computes one. */
export type PageSpan = { left: number; right: number }

const META_PAGES = 'pages'

/*
 * Where a one-page lea kept its values.
 *
 * Read, never written. A document with no `pages` array is a page one that predates
 * them, so it is read as exactly that and the first write materialises it into the
 * list. Dual-writing these afterwards would leave two copies of one number to keep in
 * agreement, which is the class of bug this file exists to make impossible.
 */
/**
 * When a page was torn out, as epoch milliseconds, or absent on a page that is simply
 * there. The lea's own trash, and the counterpart of `boards.deleted_at` on the server.
 *
 * A torn-out page keeps its entry and keeps its writing, exactly where both were. That
 * is what makes putting it back one field going away rather than a restore: its rows
 * are identified by the strip of world they sit in, so nothing has to be found and
 * moved back, and nothing can come back to the wrong page. They are unreachable
 * meanwhile because the camera is fenced to the open page's slot - see `applyFence` in
 * canvas/engine.ts - so a page in the trash cannot be seen, scrolled to or typed on.
 *
 * Slots are still never reused, so a page torn out and a page added afterwards can
 * never end up sharing one.
 */
const PAGE_DELETED_AT = 'deletedAt'

const META_PAGE_LINES = 'pageLines'
const META_PAGE_DATE = 'pageDate'
const META_PAGE_SUBJECT = 'pageSubject'

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function count(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback
}

function readPageMap(map: Y.Map<unknown>, index: number, fallbackLines: number): PageMeta {
  const slot = map.get('slot')
  const id = map.get('id')
  return {
    // The index is the fallback for both, and it is only reachable through a document
    // written by something other than this file. A page with no slot still has to land
    // on paper of its own rather than on top of page one's.
    id: text(id) === '' ? `page-${index}` : text(id),
    slot: typeof slot === 'number' && Number.isFinite(slot) ? Math.round(slot) : index,
    subject: text(map.get('subject')),
    date: text(map.get('date')),
    lines: count(map.get('lines'), fallbackLines),
  }
}

/** The page a lea had before it had a list of them. */
function legacyPage(session: DocSession, fallbackLines: number): PageMeta {
  return {
    id: 'page-1',
    slot: 0,
    subject: text(session.meta.get(META_PAGE_SUBJECT)),
    date: text(session.meta.get(META_PAGE_DATE)),
    lines: count(session.meta.get(META_PAGE_LINES), fallbackLines),
  }
}

function storedPages(session: DocSession): Y.Array<Y.Map<unknown>> | null {
  const stored = session.meta.get(META_PAGES)
  return stored instanceof Y.Array ? (stored as Y.Array<Y.Map<unknown>>) : null
}

/** A page in a lea, with where it sits in the stored list and whether it is torn out. */
type PageEntry = {
  page: PageMeta
  /** Epoch milliseconds, or 0 for a page that is simply there. */
  deletedAt: number
  /** Its index in the stored array, which is not its index in either list. */
  at: number
}

/**
 * `fallbackLines` defaults because the trash operations below do not look at a page's
 * length: they work on its id, its slot and whether it is torn out, none of which the
 * fallback can affect. Only the two read paths that hand a page to the surface pass a
 * real one.
 */
function entries(session: DocSession, fallbackLines = 1): PageEntry[] {
  const pages = storedPages(session)
  if (pages === null) return []
  return pages.toArray().map((map, at) => {
    if (!(map instanceof Y.Map)) {
      return { page: legacyPage(session, fallbackLines), deletedAt: 0, at }
    }
    const stamp = map.get(PAGE_DELETED_AT)
    return {
      page: readPageMap(map, at, fallbackLines),
      deletedAt: typeof stamp === 'number' && Number.isFinite(stamp) && stamp > 0 ? stamp : 0,
      at,
    }
  })
}

/**
 * The pages you can turn to, in order.
 *
 * Never empty, and that is the invariant the whole surface rests on: a diary with no
 * pages is a state with nothing to click to start writing again. A document with no
 * stored list reads as the one page it is. A document whose every page is in the trash
 * should not be reachable - `removePage` refuses to tear out the last one standing -
 * but two clients tearing out the last two at once can produce it, so the oldest entry
 * is read as live rather than leaving the reader with nothing. Read-only: the page is
 * not quietly restored, it is only shown, and tearing it out again is still refused.
 */
export function readPages(session: DocSession, fallbackLines: number): PageMeta[] {
  const all = entries(session, fallbackLines)
  if (all.length === 0) return [legacyPage(session, fallbackLines)]

  const live = all.filter((entry) => entry.deletedAt === 0)
  if (live.length === 0) return [all[0]!.page]
  return live.map((entry) => entry.page)
}

/** One page in the lea's trash, and when it went there. Newest first in the list. */
export type TrashedPage = PageMeta & { deletedAt: number }

/**
 * Pages torn out and not yet gone for good.
 *
 * Their writing is still in the document, in the strip of world it was always in. What
 * ends that is `purgePage`, by hand or through `sweepPageTrash` once the deployment's
 * retention window has passed.
 */
export function readTrashedPages(session: DocSession, fallbackLines: number): TrashedPage[] {
  return entries(session, fallbackLines)
    .filter((entry) => entry.deletedAt > 0)
    .sort((a, b) => b.deletedAt - a.deletedAt)
    .map((entry) => ({ ...entry.page, deletedAt: entry.deletedAt }))
}

/**
 * Where a page of the live list sits in the stored array.
 *
 * Everything outside this file counts pages the way the page list draws them, so a
 * subject written to "page 2" means the second page you can turn to and not the second
 * row of the array - which are different numbers the moment anything is in the trash.
 * -1 for an index that is not a live page, and every caller treats that as "do
 * nothing" rather than clamping, for the reason `writePage` gives.
 */
function storedIndex(session: DocSession, fallbackLines: number, liveIndex: number): number {
  if (liveIndex < 0) return -1
  const live = entries(session, fallbackLines).filter((entry) => entry.deletedAt === 0)
  return live[liveIndex]?.at ?? -1
}

function pageMap(page: PageMeta): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('id', page.id)
  map.set('slot', page.slot)
  map.set('subject', page.subject)
  map.set('date', page.date)
  map.set('lines', page.lines)
  return map
}

/**
 * The list, creating it from the one-page keys if this document still has those.
 *
 * Only ever called from inside a transaction that is about to write a page value, so
 * merely opening an old lea never touches it and a viewer never needs it at all.
 */
function ensurePages(session: DocSession, fallbackLines: number): Y.Array<Y.Map<unknown>> {
  let pages = storedPages(session)
  if (pages === null) {
    pages = new Y.Array<Y.Map<unknown>>()
    session.meta.set(META_PAGES, pages)
  }
  if (pages.length === 0) pages.push([pageMap(legacyPage(session, fallbackLines))])
  return pages
}

/**
 * Change one page.
 *
 * Out of range does nothing rather than clamping. The index comes from a list this
 * client last read, and a peer can remove a page between the read and the click; the
 * clamped version of that writes somebody's subject onto a different page, which is a
 * far worse answer than the button doing nothing.
 */
function writePage(
  session: DocSession,
  index: number,
  fallbackLines: number,
  patch: (page: Y.Map<unknown>) => void,
): void {
  if (!session.canWrite) return
  session.doc.transact(() => {
    const pages = ensurePages(session, fallbackLines)
    // The caller counted pages the way the page list draws them, which is the live
    // ones. Resolved here rather than at every call site, so nothing outside this file
    // has to know that the trash shares the array.
    const at = storedIndex(session, fallbackLines, index)
    if (at < 0 || at >= pages.length) return
    const page = pages.get(at)
    if (page instanceof Y.Map) patch(page)
  }, LOCAL_ORIGIN)
}

/**
 * How many rules a page has, and how to ask for more.
 *
 * Deliberately outside the undo stack, which is what the origin here does *not* do:
 * `meta` is not one of the roots `Y.UndoManager` is scoped to, so no page value is
 * undoable. Undo is for what you wrote. A page that got longer is not an edit to take
 * back, and Ctrl+Z shortening the paper under writing already on it would be worse
 * than not being able to undo it at all.
 */
export function addPageLines(
  session: DocSession,
  index: number,
  step: number,
  fallbackLines: number,
): void {
  writePage(session, index, fallbackLines, (page) => {
    page.set('lines', count(page.get('lines'), fallbackLines) + step)
  })
}

/** What this page is about, printed at its top and shown as its title in the list. */
export function setPageSubject(
  session: DocSession,
  index: number,
  subject: string,
  fallbackLines: number,
): void {
  writePage(session, index, fallbackLines, (page) => {
    if (text(page.get('subject')) !== subject) page.set('subject', subject)
  })
}

/** The date printed at the top of a page, as `YYYY-MM-DD`, or '' for none. */
export function setPageDate(
  session: DocSession,
  index: number,
  iso: string,
  fallbackLines: number,
): void {
  writePage(session, index, fallbackLines, (page) => {
    if (text(page.get('date')) !== iso) page.set('date', iso)
  })
}

/**
 * Turn to a new page. Returns its index, or -1 if the role could not.
 *
 * The slot is one past the highest ever handed out rather than the new length, because
 * a page that has been removed still has writing nobody deleted in some documents and
 * a reused slot would put the new page on top of it.
 */
export function addPage(session: DocSession, fallbackLines: number): number {
  if (!session.canWrite) return -1

  let created = -1
  session.doc.transact(() => {
    const pages = ensurePages(session, fallbackLines)
    const slots = pages
      .toArray()
      .map((page, index) =>
        page instanceof Y.Map ? readPageMap(page, index, fallbackLines).slot : index,
      )
    pages.push([
      pageMap({
        id: nanoid(),
        slot: Math.max(...slots, -1) + 1,
        subject: '',
        date: '',
        lines: fallbackLines,
      }),
    ])
    // The live index, not the array one: the new page is appended and is not in the
    // trash, so it is the last page anybody can turn to.
    created = pages.toArray().filter((page) => {
      if (!(page instanceof Y.Map)) return true
      const stamp = page.get(PAGE_DELETED_AT)
      return !(typeof stamp === 'number' && stamp > 0)
    }).length - 1
  }, LOCAL_ORIGIN)

  return created
}

/**
 * Tear a page out. It goes to the lea's trash, with its writing still on it.
 *
 * Never the last one you can turn to. A lea is a diary, and a diary with no pages is a
 * state with no way back out of it: there would be nothing to click to start writing
 * again. Pages in the trash do not count towards that - a lea whose every other page
 * has been torn out has one page, and the trash beside it.
 *
 * This used to take the writing with it, and be final. It is neither now: the entry
 * keeps its place in the array and its rows keep theirs in the world, and putting the
 * page back is one field going away. What is still true is that it is outside undo -
 * `PAGE_ORIGIN` is not a root `Y.UndoManager` is scoped to - and that is no longer the
 * loss it was, because the way back is the trash rather than Ctrl+Z. `purgePage` is
 * the one that cannot be taken back.
 */
export function removePage(session: DocSession, index: number): boolean {
  if (!session.canWrite) return false

  const pages = storedPages(session)
  if (pages === null) return false

  const live = entries(session).filter(
    (entry) => entry.deletedAt === 0,
  )
  if (live.length <= 1) return false

  const target = live[index]
  if (target === undefined) return false

  const page = pages.get(target.at)
  if (!(page instanceof Y.Map)) return false

  session.doc.transact(() => {
    page.set(PAGE_DELETED_AT, Date.now())
  }, PAGE_ORIGIN)

  return true
}

/**
 * Put a torn-out page back, by its id.
 *
 * By id and not by position, because the position it is being restored from is a row
 * in the trash list and the position it comes back to is its place in the diary. It
 * lands where it always was: the entry never moved, so page four goes back to being
 * page four rather than to the end of the book.
 */
export function restorePage(session: DocSession, pageId: string): boolean {
  if (!session.canWrite) return false

  const pages = storedPages(session)
  if (pages === null) return false

  const target = entries(session).find(
    (entry) => entry.page.id === pageId && entry.deletedAt > 0,
  )
  if (target === undefined) return false

  const page = pages.get(target.at)
  if (!(page instanceof Y.Map)) return false

  session.doc.transact(() => {
    page.delete(PAGE_DELETED_AT)
  }, PAGE_ORIGIN)

  return true
}

/**
 * Delete a torn-out page for good, and the writing on it with it.
 *
 * What `removePage` used to do, reached from the trash rather than from the page list.
 * Only ever applied to a page that is already in the trash: a page you can turn to has
 * to be torn out first, which is what makes tearing out a gesture you can take back
 * and this one a gesture you cannot.
 *
 * `span` is the strip of world the page's rows sit in, from `pageSpan` in
 * canvas/engine.ts. It has to be handed in because it depends on the measure the
 * reader's own client is laying the column out at, which this file has no view of.
 */
export function purgePage(session: DocSession, pageId: string, span: PageSpan): boolean {
  if (!session.canWrite) return false

  const pages = storedPages(session)
  if (pages === null) return false

  const target = entries(session).find(
    (entry) => entry.page.id === pageId && entry.deletedAt > 0,
  )
  if (target === undefined) return false

  const doomed = new Set<string>()
  for (const id of session.objects.keys()) {
    const object = readObjectById(session, id)
    if (object === undefined) continue
    // The centre, not the left edge: a row is exactly its page's width, so its middle
    // is inside its own page's strip however the two edges round.
    const centre = object.x + object.w / 2
    if (centre >= span.left && centre < span.right) doomed.add(id)
  }

  session.doc.transact(() => {
    purgeObjects(session, doomed)
    pages.delete(target.at, 1)
  }, PAGE_ORIGIN)

  return true
}

/**
 * Empty everything whose window has passed. Returns how many pages went.
 *
 * The client does this because it is the only thing that can: these pages are inside
 * the CRDT document, which the server stores as opaque updates and does not read.
 * Running it when a lea is opened by somebody who can write is enough - the window is
 * measured in hours, nothing is visible meanwhile, and a page that outlives it by an
 * afternoon because nobody opened the diary has harmed nothing.
 *
 * `spanOf` turns a page's slot into its strip of world, for the same reason `purgePage`
 * is handed one.
 */
export function sweepPageTrash(
  session: DocSession,
  retentionMs: number,
  spanOf: (slot: number) => PageSpan,
): number {
  if (!session.canWrite || retentionMs < 0) return 0

  const cutoff = Date.now() - retentionMs
  // Collected before any of it is applied: purging removes entries from the array, so
  // walking and deleting in one pass would work off indices that have moved.
  const expired = entries(session).filter(
    (entry) => entry.deletedAt > 0 && entry.deletedAt <= cutoff,
  )

  let gone = 0
  for (const entry of expired) {
    if (purgePage(session, entry.page.id, spanOf(entry.page.slot))) gone += 1
  }
  return gone
}

/**
 * The stock this lea is printed on, or '' to take the reader's own default.
 *
 * The diary's, not the page's and not the reader's. A notebook is bound with one
 * paper: flipping to the next page and finding a different stock reads as a bug rather
 * than as a choice, so this is one value for the whole document even though ruling and
 * measure are per page. '' is the deferral - the lea has no opinion, and each reader's
 * profile default decides - which is why this is a string rather than one of the four
 * papers with a fifth invented for "unset".
 *
 * Unvalidated on read beyond "is it a string": an older client that has never heard of
 * a paper added later should fall back to its own default rather than render nothing,
 * and the styling layer already ignores a name it has no rules for.
 */
const META_PAPER = 'pagePaper'

export function readLeaPaper(session: DocSession): string {
  return text(session.meta.get(META_PAPER))
}

export function setLeaPaper(session: DocSession, paper: string): void {
  if (!session.canWrite || readLeaPaper(session) === paper) return
  session.doc.transact(() => {
    session.meta.set(META_PAPER, paper)
  }, LOCAL_ORIGIN)
}

/**
 * Subscribe to the diary's own values. For `useSyncExternalStore`.
 *
 * Deep, because a page's subject lives in a `Y.Map` inside the list and a shallow
 * observer on `meta` hears the list being replaced and nothing that happens inside it.
 */
export function observePageMeta(session: DocSession, onChange: () => void): () => void {
  const handler = (): void => onChange()
  session.meta.observeDeep(handler)
  return () => session.meta.unobserveDeep(handler)
}

/**
 * Put every row of a ruled page back on the ruling.
 *
 * A row's position is a band index times the rule pitch, and the pitch is
 * `fontSize * lineHeight` of the page's own type. Change the type and every row
 * already in the document is anchored to a pitch that no longer exists: the first line
 * still looks right, the second is a couple of pixels out, and by the tenth the
 * writing is sitting half a band above its rule. It reads as the page slowly coming
 * apart rather than as a setting that changed, which is why this repairs rather than
 * leaving it to the reader to notice.
 *
 * Rows are re-seated in the order they already sit in, never merged: two rows that
 * round onto the same band push the later one down. Blank rules between entries are
 * kept where rounding allows and closed up where it does not, because losing a blank
 * line is a much smaller wrong than stacking two entries on one rule.
 *
 * Page by page, because two pages are two strips of the world at the same heights: a
 * run computed across all of them would see page two's first line as a collision with
 * page one's and push it a rule down the paper it does not share.
 *
 * The measure is repaired with the pitch, and for the same reason. A row spans its
 * page's whole width, so a document written when the column was narrower has rows that
 * stop short of the right margin - the ruling reaches the edge and the writing wraps
 * before it, which reads as a broken page rather than as a measure that changed. The
 * page a row is on is its `x` rounded to the pitch, which is a constant, so widening
 * the column never moves a row to a different page.
 *
 * A no-op once everything is on a band and on the measure, so opening a page that has
 * already been repaired writes nothing and a viewer never needs it at all.
 */
export function reseatWritingRows(
  session: DocSession,
  spacing: number,
  stride: number,
  width: number,
): void {
  if (!session.canWrite || !Number.isFinite(spacing) || spacing <= 0) return
  if (!Number.isFinite(stride) || stride <= 0) return
  if (!Number.isFinite(width) || width <= 0) return

  const rows = Array.from(session.objects.keys())
    .map((id) => ({ id, object: readObjectById(session, id) }))
    .filter((row): row is { id: string; object: ObjectData } => row.object?.type === 'text')
    .sort((a, b) => a.object.y - b.object.y)

  const patches: { id: string; patch: Partial<ObjectData> }[] = []
  // Not zero: a ruled page can have rows above its first rule - the header's date is
  // one - and starting the run at the top rule would drag them down onto the page.
  const lastBand = new Map<number, number>()

  for (const { id, object } of rows) {
    const slot = Math.round(object.x / stride)
    const floor = lastBand.get(slot) ?? Number.NEGATIVE_INFINITY
    const band = Math.max(Math.round(object.y / spacing), floor)
    // How many rules this row's writing actually covers, so the next one clears it.
    // Counting one per row instead was the bug this repair could not see: a row whose
    // writing had wrapped over three rules only reserved the first, and the row below
    // was left sitting inside it with both painted on top of each other.
    lastBand.set(slot, band + Math.max(1, Math.round(object.h / spacing)))

    const y = band * spacing
    const x = slot * stride
    // Exact equality would rewrite every row on every open, because the pitch is a
    // product of two floats and the stored value is what a previous round of this
    // wrote. A twentieth of a unit is far below anything anybody can see.
    const patch: Partial<ObjectData> = {}
    if (Math.abs(object.y - y) > 0.05) patch.y = y
    if (Math.abs(object.x - x) > 0.05) patch.x = x
    if (Math.abs(object.w - width) > 0.05) patch.w = width
    if (Object.keys(patch).length > 0) patches.push({ id, patch })
  }

  if (patches.length > 0) updateObjects(session, patches)
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
