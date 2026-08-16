/**
 * Tests for the write path.
 *
 * These cover the invariants nothing else enforces: `order` staying in step with
 * `objects`, undo staying scoped to local edits, and a deleted object leaving its
 * arrows alive. Each of those fails silently at runtime rather than throwing.
 */

import { createBindingMap } from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  ReadOnlyError,
  addObject,
  bringForward,
  bringToFront,
  clearObjects,
  createDocSession,
  deleteObjects,
  endGesture,
  reconcileOrder,
  sendBackward,
  sendToBack,
  updateObject,
  updateObjects,
} from './mutations'

const session = (role: 'owner' | 'viewer' = 'owner') => createDocSession(new Y.Doc(), role)

function seed(count: number): { doc: ReturnType<typeof session>; ids: string[] } {
  const doc = session()
  const ids = Array.from({ length: count }, () => addObject(doc, { type: 'rect' }))
  return { doc, ids }
}

describe('object writes', () => {
  it('appends new objects to the top of the z-order', () => {
    const { doc, ids } = seed(3)
    expect(doc.order.toArray()).toEqual(ids)
    expect(doc.objects.size).toBe(3)
  })

  it('applies defaults through the schema', () => {
    const doc = session()
    const id = addObject(doc, { type: 'ellipse', x: 5, y: 6 })
    const object = doc.objects.get(id)

    expect(object?.get('type')).toBe('ellipse')
    expect(object?.get('rotation')).toBe(0)
    expect(object?.get('opacity')).toBe(1)
    expect(object?.get('locked')).toBe(false)
    expect(object?.get('parentId')).toBeNull()
  })

  it('gives text-bearing types an XmlFragment and others none', () => {
    const doc = session()
    const sticky = doc.objects.get(addObject(doc, { type: 'sticky' }))
    const rect = doc.objects.get(addObject(doc, { type: 'rect' }))

    expect(sticky?.get('text')).toBeInstanceOf(Y.XmlFragment)
    expect(rect?.get('text')).toBeUndefined()
  })

  it('merges props per key instead of replacing the map', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect', props: { fill: 1, strokeWidth: 3 } })

    updateObject(doc, id, { props: { fill: 2 } })

    const props = doc.objects.get(id)?.get('props') as Y.Map<unknown>
    expect(props.get('fill')).toBe(2)
    // A concurrent edit to a property this patch never mentioned must survive.
    expect(props.get('strokeWidth')).toBe(3)
  })

  it('moves a multi-selection in a single transaction', () => {
    const { doc, ids } = seed(3)
    let transactions = 0
    doc.doc.on('afterTransaction', () => {
      transactions += 1
    })

    updateObjects(
      doc,
      ids.map((id) => ({ id, patch: { x: 10 } })),
    )

    expect(transactions).toBe(1)
  })
})

describe('deletion', () => {
  it('removes the object from both objects and order', () => {
    const { doc, ids } = seed(3)
    deleteObjects(doc, [ids[1]])

    expect(doc.objects.has(ids[1])).toBe(false)
    expect(doc.order.toArray()).toEqual([ids[0], ids[2]])
  })

  it('removes several at once without dropping the survivors', () => {
    const { doc, ids } = seed(5)
    deleteObjects(doc, [ids[0], ids[2], ids[4]])
    expect(doc.order.toArray()).toEqual([ids[1], ids[3]])
  })

  it('frees bindings to a deleted object rather than deleting the arrow', () => {
    const { doc, ids } = seed(2)
    doc.doc.transact(() => {
      doc.bindings.set(
        'binding-1',
        createBindingMap({
          id: 'binding-1',
          arrowId: 'arrow-1',
          end: 'start',
          targetId: ids[0],
          anchor: { nx: 0.5, ny: 0.5 },
          gap: 4,
        }),
      )
    })

    deleteObjects(doc, [ids[0]])

    // ARCHITECTURE 4: the arrow survives with a free endpoint.
    expect(doc.bindings.has('binding-1')).toBe(true)
    expect(doc.bindings.get('binding-1')?.get('targetId')).toBeNull()
  })

  it('clears both roots together', () => {
    const { doc } = seed(4)
    clearObjects(doc)
    expect(doc.objects.size).toBe(0)
    expect(doc.order.length).toBe(0)
  })
})

describe('z-order', () => {
  it('brings to front and sends to back, preserving relative order', () => {
    const { doc, ids } = seed(4)

    bringToFront(doc, [ids[0], ids[1]])
    expect(doc.order.toArray()).toEqual([ids[2], ids[3], ids[0], ids[1]])

    sendToBack(doc, [ids[3]])
    expect(doc.order.toArray()).toEqual([ids[3], ids[2], ids[0], ids[1]])
  })

  it('steps one position at a time', () => {
    const { doc, ids } = seed(4)

    bringForward(doc, [ids[0]])
    expect(doc.order.toArray()).toEqual([ids[1], ids[0], ids[2], ids[3]])

    sendBackward(doc, [ids[0]])
    expect(doc.order.toArray()).toEqual(ids)
  })

  it('does not push past the ends', () => {
    const { doc, ids } = seed(3)
    sendBackward(doc, [ids[0]])
    expect(doc.order.toArray()).toEqual(ids)
    bringForward(doc, [ids[2]])
    expect(doc.order.toArray()).toEqual(ids)
  })

  it('keeps a contiguous block together when stepping', () => {
    const { doc, ids } = seed(4)
    bringForward(doc, [ids[0], ids[1]])
    expect(doc.order.toArray()).toEqual([ids[2], ids[0], ids[1], ids[3]])
  })
})

describe('reconcileOrder', () => {
  it('adds objects missing from order and drops stale ids', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect' })

    // Simulate a document where the two roots have drifted apart.
    doc.doc.transact(() => {
      doc.order.delete(0, doc.order.length)
      doc.order.insert(0, ['ghost'])
    })

    reconcileOrder(doc)

    // An object absent from `order` is never drawn or hit-tested, so it would look
    // deleted while still occupying the map.
    expect(doc.order.toArray()).toEqual([id])
  })

  it('leaves a healthy document untouched', () => {
    const { doc, ids } = seed(3)
    reconcileOrder(doc)
    expect(doc.order.toArray()).toEqual(ids)
  })

  it('removes duplicates', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect' })
    doc.doc.transact(() => doc.order.insert(0, [id]))

    reconcileOrder(doc)
    expect(doc.order.toArray()).toEqual([id])
  })
})

describe('undo', () => {
  it('undoes a whole gesture, not each frame of it', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect', x: 0, y: 0 })
    endGesture(doc)

    // A drag writes on every pointermove.
    for (let step = 1; step <= 10; step += 1) updateObject(doc, id, { x: step * 10 })
    endGesture(doc)

    expect(doc.objects.get(id)?.get('x')).toBe(100)
    doc.undo.undo()
    expect(doc.objects.get(id)?.get('x')).toBe(0)
  })

  it('ignores remote changes', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect', x: 0 })
    endGesture(doc)

    // A remote update arrives with a different origin.
    doc.doc.transact(() => {
      doc.objects.get(id)?.set('x', 999)
    }, 'remote')

    doc.undo.undo()

    // Undo reverted the local creation, and never touched the remote write.
    expect(doc.objects.has(id)).toBe(false)
  })

  it('redoes what it undid', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect' })
    endGesture(doc)

    doc.undo.undo()
    expect(doc.objects.has(id)).toBe(false)
    doc.undo.redo()
    expect(doc.objects.has(id)).toBe(true)
  })
})

describe('read-only roles', () => {
  it('refuses every write path', () => {
    const doc = session('viewer')

    expect(() => addObject(doc, { type: 'rect' })).toThrow(ReadOnlyError)
    expect(() => updateObject(doc, 'x', { x: 1 })).toThrow(ReadOnlyError)
    expect(() => deleteObjects(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => clearObjects(doc)).toThrow(ReadOnlyError)
    expect(() => bringToFront(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => sendToBack(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => bringForward(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => sendBackward(doc, ['x'])).toThrow(ReadOnlyError)
  })

  it('leaves the document untouched after a refused write', () => {
    const doc = session('viewer')
    expect(() => addObject(doc, { type: 'rect' })).toThrow()

    // A viewer's own Y.Doc would happily apply a local edit, which is exactly the
    // failure this guard exists to prevent: edits that look applied, survive a
    // reload through y-indexeddb, then vanish when the server's state wins.
    expect(doc.objects.size).toBe(0)
    expect(doc.order.length).toBe(0)
  })

  it('does not repair order for a viewer', () => {
    const doc = session('viewer')
    doc.doc.transact(() => doc.order.insert(0, ['ghost']))
    reconcileOrder(doc)
    expect(doc.order.toArray()).toEqual(['ghost'])
  })
})

describe('the local edit lock', () => {
  const locked = (role: 'owner' | 'viewer' = 'owner') =>
    createDocSession(new Y.Doc(), role, true)

  it('refuses every write path for an owner who locked the glade', () => {
    const doc = locked()

    expect(() => addObject(doc, { type: 'rect' })).toThrow(ReadOnlyError)
    expect(() => updateObject(doc, 'x', { x: 1 })).toThrow(ReadOnlyError)
    expect(() => deleteObjects(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => clearObjects(doc)).toThrow(ReadOnlyError)
    expect(() => bringToFront(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => sendToBack(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => bringForward(doc, ['x'])).toThrow(ReadOnlyError)
    expect(() => sendBackward(doc, ['x'])).toThrow(ReadOnlyError)
  })

  it('leaves the document untouched after a refused write', () => {
    const doc = locked()
    expect(() => addObject(doc, { type: 'rect' })).toThrow()
    expect(doc.objects.size).toBe(0)
    expect(doc.order.length).toBe(0)
  })

  it('says the glade is locked rather than blaming the role', () => {
    // The message reaches the user as a notice. Telling an owner their *role* is
    // read-only when they locked the board themselves sends them to sharing settings
    // to fix something that is not broken.
    expect(() => addObject(locked(), { type: 'rect' })).toThrow(/locked/i)
    expect(() => addObject(session('viewer'), { type: 'rect' })).toThrow(/role/i)
  })

  it('is not a permission: unlocking gives a viewer nothing', () => {
    const unlocked = createDocSession(new Y.Doc(), 'viewer', false)
    expect(unlocked.canWrite).toBe(false)
    expect(() => addObject(unlocked, { type: 'rect' })).toThrow(ReadOnlyError)
  })

  it('restores writing when the lock comes off', () => {
    const doc = createDocSession(new Y.Doc(), 'owner', false)
    expect(doc.canWrite).toBe(true)
    expect(() => addObject(doc, { type: 'rect' })).not.toThrow()
    expect(doc.objects.size).toBe(1)
  })

  it('defaults to unlocked, so an existing caller is unaffected', () => {
    expect(createDocSession(new Y.Doc(), 'owner').locked).toBe(false)
    expect(createDocSession(new Y.Doc(), 'owner').canWrite).toBe(true)
  })
})
