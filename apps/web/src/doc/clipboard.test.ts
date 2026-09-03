/**
 * Tests for copy and paste.
 *
 * Three things break silently here and none of them is caught by the type system: a
 * paste that reuses ids overwrites the objects it was meant to duplicate, a pasted
 * arrow that keeps its original binding starts following a shape somewhere else on the
 * board, and a payload from an older build - or from a text file somebody happened to
 * have on the clipboard - reaches the document unvalidated.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { decodeSnapshot, encodeSnapshot, snapshotBounds } from './clipboard'
import {
  addObject,
  bindArrow,
  createDocSession,
  endGesture,
  ensureObjectFragment,
  insertSnapshot,
  readObjectById,
  setObjectText,
  snapshotObjects,
} from './mutations'
import { fragmentToPlainText } from './richText'

const session = (role: 'owner' | 'viewer' = 'owner') => createDocSession(new Y.Doc(), role)
const NO_OFFSET = { x: 0, y: 0 }

describe('snapshots', () => {
  it('takes objects in z-order, not in the order they were named', () => {
    const doc = session()
    const back = addObject(doc, { type: 'rect' })
    const front = addObject(doc, { type: 'ellipse' })

    const snapshot = snapshotObjects(doc, [front, back])
    expect(snapshot.objects.map((entry) => entry.object.id)).toEqual([back, front])
  })

  it('carries text along with the object', () => {
    const doc = session()
    const id = addObject(doc, { type: 'sticky' })
    setObjectText(doc, id, 'hello\nthere')

    const pasted = insertSnapshot(doc, snapshotObjects(doc, [id]), NO_OFFSET)
    const fragment = ensureObjectFragment(doc, pasted[0]) as Y.XmlFragment
    expect(fragmentToPlainText(fragment)).toBe('hello\nthere')
  })

  it('keeps marks on the text it copies', () => {
    const doc = session()
    const id = addObject(doc, { type: 'sticky' })
    const fragment = ensureObjectFragment(doc, id) as Y.XmlFragment
    doc.doc.transact(() => {
      const paragraph = new Y.XmlElement('paragraph')
      const text = new Y.XmlText()
      text.insert(0, 'bold', { bold: {} })
      paragraph.insert(0, [text])
      fragment.insert(0, [paragraph])
    })

    const pasted = insertSnapshot(doc, snapshotObjects(doc, [id]), NO_OFFSET)
    const copy = ensureObjectFragment(doc, pasted[0]) as Y.XmlFragment
    const runs = (copy.get(0) as Y.XmlElement).get(0) as Y.XmlText
    expect(runs.toDelta()).toEqual([{ insert: 'bold', attributes: { bold: {} } }])
  })

  it('measures bounds across a box stored backwards', () => {
    const doc = session()
    // An arrow drawn right to left keeps a negative width.
    addObject(doc, { type: 'arrow', x: 100, y: 40, w: -60, h: 20 })
    const bounds = snapshotBounds(snapshotObjects(doc, doc.order.toArray()))

    expect(bounds).toEqual({ x: 40, y: 40, w: 60, h: 20 })
  })
})

describe('pasting', () => {
  it('gives the copies new ids and leaves the originals alone', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect', x: 10, y: 20 })

    const pasted = insertSnapshot(doc, snapshotObjects(doc, [id]), { x: 5, y: 7 })
    expect(pasted).toHaveLength(1)
    expect(pasted[0]).not.toBe(id)
    expect(doc.objects.size).toBe(2)
    expect(readObjectById(doc, id)).toMatchObject({ x: 10, y: 20 })
    expect(readObjectById(doc, pasted[0])).toMatchObject({ x: 15, y: 27 })
  })

  it('stacks the copies on top, in the order they were taken', () => {
    const doc = session()
    const first = addObject(doc, { type: 'rect' })
    const second = addObject(doc, { type: 'rect' })

    const pasted = insertSnapshot(doc, snapshotObjects(doc, [first, second]), NO_OFFSET)
    expect(doc.order.toArray()).toEqual([first, second, ...pasted])
  })

  it('re-points a binding when both ends were copied', () => {
    const doc = session()
    const shape = addObject(doc, { type: 'rect', x: 0, y: 0, w: 100, h: 100 })
    const arrow = addObject(doc, { type: 'arrow', x: 200, y: 200, w: 50, h: 0 })
    bindArrow(doc, { arrowId: arrow, end: 'start', targetId: shape, anchor: { nx: 0.5, ny: 0.5 }, gap: 8 })

    const pasted = insertSnapshot(doc, snapshotObjects(doc, [shape, arrow]), { x: 400, y: 0 })
    const copies = new Set(pasted)

    const bindings = [...doc.bindings.values()].map((map) => ({
      arrowId: String(map.get('arrowId')),
      targetId: map.get('targetId') as string | null,
    }))
    expect(bindings).toHaveLength(2)

    const copied = bindings.find((binding) => copies.has(binding.arrowId))
    expect(copied).toBeDefined()
    // Pointing at the pasted shape, not at the one it was copied from.
    expect(copies.has(copied?.targetId as string)).toBe(true)
    expect(copied?.targetId).not.toBe(shape)
  })

  it('drops a binding whose target was left behind', () => {
    const doc = session()
    const shape = addObject(doc, { type: 'rect', x: 0, y: 0, w: 100, h: 100 })
    const arrow = addObject(doc, { type: 'arrow', x: 200, y: 200, w: 50, h: 0 })
    bindArrow(doc, { arrowId: arrow, end: 'start', targetId: shape, anchor: { nx: 0.5, ny: 0.5 }, gap: 8 })

    const pasted = insertSnapshot(doc, snapshotObjects(doc, [arrow]), NO_OFFSET)
    const bound = [...doc.bindings.values()].map((map) => String(map.get('arrowId')))

    // The original's binding survives; the copy arrives with a free end rather than
    // silently following the original's target.
    expect(bound).toEqual([arrow])
    expect(pasted).toHaveLength(1)
  })

  it('undoes a paste in one step', () => {
    const doc = session()
    const a = addObject(doc, { type: 'rect' })
    const b = addObject(doc, { type: 'rect' })

    // The paste is its own gesture, as it is on a board: the engine commits after
    // each one, and without that the undo manager merges it with the two creations
    // above and takes all four back at once.
    endGesture(doc)
    insertSnapshot(doc, snapshotObjects(doc, [a, b]), { x: 8, y: 8 })
    expect(doc.objects.size).toBe(4)

    doc.undo.undo()
    expect(doc.objects.size).toBe(2)
    expect(doc.order.toArray()).toEqual([a, b])
  })

  it('refuses a paste for a viewer', () => {
    const owner = session()
    const id = addObject(owner, { type: 'rect' })
    const snapshot = snapshotObjects(owner, [id])

    const viewer = session('viewer')
    expect(() => insertSnapshot(viewer, snapshot, NO_OFFSET)).toThrow()
    expect(viewer.objects.size).toBe(0)
  })
})

describe('the clipboard payload', () => {
  it('round-trips through JSON', () => {
    const doc = session()
    const id = addObject(doc, { type: 'sticky', x: 3, y: 4 })
    setObjectText(doc, id, 'note')

    const decoded = decodeSnapshot(encodeSnapshot(snapshotObjects(doc, [id])))
    expect(decoded?.objects[0].object).toMatchObject({ type: 'sticky', x: 3, y: 4 })

    const pasted = insertSnapshot(doc, decoded as NonNullable<typeof decoded>, NO_OFFSET)
    const fragment = ensureObjectFragment(doc, pasted[0]) as Y.XmlFragment
    expect(fragmentToPlainText(fragment)).toBe('note')
  })

  it('rejects anything that is not a payload', () => {
    expect(decodeSnapshot('not json')).toBeNull()
    expect(decodeSnapshot('"a string"')).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ meadow: 999, objects: [] }))).toBeNull()
    expect(decodeSnapshot(JSON.stringify({ meadow: 1, objects: [] }))).toBeNull()
  })

  it('drops an entry the schema refuses rather than the whole paste', () => {
    const doc = session()
    const id = addObject(doc, { type: 'rect' })
    const snapshot = snapshotObjects(doc, [id])
    const payload = JSON.parse(encodeSnapshot(snapshot)) as {
      objects: { object: { type: string } }[]
    }
    payload.objects.push({ object: { type: 'wormhole' } })

    const decoded = decodeSnapshot(JSON.stringify(payload))
    expect(decoded?.objects).toHaveLength(1)
    expect(decoded?.objects[0].object.type).toBe('rect')
  })
})
