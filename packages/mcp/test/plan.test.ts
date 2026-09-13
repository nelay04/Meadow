import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  arrowBindings,
  applyEdits,
  createDocSession,
  readObjectById,
} from '../../../apps/web/src/doc/mutations'
import { PlanError, planCreate, planDiagram, planRemove, planUpdate } from '../src/plan'
import { parseMermaid } from '../src/mermaid'

const fresh = () => createDocSession(new Y.Doc(), 'owner')

function overlapping(boxes: { x: number; y: number; w: number; h: number }[]): boolean {
  return boxes.some((a, i) =>
    boxes.some(
      (b, j) => i < j && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h,
    ),
  )
}

describe('planCreate', () => {
  it('lays out unplaced nodes without overlaps, and keeps placed ones where they were put', async () => {
    const session = fresh()
    const batch = await planCreate(
      session,
      [
        { ref: 'a', label: 'A' },
        { ref: 'b', label: 'B' },
        { ref: 'c', label: 'C' },
        { ref: 'pinned', x: -500, y: -500 },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
      ],
    )
    const { ids } = applyEdits(session, batch)
    const boxes = ['a', 'b', 'c'].map((ref) => readObjectById(session, ids[ref])!)
    expect(overlapping(boxes)).toBe(false)
    // Left to right, in edge order.
    expect(boxes[0].x).toBeLessThan(boxes[1].x)
    expect(boxes[1].x).toBeLessThan(boxes[2].x)
    expect(readObjectById(session, ids.pinned)).toMatchObject({ x: -500, y: -500 })
    expect(arrowBindings(session, ids.edge1)).toMatchObject({
      start: { targetId: ids.a },
      end: { targetId: ids.b },
    })
  })

  it('places a new block beside what is already on the board', async () => {
    const session = fresh()
    applyEdits(session, {
      create: [{ ref: 'old', object: { type: 'rect', x: 0, y: 100, w: 400, h: 300 } }],
    })
    const { ids } = applyEdits(session, await planCreate(session, [{ ref: 'n' }], []))
    const placed = readObjectById(session, ids.n)!
    expect(placed.x).toBeGreaterThanOrEqual(400)
    expect(placed.y).toBe(100)
  })

  it('writes colours, heads and routing', async () => {
    const session = fresh()
    const a = applyEdits(session, { create: [{ ref: 'a', object: { type: 'rect', x: 0, y: 0 } }] })
      .ids.a
    const b = applyEdits(session, {
      create: [{ ref: 'b', object: { type: 'rect', x: 400, y: 0 } }],
    }).ids.b
    const batch = await planCreate(
      session,
      [],
      [{ from: a, to: b, direction: 'both', routing: 'orthogonal', stroke: '#abc' }],
    )
    const { ids } = applyEdits(session, batch)
    expect(readObjectById(session, ids.edge1)!.props).toMatchObject({
      startHead: 'open',
      endHead: 'open',
      routing: 'orthogonal',
      stroke: 0xaabbcc,
    })
  })

  it('refuses bad colours, self-loops and too much at once', async () => {
    const session = fresh()
    await expect(planCreate(session, [{ fill: 'teal' }], [])).rejects.toThrow(PlanError)
    await expect(planCreate(session, [{ ref: 'a' }], [{ from: 'a', to: 'a' }])).rejects.toThrow(
      /itself/,
    )
    await expect(
      planCreate(
        session,
        Array.from({ length: 501 }, () => ({})),
        [],
      ),
    ).rejects.toThrow(/at most/)
  })
})

describe('return edges', () => {
  it('bow away from an edge already joining the same pair the other way', async () => {
    const session = fresh()
    const first = applyEdits(
      session,
      await planCreate(
        session,
        [{ ref: 'a' }, { ref: 'b' }, { ref: 'c' }],
        [{ from: 'a', to: 'b' }],
      ),
    )
    const { ids } = applyEdits(
      session,
      await planCreate(
        session,
        [],
        [
          { from: first.ids.b, to: first.ids.a },
          { from: first.ids.b, to: first.ids.c },
        ],
      ),
    )
    expect(readObjectById(session, ids.edge1)!.props).toMatchObject({
      routing: 'curved',
      curvature: 0.45,
    })
    // A pair with nothing between it yet is not a return, so it keeps the default.
    expect(readObjectById(session, ids.edge2)!.props.routing).toBe('straight')
  })
})

describe('planUpdate and planRemove', () => {
  it('names an id that is not there', () => {
    const session = fresh()
    expect(() => planUpdate(session, [{ id: 'nope', x: 1 }])).toThrow(/no object/)
    expect(() => planRemove(session, ['nope'])).toThrow(/no object/)
  })

  it('refuses to resize an arrow', async () => {
    const session = fresh()
    const { ids } = applyEdits(session, { create: [{ ref: 'e', object: { type: 'arrow' } }] })
    expect(() => planUpdate(session, [{ id: ids.e, w: 10 }])).toThrow(/arrow/)
  })
})

describe('planDiagram', () => {
  it('matches existing nodes by label and does not draw an edge twice', async () => {
    const session = fresh()
    const first = await planDiagram(
      session,
      parseMermaid('flowchart LR\n cart[Cart] -->|pay| paid{Paid?}'),
    )
    const created = applyEdits(session, first.batch)
    expect(Object.keys(first.matched)).toEqual([])

    const second = await planDiagram(
      session,
      parseMermaid('flowchart LR\n c[cart] -->|pay now| p[Paid?]\n p --> done((Done))'),
    )
    expect(second.matched).toEqual({ c: created.ids.cart, p: created.ids.paid })
    expect(second.existingEdges).toEqual([created.ids.edge1])
    applyEdits(session, second.batch)

    const types = [...session.objects.values()].map((map) => map.get('type'))
    expect(types.filter((type) => type === 'arrow')).toHaveLength(2)
    expect(types.filter((type) => type !== 'arrow')).toHaveLength(3)
  })

  it('refuses an ambiguous label by creating rather than guessing', async () => {
    const session = fresh()
    const twice = await planDiagram(session, {
      nodes: [
        { key: 'a', label: 'Same' },
        { key: 'b', label: 'Same' },
      ],
      edges: [],
    })
    applyEdits(session, twice.batch)
    const again = await planDiagram(session, { nodes: [{ key: 'x', label: 'Same' }], edges: [] })
    expect(again.matched).toEqual({})
  })
})
