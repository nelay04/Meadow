/**
 * Client-side convergence. ARCHITECTURE 12.
 *
 * The server-side half of §12 lives in `services/api/tests/test_concurrency.py`, where
 * peers talk through a real socket. This covers the parts that are purely client
 * behaviour: the repair functions that run on load, and the one case where the
 * documented behaviour is *surprising* and therefore has to be pinned down so a future
 * change to undo scoping cannot alter it unnoticed.
 *
 * Two Y.Docs wired directly to each other stand in for two peers. That is exactly what
 * the network does to an update, minus the transport, so it is the right level for
 * asserting merge outcomes.
 */

import { arrowGeometry } from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  type DocSession,
  addObject,
  bindArrow,
  createDocSession,
  deleteObjects,
  reconcileBindings,
  reconcileOrder,
  updateObject,
} from './mutations'

/** Two sessions that exchange updates directly, like two clients in a room. */
function pair(): { alice: DocSession; bob: DocSession; sync: () => void } {
  const alice = createDocSession(new Y.Doc(), 'owner')
  const bob = createDocSession(new Y.Doc(), 'owner')

  const sync = (): void => {
    // Both directions, twice, so a change that only becomes visible after the peer has
    // applied the first round still lands.
    for (let round = 0; round < 2; round += 1) {
      Y.applyUpdate(bob.doc, Y.encodeStateAsUpdate(alice.doc, Y.encodeStateVector(bob.doc)))
      Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc, Y.encodeStateVector(alice.doc)))
    }
  }

  return { alice, bob, sync }
}

describe('two peers', () => {
  it('keeps both sets of edits when each creates different objects', () => {
    const { alice, bob, sync } = pair()

    addObject(alice, { type: 'rect', id: 'a' })
    addObject(bob, { type: 'ellipse', id: 'b' })
    sync()

    for (const session of [alice, bob]) {
      expect(new Set(session.objects.keys())).toEqual(new Set(['a', 'b']))
      expect(new Set(session.order.toArray())).toEqual(new Set(['a', 'b']))
    }
  })

  it('resolves a contended field without losing an uncontended one', () => {
    const { alice, bob, sync } = pair()

    addObject(alice, { type: 'rect', id: 'shared', x: 0, y: 0 })
    sync()

    updateObject(alice, 'shared', { x: 111, y: 50 })
    updateObject(bob, 'shared', { x: 222, w: 300 })
    sync()

    const left = alice.objects.get('shared')
    const right = bob.objects.get('shared')

    expect(left?.get('x')).toBe(right?.get('x'))
    expect([111, 222]).toContain(left?.get('x'))
    expect(left?.get('y')).toBe(50)
    expect(left?.get('w')).toBe(300)
  })

  it('does not resurrect an object one peer deleted while the other dragged it', () => {
    const { alice, bob, sync } = pair()

    addObject(alice, { type: 'rect', id: 'doomed' })
    sync()

    deleteObjects(alice, ['doomed'])
    updateObject(bob, 'doomed', { x: 500 })
    sync()

    expect(alice.objects.has('doomed')).toBe(false)
    expect(bob.objects.has('doomed')).toBe(false)
  })

  it('leaves no object missing from the order after concurrent restacks', () => {
    const { alice, bob, sync } = pair()

    for (const id of ['a', 'b', 'c', 'd']) addObject(alice, { type: 'rect', id })
    sync()

    // `applyOrder` rewrites the array wholesale, so two of them can interleave into
    // duplicates or gaps. Convergence is required; a tidy result is not.
    bringToFrontRaw(alice, ['d', 'c'])
    bringToFrontRaw(bob, ['b', 'a'])
    sync()

    expect(alice.order.toArray()).toEqual(bob.order.toArray())

    // The repair is what makes the interleaving survivable: after it, every object is
    // listed exactly once. An object absent from `order` is never drawn or hit-tested,
    // so it looks deleted while still occupying the map.
    reconcileOrder(alice)
    sync()

    const order = alice.order.toArray()
    expect(new Set(order)).toEqual(new Set(['a', 'b', 'c', 'd']))
    expect(order.length).toBe(4)
    expect(alice.order.toArray()).toEqual(bob.order.toArray())
  })

  it('repairs an order that arrived missing an id', () => {
    const session = createDocSession(new Y.Doc(), 'owner')
    addObject(session, { type: 'rect', id: 'a' })
    addObject(session, { type: 'rect', id: 'b' })

    // What a document written by an older client, or a raced insert, can look like.
    session.doc.transact(() => {
      session.order.delete(0, session.order.length)
      session.order.insert(0, ['a'])
    })

    reconcileOrder(session)

    expect(new Set(session.order.toArray())).toEqual(new Set(['a', 'b']))
  })

  it('re-solves a bound arrow whose target moved while this peer was away', () => {
    const { alice, bob, sync } = pair()

    const boxId = addObject(alice, { type: 'rect', id: 'box', x: 0, y: 0, w: 100, h: 100 })
    const geometry = arrowGeometry([50, 50, 500, 50])
    const arrowId = addObject(alice, {
      type: 'arrow',
      id: 'arrow',
      x: geometry.x,
      y: geometry.y,
      w: geometry.w,
      h: geometry.h,
      props: { points: geometry.points },
    })
    bindArrow(alice, {
      arrowId,
      end: 'start',
      targetId: boxId,
      anchor: { nx: 0.5, ny: 0.5 },
      gap: 0,
    })
    sync()

    // Bob moves the box. Alice applies the update, but her arrow was solved against
    // the old position and nothing on her side re-ran the solver.
    updateObject(bob, boxId, { x: 400 })
    Y.applyUpdate(alice.doc, Y.encodeStateAsUpdate(bob.doc, Y.encodeStateVector(alice.doc)))

    reconcileBindings(alice)

    const arrow = alice.objects.get('arrow')
    const points = arrow?.get('props') as Y.Map<unknown>
    const relative = points.get('points') as number[]
    // Box now spans 400..500 and the arrow approaches from the right, so the endpoint
    // is on its right edge at x=500.
    expect(Number(arrow?.get('x')) + relative[0]).toBeCloseTo(500, 6)
  })

  /*
   * ARCHITECTURE 4 warns that "local undo can resurrect an object a remote user
   * deleted". Measured, that is narrower than it sounds, and the three tests below
   * pin down which reading is true. Only undoing your *own* delete resurrects.
   *
   * Worth being exact about, because the loose version implies undo is dangerous
   * near any concurrent delete, and it is not.
   */

  it('resurrects an object when undoing your own delete, even if a peer deleted it too', () => {
    const { alice, bob, sync } = pair()

    addObject(alice, { type: 'rect', id: 'thing' })
    sync()

    alice.undo.stopCapturing()
    deleteObjects(alice, ['thing'])
    deleteObjects(bob, ['thing'])
    sync()
    expect(alice.objects.has('thing')).toBe(false)

    alice.undo.undo()
    sync()

    // The undo re-inserts, and an insert beats a tombstone, so it comes back for
    // everyone rather than only locally. Accepted behaviour; Figma does the same.
    // Asserted rather than merely written down, so a future change to undo scoping
    // cannot alter it silently.
    expect(alice.objects.has('thing')).toBe(true)
    expect(bob.objects.has('thing')).toBe(true)
  })

  it('does not resurrect when undoing an edit to an object a peer deleted', () => {
    const { alice, bob, sync } = pair()

    addObject(alice, { type: 'rect', id: 'thing', x: 0 })
    sync()

    alice.undo.stopCapturing()
    updateObject(alice, 'thing', { x: 100 })
    deleteObjects(bob, ['thing'])
    sync()

    alice.undo.undo()
    sync()

    // Restoring a field value does not restore the map that held it.
    expect(alice.objects.has('thing')).toBe(false)
    expect(bob.objects.has('thing')).toBe(false)
  })

  it('does not resurrect when redoing a creation a peer has since deleted', () => {
    const { alice, bob, sync } = pair()

    addObject(alice, { type: 'rect', id: 'thing' })
    sync()
    deleteObjects(bob, ['thing'])
    sync()

    alice.undo.undo()
    sync()
    alice.undo.redo()
    sync()

    expect(alice.objects.has('thing')).toBe(false)
    expect(bob.objects.has('thing')).toBe(false)
  })

  it('never lets a remote change enter the local undo stack', () => {
    const { alice, bob, sync } = pair()

    addObject(bob, { type: 'rect', id: 'theirs' })
    sync()

    // Alice has made no edits, so there is nothing of hers to undo. Without the origin
    // filter on the UndoManager this would revert a collaborator's work.
    alice.undo.undo()

    expect(alice.objects.has('theirs')).toBe(true)
  })
})

/** `bringToFront` without the exported wrapper, so the test can drive two peers. */
function bringToFrontRaw(session: DocSession, ids: readonly string[]): void {
  const selected = new Set(ids)
  session.doc.transact(() => {
    const current = session.order.toArray()
    session.order.delete(0, session.order.length)
    session.order.insert(0, [
      ...current.filter((id) => !selected.has(id)),
      ...current.filter((id) => selected.has(id)),
    ])
  }, 'local')
}
