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
  addPage,
  addPageLines,
  bringForward,
  bringToFront,
  clearObjects,
  createDocSession,
  ensureObjectFragment,
  deleteObjects,
  endGesture,
  moveBehind,
  moveToDepth,
  purgePage,
  readObjectById,
  readPages,
  readTrashedPages,
  reconcileOrder,
  removePage,
  reseatWritingRows,
  restorePage,
  sendBackward,
  setPageSubject,
  sweepPageTrash,
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
    // The primitives became text-bearing in M6: a shape you cannot label is a shape
    // that needs a second object stuck to it.
    const rect = doc.objects.get(addObject(doc, { type: 'rect' }))
    const ellipse = doc.objects.get(addObject(doc, { type: 'ellipse' }))
    // And arrows, which carry the label that says what the connection means.
    const arrow = doc.objects.get(addObject(doc, { type: 'arrow' }))
    const image = doc.objects.get(addObject(doc, { type: 'image' }))

    expect(sticky?.get('text')).toBeInstanceOf(Y.XmlFragment)
    expect(rect?.get('text')).toBeInstanceOf(Y.XmlFragment)
    expect(ellipse?.get('text')).toBeInstanceOf(Y.XmlFragment)
    expect(arrow?.get('text')).toBeInstanceOf(Y.XmlFragment)
    expect(image?.get('text')).toBeUndefined()
  })

  it('attaches a fragment to a shape that predates text-bearing primitives', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect' })

    // Stand in for a document written before the change: the shape exists, the key
    // does not. Deleting it is the only honest way to reproduce that here.
    doc.doc.transact(() => doc.objects.get(id)?.delete('text'))
    expect(doc.objects.get(id)?.get('text')).toBeUndefined()

    const fragment = ensureObjectFragment(doc, id)
    expect(fragment).toBeInstanceOf(Y.XmlFragment)
    expect(doc.objects.get(id)?.get('text')).toBe(fragment)
  })

  it('returns the existing fragment rather than replacing it', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect' })
    const first = ensureObjectFragment(doc, id)
    // A second call must not swap the fragment out. Two fragments would mean two
    // people typing into different documents that both claim to be this shape.
    expect(ensureObjectFragment(doc, id)).toBe(first)
  })

  it('attaches nothing to a type that carries no text, or for a viewer', () => {
    const doc = session()
    const image = addObject(doc, { type: 'image' })
    expect(ensureObjectFragment(doc, image)).toBeNull()

    const viewer = session('viewer')
    expect(ensureObjectFragment(viewer, 'anything')).toBeNull()
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

  it('places at an absolute depth', () => {
    const { doc, ids } = seed(4)
    moveToDepth(doc, [ids[3]], 1)
    expect(doc.order.toArray()).toEqual([ids[0], ids[3], ids[1], ids[2]])
  })

  it('clamps a depth past either end instead of refusing it', () => {
    const { doc, ids } = seed(3)

    // What somebody typing 900 into the depth badge means, and it is not an error.
    moveToDepth(doc, [ids[0]], 900)
    expect(doc.order.toArray()).toEqual([ids[1], ids[2], ids[0]])

    moveToDepth(doc, [ids[0]], -4)
    expect(doc.order.toArray()).toEqual([ids[0], ids[1], ids[2]])
  })

  it('moves a scattered selection as one contiguous block, in document order', () => {
    const { doc, ids } = seed(5)
    // Named back to front on purpose: the block is read off `order`, not off the
    // order the ids happened to arrive in.
    moveToDepth(doc, [ids[3], ids[0]], 1)
    expect(doc.order.toArray()).toEqual([ids[1], ids[0], ids[3], ids[2], ids[4]])
  })

  it('drops a block directly behind a named neighbour', () => {
    const { doc, ids } = seed(4)
    moveBehind(doc, [ids[0]], ids[3])
    expect(doc.order.toArray()).toEqual([ids[1], ids[2], ids[0], ids[3]])
  })

  it('sends a block to the front when it is behind nothing', () => {
    const { doc, ids } = seed(3)
    moveBehind(doc, [ids[0], ids[1]], null)
    expect(doc.order.toArray()).toEqual([ids[2], ids[0], ids[1]])
  })

  it('counts the neighbour after the block has been lifted out', () => {
    // The off-by-one a drag down a list produces if the block's own rows are still
    // counted as neighbours: `ids[0]` must land behind `ids[2]`, not behind `ids[1]`.
    const { doc, ids } = seed(4)
    moveBehind(doc, [ids[0]], ids[2])
    expect(doc.order.toArray()).toEqual([ids[1], ids[0], ids[2], ids[3]])
  })

  it('leaves the order alone when the ids are not in it', () => {
    const { doc, ids } = seed(3)
    moveToDepth(doc, ['ghost'], 0)
    moveBehind(doc, ['ghost'], ids[0])
    expect(doc.order.toArray()).toEqual(ids)
  })

  it('refuses both absolute moves for a viewer', () => {
    const doc = session('viewer')
    expect(() => moveToDepth(doc, ['x'], 0)).toThrow(ReadOnlyError)
    expect(() => moveBehind(doc, ['x'], null)).toThrow(ReadOnlyError)
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

/*
 * The pages of a lea.
 *
 * The invariants worth a test are the ones that fail quietly: a page's writing is
 * identified by where it is rather than by an id on it, so a slot handed out twice or
 * a span computed a little wrong loses somebody's diary entry rather than throwing.
 */
describe('pages', () => {
  const LINES = 25
  /** The same arithmetic `pageSpan` does, kept here so the test states it too. */
  const span = (slot: number) => ({ left: slot * 2760, right: slot * 2760 + 760 })

  it('reads a lea that predates the page list as its one page', () => {
    const doc = session()
    doc.meta.set('pageSubject', 'The old page')
    doc.meta.set('pageDate', '2026-03-12')
    doc.meta.set('pageLines', 40)

    expect(readPages(doc, LINES)).toEqual([
      { id: 'page-1', slot: 0, subject: 'The old page', date: '2026-03-12', lines: 40 },
    ])
  })

  it('keeps what that page said when the first write materialises the list', () => {
    const doc = session()
    doc.meta.set('pageSubject', 'The old page')
    doc.meta.set('pageLines', 40)

    addPage(doc, LINES)

    const pages = readPages(doc, LINES)
    expect(pages).toHaveLength(2)
    expect(pages[0]?.subject).toBe('The old page')
    expect(pages[0]?.lines).toBe(40)
    expect(pages[1]?.subject).toBe('')
  })

  it('gives every page a slot of its own, and never reuses one', () => {
    const doc = session()
    addPage(doc, LINES)
    addPage(doc, LINES)
    expect(readPages(doc, LINES).map((page) => page.slot)).toEqual([0, 1, 2])

    removePage(doc, 1)
    addPage(doc, LINES)
    // Not 1 again: writing left in that strip by a client that never saw the removal
    // would otherwise turn up on the new page.
    expect(readPages(doc, LINES).map((page) => page.slot)).toEqual([0, 2, 3])
  })

  it('writes a subject onto the page it was given, not onto the open one', () => {
    const doc = session()
    addPage(doc, LINES)
    setPageSubject(doc, 1, 'Tuesday', LINES)
    expect(readPages(doc, LINES).map((page) => page.subject)).toEqual(['', 'Tuesday'])
  })

  it('does nothing when the page it was given is no longer there', () => {
    const doc = session()
    addPage(doc, LINES)
    removePage(doc, 1)
    setPageSubject(doc, 1, 'Tuesday', LINES)
    expect(readPages(doc, LINES).map((page) => page.subject)).toEqual([''])
  })

  it('keeps the writing on a torn-out page, so putting it back puts it back', () => {
    const doc = session()
    addPage(doc, LINES)
    const kept = addObject(doc, { type: 'text', x: 0, y: 30, w: 760, h: 30 })
    const torn = addObject(doc, { type: 'text', x: 2760, y: 30, w: 760, h: 30 })

    expect(removePage(doc, 1)).toBe(true)
    // Out of the diary and into its trash, with everything on it still in the
    // document. Nothing can reach the writing meanwhile: the camera is fenced to the
    // open page's slot.
    expect(readPages(doc, LINES)).toHaveLength(1)
    expect(doc.objects.has(kept)).toBe(true)
    expect(doc.objects.has(torn)).toBe(true)

    const trashed = readTrashedPages(doc, LINES)
    expect(trashed).toHaveLength(1)
    expect(restorePage(doc, trashed[0]!.id)).toBe(true)

    // Back in its own place, not at the end, and still holding its own writing.
    expect(readPages(doc, LINES).map((page) => page.slot)).toEqual([0, 1])
    expect(readTrashedPages(doc, LINES)).toHaveLength(0)
    expect(doc.objects.has(torn)).toBe(true)
  })

  it('takes the writing with it when the page is purged, and leaves every other page alone', () => {
    const doc = session()
    addPage(doc, LINES)
    const kept = addObject(doc, { type: 'text', x: 0, y: 30, w: 760, h: 30 })
    const torn = addObject(doc, { type: 'text', x: 2760, y: 30, w: 760, h: 30 })

    expect(removePage(doc, 1)).toBe(true)
    const trashed = readTrashedPages(doc, LINES)[0]!
    expect(purgePage(doc, trashed.id, span(trashed.slot))).toBe(true)

    expect(doc.objects.has(kept)).toBe(true)
    expect(doc.objects.has(torn)).toBe(false)
    expect(doc.order.toArray()).toEqual([kept])
    expect(readTrashedPages(doc, LINES)).toHaveLength(0)
  })

  it('will not purge a page that is still in the diary', () => {
    const doc = session()
    addPage(doc, LINES)
    const written = addObject(doc, { type: 'text', x: 2760, y: 30, w: 760, h: 30 })

    const open = readPages(doc, LINES)[1]!
    expect(purgePage(doc, open.id, span(open.slot))).toBe(false)
    expect(doc.objects.has(written)).toBe(true)
  })

  it('sweeps only what has outlived the window', () => {
    const doc = session()
    addPage(doc, LINES)
    addPage(doc, LINES)
    const old = addObject(doc, { type: 'text', x: 2760, y: 30, w: 760, h: 30 })
    const recent = addObject(doc, { type: 'text', x: 5520, y: 30, w: 760, h: 30 })

    // Torn out an hour ago and just now. The first is past a ten-minute window and
    // the second is not.
    removePage(doc, 1)
    removePage(doc, 1)
    const stored = doc.meta.get('pages') as Y.Array<Y.Map<unknown>>
    ;(stored.get(1) as Y.Map<unknown>).set('deletedAt', Date.now() - 3600_000)

    expect(sweepPageTrash(doc, 10 * 60_000, span)).toBe(1)
    expect(doc.objects.has(old)).toBe(false)
    expect(doc.objects.has(recent)).toBe(true)
    expect(readTrashedPages(doc, LINES)).toHaveLength(1)
  })

  it('counts pages the way the list draws them while something is in the trash', () => {
    const doc = session()
    addPage(doc, LINES)
    addPage(doc, LINES)
    setPageSubject(doc, 1, 'Tuesday', LINES)

    // Tear out page one. "Page two" now means Tuesday's, which has moved up a place,
    // and a write to index 1 must land on the third page rather than back on Tuesday.
    expect(removePage(doc, 0)).toBe(true)
    setPageSubject(doc, 1, 'Wednesday', LINES)
    expect(readPages(doc, LINES).map((page) => page.subject)).toEqual(['Tuesday', 'Wednesday'])
  })

  it('refuses to remove the last page', () => {
    const doc = session()
    addPage(doc, LINES)
    expect(removePage(doc, 0)).toBe(true)
    expect(removePage(doc, 0)).toBe(false)
    expect(readPages(doc, LINES)).toHaveLength(1)
  })

  it('refuses every page write to a viewer', () => {
    const doc = session('viewer')
    expect(addPage(doc, LINES)).toBe(-1)
    setPageSubject(doc, 0, 'Tuesday', LINES)
    addPageLines(doc, 0, 10, LINES)
    expect(readPages(doc, LINES)).toEqual([
      { id: 'page-1', slot: 0, subject: '', date: '', lines: LINES },
    ])
  })

  it('re-seats each page onto its own ruling rather than across all of them', () => {
    const doc = session()
    // Two pages, both written before the type changed: the same bands, in two strips.
    const first = addObject(doc, { type: 'text', x: 0, y: 0, w: 760, h: 28 })
    const second = addObject(doc, { type: 'text', x: 2760, y: 0, w: 760, h: 28 })

    reseatWritingRows(doc, 30.45, 2760, 760)

    // Page two's first line stays its first line. Across one run it would have been
    // pushed a rule down for colliding with page one's.
    expect(readObjectById(doc, first)?.y).toBeCloseTo(0, 5)
    expect(readObjectById(doc, second)?.y).toBeCloseTo(0, 5)
  })

  it('moves a row out from under one whose writing has wrapped over it', () => {
    const doc = session()
    // A three-rule row starting on rule 21, and a row that was written on rule 23
    // before it grew. They overlap, which paints one line of writing over another.
    const tall = addObject(doc, { type: 'text', x: 0, y: 639.45, w: 860, h: 91.35 })
    const buried = addObject(doc, { type: 'text', x: 0, y: 700.35, w: 860, h: 30.45 })

    reseatWritingRows(doc, 30.45, 2760, 860)

    expect(readObjectById(doc, tall)?.y).toBeCloseTo(639.45, 4)
    // The first rule clear of the tall row, which is rule 24.
    expect(readObjectById(doc, buried)?.y).toBeCloseTo(730.8, 4)
  })

  it('leaves rows that already clear each other exactly where they are', () => {
    const doc = session()
    // A page written with deliberate gaps. Nothing here overlaps, so nothing moves.
    const first = addObject(doc, { type: 'text', x: 0, y: 0, w: 860, h: 30.45 })
    const second = addObject(doc, { type: 'text', x: 0, y: 304.5, w: 860, h: 30.45 })
    const third = addObject(doc, { type: 'text', x: 0, y: 1735.65, w: 860, h: 30.45 })

    reseatWritingRows(doc, 30.45, 2760, 860)

    expect(readObjectById(doc, first)?.y).toBeCloseTo(0, 4)
    expect(readObjectById(doc, second)?.y).toBeCloseTo(304.5, 4)
    expect(readObjectById(doc, third)?.y).toBeCloseTo(1735.65, 4)
  })

  it('widens rows written at a narrower measure without moving them off their page', () => {
    const doc = session()
    const first = addObject(doc, { type: 'text', x: 0, y: 0, w: 760, h: 28 })
    const second = addObject(doc, { type: 'text', x: 2760, y: 0, w: 760, h: 28 })

    // The pitch is a constant, so only the measure moved.
    reseatWritingRows(doc, 30.45, 2760, 860)

    expect(readObjectById(doc, first)?.w).toBeCloseTo(860, 5)
    expect(readObjectById(doc, second)?.w).toBeCloseTo(860, 5)
    // Page two's row is still on page two, at its own left edge.
    expect(readObjectById(doc, second)?.x).toBeCloseTo(2760, 5)
  })
})
