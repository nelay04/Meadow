/**
 * Tests for the glade interchange format.
 *
 * The one promise the format makes is that nothing is lost, so the central test is the
 * strongest form of it: build a board with every kind of thing on it, export, import into
 * an empty document, export again, and the two files are equal. Everything else here is
 * about what happens to a file this app did not write.
 */

import {
  GLADE_FORMAT,
  GLADE_MAX_OBJECTS,
  GLADE_VERSION,
  OBJECT_TYPES,
  type GladeFile,
  gladeReportIsClean,
  parseGladeFile,
} from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { exportGlade, gladeFilename, gladeToSnapshot, serialiseGlade } from './interchange'
import {
  ImportTargetError,
  addObject,
  addPage,
  bindArrow,
  createDocSession,
  ensureObjectFragment,
  importGlade,
  insertSnapshot,
  readObjectById,
  removePage,
  setArrowRouting,
  setLeaPaper,
  setObjectText,
  setPageSubject,
} from './mutations'
import { fragmentToPlainText } from './richText'

const session = (role: 'owner' | 'viewer' = 'owner') => createDocSession(new Y.Doc(), role)
const BOARD = { title: 'Order flow', kind: 'lea' }
const NOW = new Date('2026-09-13T10:00:00.000Z')
const options = { app: 'test', now: NOW }

/** A board with at least one of everything the format has to carry. */
function everything() {
  const doc = session()

  for (const type of OBJECT_TYPES) {
    addObject(doc, { type, x: 10, y: 20, props: { fill: 0x123456, futureKey: { nested: [1, 2] } } })
  }

  const source = addObject(doc, { type: 'rect', x: 0, y: 0, w: 100, h: 60, rotation: 0.4 })
  const target = addObject(doc, { type: 'ellipse', x: 400, y: 0, w: 80, h: 80, opacity: 0.5 })
  const frame = addObject(doc, { type: 'frame', x: -50, y: -50, w: 700, h: 300, locked: true })
  addObject(doc, { type: 'sticky', x: 20, y: 200, parentId: frame, createdBy: 'someone' })

  // A right-to-left arrow stores a negative width.
  const routings = ['straight', 'curved', 'orthogonal'] as const
  for (const routing of routings) {
    const arrow = addObject(doc, {
      type: 'arrow',
      x: 480,
      y: 40,
      w: -380,
      h: 10,
      props: { points: [0, 0, -380, 10], startHead: 'dot', endHead: 'triangle' },
    })
    setArrowRouting(doc, arrow, { routing })
    bindArrow(doc, { arrowId: arrow, end: 'start', targetId: target, anchor: { nx: 0, ny: 0.5 }, gap: 6 })
    bindArrow(doc, { arrowId: arrow, end: 'end', targetId: source, anchor: { nx: 1, ny: 0.25 }, gap: 2 })
    setObjectText(doc, arrow, `then ${routing}`)
  }

  // One arrow with a loose end.
  const loose = addObject(doc, { type: 'line', x: 0, y: 500, w: 200, h: 0, props: { points: [0, 0, 200, 0] } })
  bindArrow(doc, { arrowId: loose, end: 'start', targetId: null, anchor: { nx: 0.5, ny: 0.5 }, gap: 4 })

  addObject(doc, {
    type: 'freedraw',
    x: 5,
    y: 5,
    w: 30,
    h: 30,
    props: { points: [0, 0, 0.5, 10, 12, 0.8, 30, 30, 0.2], tip: 'chisel', size: 4, angle: 0.3 },
  })

  // Rich text with every mark, a heading with an attribute, and two paragraphs.
  const rich = addObject(doc, { type: 'text', x: 0, y: 700 })
  const fragment = ensureObjectFragment(doc, rich) as Y.XmlFragment
  doc.doc.transact(() => {
    const heading = new Y.XmlElement('heading')
    heading.setAttribute('level', '2')
    const title = new Y.XmlText()
    title.insert(0, 'Checkout')
    heading.insert(0, [title])

    const paragraph = new Y.XmlElement('paragraph')
    const body = new Y.XmlText()
    body.insert(0, 'plain ')
    body.insert(6, 'bold', { bold: {} })
    body.insert(10, 'italic', { italic: {} })
    body.insert(16, 'under', { underline: {} })
    body.insert(21, 'struck', { strike: {}, bold: {} })
    paragraph.insert(0, [body])

    fragment.insert(0, [heading, paragraph, new Y.XmlElement('paragraph')])
  })

  // A shape with a fragment that is empty, beside shapes that have none at all.
  ensureObjectFragment(doc, source)

  // A lea's pages, one of them torn out, and its paper.
  addPage(doc, 30)
  addPage(doc, 30)
  addPage(doc, 30)
  setPageSubject(doc, 0, 'Monday', 30)
  removePage(doc, 2)
  setLeaPaper(doc, 'cream')

  return doc
}

function roundTrip(file: GladeFile): GladeFile {
  const parsed = parseGladeFile(serialiseGlade(file))
  if (!parsed.ok) throw new Error(parsed.error)
  expect(gladeReportIsClean(parsed.report)).toBe(true)
  const fresh = session()
  importGlade(fresh, parsed.file)
  return exportGlade(fresh, parsed.file.board, options)
}

describe('the round trip', () => {
  it('starts from a board that really has everything on it', () => {
    // Guards the tests below. A round trip of a board with nothing on it passes trivially.
    const file = exportGlade(everything(), BOARD, options)
    const types = new Set(file.objects.map((object) => object.type))
    expect(types.size).toBe(OBJECT_TYPES.length)
    expect(file.bindings.filter((binding) => binding.targetId !== null)).toHaveLength(6)
    expect(file.bindings.filter((binding) => binding.targetId === null)).toHaveLength(1)
    expect(file.objects.some((object) => object.parentId !== null)).toBe(true)
    expect(JSON.stringify(file.objects)).toContain('"strike"')
    expect(JSON.stringify(file.objects)).toContain('"orthogonal"')

    const pages = file.meta.pages as { $y: 'array'; value: { $y: 'map'; value: Record<string, unknown> }[] }
    expect(pages.$y).toBe('array')
    expect(pages.value).toHaveLength(4)
    expect(pages.value.some((page) => typeof page.value.deletedAt === 'number')).toBe(true)
    expect(file.meta.pagePaper).toBe('cream')
  })

  it('exports, imports and exports again to the same file', () => {
    const first = exportGlade(everything(), BOARD, options)
    const second = roundTrip(first)

    expect(second).toEqual(first)
    // Byte for byte, not just structurally: key order is part of a file a person diffs.
    expect(serialiseGlade(second)).toBe(serialiseGlade(first))
  })

  it('survives more than one pass', () => {
    const first = exportGlade(everything(), BOARD, options)
    expect(roundTrip(roundTrip(roundTrip(first)))).toEqual(first)
  })

  it('reproduces the document, not only the file', () => {
    const original = everything()
    const parsed = parseGladeFile(serialiseGlade(exportGlade(original, BOARD, options)))
    if (!parsed.ok) throw new Error(parsed.error)
    const copy = session()
    importGlade(copy, parsed.file)

    expect(copy.order.toArray()).toEqual(original.order.toArray())
    for (const id of original.objects.keys()) {
      expect(readObjectById(copy, id)).toEqual(readObjectById(original, id))
    }
    expect(copy.meta.toJSON()).toEqual(original.meta.toJSON())
    expect(copy.bindings.toJSON()).toEqual(original.bindings.toJSON())
  })

  it('keeps an object with no text apart from one with empty text', () => {
    const doc = session()
    const bare = addObject(doc, { type: 'rect' })
    doc.objects.get(bare)?.delete('text')
    const empty = addObject(doc, { type: 'rect' })

    const file = roundTrip(exportGlade(doc, BOARD, options))
    expect(file.objects.find((object) => object.id === bare)?.text).toBeNull()
    expect(file.objects.find((object) => object.id === empty)?.text).toEqual([])
  })

  it('carries props this build does not know about', () => {
    const file = roundTrip(exportGlade(everything(), BOARD, options))
    expect(file.objects[0].props.futureKey).toEqual({ nested: [1, 2] })
  })

  it('does not put the import on the undo stack', () => {
    const file = exportGlade(everything(), BOARD, options)
    const fresh = session()
    importGlade(fresh, file)
    expect(fresh.undo.canUndo()).toBe(false)
  })

  it('arrives at a peer in one update', () => {
    const file = exportGlade(everything(), BOARD, options)
    const fresh = session()
    let updates = 0
    fresh.doc.on('update', () => updates++)
    importGlade(fresh, file)
    expect(updates).toBe(1)
  })
})

describe('what an import refuses', () => {
  it('refuses a document that already has objects', () => {
    const file = exportGlade(everything(), BOARD, options)
    const busy = session()
    addObject(busy, { type: 'rect' })
    expect(() => importGlade(busy, file)).toThrow(ImportTargetError)
  })

  it('refuses a viewer', () => {
    const file = exportGlade(everything(), BOARD, options)
    expect(() => importGlade(session('viewer'), file)).toThrow()
  })

  it('refuses what is not a glade', () => {
    expect(parseGladeFile('not json').ok).toBe(false)
    expect(parseGladeFile('[]').ok).toBe(false)
    expect(parseGladeFile({ format: 'something.else', version: 1 }).ok).toBe(false)
  })

  it('refuses a version it does not know, and says which', () => {
    const parsed = parseGladeFile({ format: GLADE_FORMAT, version: GLADE_VERSION + 1 })
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error).toContain(String(GLADE_VERSION + 1))
  })

  it('refuses more objects than the limit', () => {
    const objects = Array.from({ length: GLADE_MAX_OBJECTS + 1 }, () => ({}))
    expect(parseGladeFile({ format: GLADE_FORMAT, version: GLADE_VERSION, objects }).ok).toBe(false)
  })
})

describe('a file somebody else wrote', () => {
  const base = { format: GLADE_FORMAT, version: GLADE_VERSION }

  it('drops malformed entries and counts them', () => {
    const parsed = parseGladeFile({
      ...base,
      objects: [
        { id: 'a', type: 'rect', x: 0, y: 0, w: 10, h: 10 },
        { id: 'b', type: 'not-a-type', x: 0, y: 0, w: 10, h: 10 },
        { id: 'a', type: 'ellipse', x: 0, y: 0, w: 10, h: 10 },
        'nonsense',
      ],
      bindings: [
        { id: 'k', arrowId: 'missing', end: 'start' },
        { id: 'l', arrowId: 'a', end: 'sideways' },
      ],
      meta: { good: 'cream', bad: { $y: 'map', value: 'not a record' } },
    })
    if (!parsed.ok) throw new Error(parsed.error)

    expect(parsed.file.objects.map((object) => [object.id, object.type])).toEqual([['a', 'rect']])
    expect(parsed.report.droppedObjects).toBe(3)
    expect(parsed.report.droppedBindings).toBe(2)
    expect(parsed.report.droppedMeta).toBe(1)
    expect(parsed.file.meta).toEqual({ good: 'cream' })
  })

  it('fills in defaults, so a minimal hand-written file imports', () => {
    const parsed = parseGladeFile({
      ...base,
      objects: [
        { id: 'box', type: 'rect', x: 0, y: 0, w: 120, h: 80, text: [{ name: 'paragraph', children: [{ text: [{ insert: 'Start' }] }] }] },
        { id: 'next', type: 'diamond', x: 300, y: 0, w: 120, h: 80 },
        { id: 'go', type: 'arrow', x: 120, y: 40, w: 180, h: 0, props: { points: [0, 0, 180, 0] } },
      ],
      bindings: [
        { id: 'b1', arrowId: 'go', end: 'start', targetId: 'box' },
        { id: 'b2', arrowId: 'go', end: 'end', targetId: 'next' },
      ],
    })
    if (!parsed.ok) throw new Error(parsed.error)

    const doc = session()
    importGlade(doc, parsed.file)
    expect(doc.order.toArray()).toEqual(['box', 'next', 'go'])
    expect(fragmentToPlainText(ensureObjectFragment(doc, 'box') as Y.XmlFragment)).toBe('Start')
    expect(readObjectById(doc, 'next')?.opacity).toBe(1)
    expect(doc.bindings.size).toBe(2)
  })

  it('frees a binding whose target was dropped, rather than dropping the arrow', () => {
    const parsed = parseGladeFile({
      ...base,
      objects: [{ id: 'go', type: 'arrow', x: 0, y: 0, w: 10, h: 0 }],
      bindings: [{ id: 'b', arrowId: 'go', end: 'end', targetId: 'gone' }],
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.bindings[0].targetId).toBeNull()
    expect(parsed.report.freedBindings).toBe(1)
  })

  it('repairs an order that lists too much or too little', () => {
    const parsed = parseGladeFile({
      ...base,
      objects: [
        { id: 'a', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
        { id: 'b', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
        { id: 'c', type: 'rect', x: 0, y: 0, w: 1, h: 1 },
      ],
      order: ['b', 'ghost', 'b', 'a'],
    })
    if (!parsed.ok) throw new Error(parsed.error)
    expect(parsed.file.order).toEqual(['b', 'a', 'c'])
    expect(parsed.report.repairedOrder).toBe(3)
  })
})

describe('dropping a file into a glade that has things in it', () => {
  it('remaps ids and keeps arrows bound to their copies', () => {
    const file = exportGlade(everything(), BOARD, options)
    const busy = session()
    const existing = addObject(busy, { type: 'rect' })

    const created = insertSnapshot(busy, gladeToSnapshot(file), { x: 0, y: 0 })
    expect(created).toHaveLength(file.objects.length)
    expect(created).not.toContain(existing)
    const known = new Set([existing, ...created])
    for (const map of busy.bindings.values()) {
      const targetId = map.get('targetId') as string | null
      if (targetId !== null) expect(known.has(targetId)).toBe(true)
    }
  })
})

describe('filenames', () => {
  it('keeps what a filesystem accepts and replaces what it does not', () => {
    expect(gladeFilename('Q3 plan: a/b test')).toBe('Q3 plan a b test.meadow.json')
    expect(gladeFilename('re-org')).toBe('re-org.meadow.json')
    expect(gladeFilename('   ')).toBe('glade.meadow.json')
  })
})
