import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  applyEdits,
  arrowBindings,
  createDocSession,
  readObjectById,
} from '@meadow/document-core'
import { boardNodes, drawnPoints, planCreate, planDiagram } from '../src/plan'
import { segmentHitsRect, segmentsOf } from '../src/route'
import { fitNodeSize } from '../src/sizing'
import { checkLayout, planTidy } from '../src/tidy'

const fresh = () => createDocSession(new Y.Doc(), 'owner')

describe('fitNodeSize', () => {
  it('keeps the minimum for a short label and grows for a long one', () => {
    expect(fitNodeSize('rect', 'Login')).toEqual({ w: 180, h: 80 })
    const long = fitNodeSize('rect', 'Electronic Medical Records\nvisits, diagnoses, prescriptions')
    expect(long.w).toBeGreaterThan(180)
    expect(long.h).toBeGreaterThanOrEqual(80)
  })

  it('gives a diamond room for the half of its box a label can use', () => {
    const rect = fitNodeSize('rect', 'Is the copy available to borrow?')
    const diamond = fitNodeSize('diamond', 'Is the copy available to borrow?')
    expect(diamond.w).toBeGreaterThan(rect.w)
    expect(diamond.h).toBeGreaterThan(rect.h)
  })

  it('grows height for every bullet, and keeps a size that was asked for', () => {
    const three = fitNodeSize('rect', 'Circulation\n- issue\n- return\n- renew')
    expect(three.h).toBeGreaterThan(80)
    expect(fitNodeSize('rect', 'a\nb\nc\nd\ne', { w: 100, h: 40 })).toEqual({ w: 100, h: 40 })
  })

  it('keeps a sticky its width and grows it downward for a long note', () => {
    expect(fitNodeSize('sticky', 'Buy milk')).toEqual({ w: 180, h: 195 })
    const note = Array.from({ length: 20 }, (_, i) => `line ${i + 1} of a long note`).join('\n')
    const long = fitNodeSize('sticky', note)
    expect(long.w).toBe(180)
    expect(long.h).toBeGreaterThan(195)
    expect(fitNodeSize('sticky', note, { w: 300 }).w).toBe(300)
  })
})

describe('routing', () => {
  it('attaches edges leaving one side at different points', async () => {
    const session = fresh()
    const { ids } = applyEdits(
      session,
      await planCreate(
        session,
        [{ ref: 'hub' }, { ref: 'x' }, { ref: 'y' }, { ref: 'z' }],
        [
          { from: 'hub', to: 'x' },
          { from: 'hub', to: 'y' },
          { from: 'hub', to: 'z' },
        ],
      ),
    )
    const anchors = ['edge1', 'edge2', 'edge3'].map(
      (edge) => arrowBindings(session, ids[edge]).start!.anchor,
    )
    expect(new Set(anchors.map((a) => `${a.nx},${a.ny}`)).size).toBe(3)
  })

  it('keeps an edge that skips a column off the shape in between', async () => {
    const session = fresh()
    const plan = await planDiagram(session, {
      direction: 'LR',
      nodes: [{ key: 'a' }, { key: 'b' }, { key: 'c' }],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'a', to: 'c', label: 'shortcut' },
      ],
    })
    const { ids } = applyEdits(session, plan.batch)
    const middle = readObjectById(session, ids.b)!
    const skip = Object.values(ids).find((id) => {
      const ends = arrowBindings(session, id)
      return ends.start?.targetId === ids.a && ends.end?.targetId === ids.c
    })!
    const segments = segmentsOf(drawnPoints(readObjectById(session, skip)!))
    expect(segments.some((s) => segmentHitsRect(s, middle))).toBe(false)
  })
})

describe('checkLayout and planTidy', () => {
  it('finds overflow, overlaps and a line through a shape, and tidy clears them', async () => {
    const session = fresh()
    const { ids } = applyEdits(
      session,
      await planCreate(
        session,
        [
          { ref: 'a', label: 'Start', x: 0, y: 0 },
          { ref: 'm', label: 'In the way', x: 300, y: 0 },
          {
            ref: 'b',
            label: 'A label far too long for a box this small',
            x: 600,
            y: 0,
            w: 120,
            h: 40,
          },
          { ref: 'o', label: 'On top', x: 20, y: 20 },
        ],
        [
          { from: 'a', to: 'b', routing: 'straight' },
          { from: 'a', to: 'm' },
          { from: 'o', to: 'm' },
        ],
      ),
    )
    // Pin the straight edge through the middle shape, as a hand-drawn board would have it.
    applyEdits(session, {
      connect: [
        { arrow: ids.edge1, end: 'start', target: ids.a },
        { arrow: ids.edge1, end: 'end', target: ids.b },
      ],
    })
    const before = checkLayout(session)
    expect(before.counts.text_overflow).toBeGreaterThan(0)
    expect(before.counts.shapes_overlap).toBeGreaterThan(0)
    expect(before.counts.edge_through_shape).toBeGreaterThan(0)

    applyEdits(session, await planTidy(session))
    const after = checkLayout(session)
    expect(after.counts.text_overflow).toBe(0)
    expect(after.counts.shapes_overlap).toBe(0)
    expect(after.counts.edge_through_shape).toBe(0)
    expect(boardNodes(session).size).toBe(4)
  })

  it('reports a sticky its note has outgrown, and tidy makes it taller, not wider', async () => {
    const session = fresh()
    const note = 'one long paragraph that wraps onto many rows at this width '.repeat(6)
    const { ids } = applyEdits(
      session,
      await planCreate(session, [{ ref: 's', type: 'sticky', label: note, x: 0, y: 0, w: 180, h: 195 }], []),
    )
    expect(checkLayout(session).counts.text_overflow).toBe(1)

    applyEdits(session, await planTidy(session, { ids: [ids.s], move: false }))
    const sticky = boardNodes(session).get(ids.s)!
    expect(sticky.w).toBe(180)
    expect(sticky.h).toBeGreaterThan(195)
    expect(sticky.props.baseHeight).toBe(195)
    expect(checkLayout(session).counts.text_overflow).toBe(0)

    // Widened far enough for the paragraph to fit in a few rows, it settles back to the
    // height it was made at and stops carrying the old one.
    applyEdits(session, { update: [{ id: ids.s, patch: { w: 1200 } }] })
    applyEdits(session, await planTidy(session, { ids: [ids.s], move: false }))
    const settled = boardNodes(session).get(ids.s)!
    expect(settled.h).toBe(195)
    expect(settled.props.baseHeight).toBeUndefined()
  })
})
