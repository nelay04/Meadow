/**
 * Arrows, bindings, and the solver that keeps them attached. ARCHITECTURE 4.
 *
 * The behaviour under test is the one users notice immediately and cannot work around:
 * an arrow that comes unstuck from its shape. Everything here is about the endpoint
 * being *derived* rather than stored, so most of it is geometry plus a few document
 * cases where the derivation has to survive a delete or an undo.
 */

import {
  type ObjectData,
  absolutePoints,
  arrowGeometry,
  resolveArrowProps,
  resolveBoundPoint,
  routeOrthogonal,
  solveArrowEnds,
} from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { hitsObject } from '../canvas/hitTest'
import {
  type DocSession,
  addObject,
  arrowBindings,
  bindArrow,
  createDocSession,
  deleteObjects,
  readObjectById,
  setArrowPoints,
  updateObject,
} from './mutations'

function session(): DocSession {
  return createDocSession(new Y.Doc(), 'owner')
}

function object(overrides: Partial<ObjectData> = {}): ObjectData {
  return {
    id: 'a',
    type: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    opacity: 1,
    locked: false,
    parentId: null,
    createdBy: '',
    props: {},
    ...overrides,
  }
}

/** Absolute world points of an arrow in a session. */
function points(doc: DocSession, id: string): number[] {
  const arrow = readObjectById(doc, id)
  if (arrow === undefined) throw new Error(`no arrow ${id}`)
  return absolutePoints(arrow, resolveArrowProps(arrow))
}

const CENTRE = { nx: 0.5, ny: 0.5 }

describe('arrowGeometry', () => {
  it('keeps bounds and relative points in step', () => {
    const geometry = arrowGeometry([100, 50, 300, 250])

    expect(geometry).toMatchObject({ x: 100, y: 50, w: 200, h: 200 })
    expect(geometry.points).toEqual([0, 0, 200, 200])
  })

  it('handles an arrow drawn right to left', () => {
    const geometry = arrowGeometry([300, 250, 100, 50])

    // The origin is the top-left of the bounds whichever way it was drawn, or the
    // bounding box would be negative and the R-tree would reject it.
    expect(geometry).toMatchObject({ x: 100, y: 50, w: 200, h: 200 })
    expect(geometry.points).toEqual([200, 200, 0, 0])
  })

  it('gives a degenerate arrow a non-zero box', () => {
    const geometry = arrowGeometry([40, 40, 40, 40])

    // A zero-area entry is never returned by an R-tree intersection query, so a
    // zero-length arrow would be invisible to selection and impossible to delete.
    expect(geometry.w).toBeGreaterThan(0)
    expect(geometry.h).toBeGreaterThan(0)
  })
})

describe('resolveBoundPoint', () => {
  it('stops at the edge of a rectangle, not at its centre', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100 })
    const point = resolveBoundPoint(target, { anchor: CENTRE, gap: 0 }, { x: 500, y: 50 })

    expect(point.x).toBeCloseTo(100, 6)
    expect(point.y).toBeCloseTo(50, 6)
  })

  it('applies the gap outside the edge', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100 })
    const point = resolveBoundPoint(target, { anchor: CENTRE, gap: 8 }, { x: 500, y: 50 })

    expect(point.x).toBeCloseTo(108, 6)
  })

  it('stops on an ellipse rather than on its bounding box', () => {
    const target = object({ type: 'ellipse', x: 0, y: 0, w: 100, h: 100 })
    // Approaching from the diagonal. The box corner is at 100,100; the circle is not.
    const point = resolveBoundPoint(target, { anchor: CENTRE, gap: 0 }, { x: 500, y: 500 })

    const radius = Math.hypot(point.x - 50, point.y - 50)
    expect(radius).toBeCloseTo(50, 6)
    expect(point.x).toBeLessThan(100)
  })

  it('stops on a diamond rather than on its bounding box', () => {
    const target = object({ type: 'diamond', x: 0, y: 0, w: 100, h: 100 })
    const point = resolveBoundPoint(target, { anchor: CENTRE, gap: 0 }, { x: 500, y: 500 })

    // On a diamond, |dx|/halfW + |dy|/halfH = 1, so the diagonal exit is at 25,25 out.
    expect(point.x).toBeCloseTo(75, 6)
    expect(point.y).toBeCloseTo(75, 6)
  })

  it('follows the direction of approach', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100 })
    const fromLeft = resolveBoundPoint(target, { anchor: CENTRE, gap: 0 }, { x: -500, y: 50 })
    const fromAbove = resolveBoundPoint(target, { anchor: CENTRE, gap: 0 }, { x: 50, y: -500 })

    expect(fromLeft).toMatchObject({ x: 0 })
    expect(fromAbove).toMatchObject({ y: 0 })
  })

  it('honours an explicit anchor instead of aiming at the centre', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100 })
    // Top-right corner, approached from the far left. A centre anchor would exit on
    // the left edge; an explicit one must not move.
    const point = resolveBoundPoint(
      target,
      { anchor: { nx: 1, ny: 0 }, gap: 0 },
      { x: -500, y: 50 },
    )

    expect(point.x).toBeCloseTo(100, 6)
    expect(point.y).toBeCloseTo(0, 6)
  })

  it('rotates with its target', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 2 })
    // A square rotated a quarter turn is the same square, so the exit point on the
    // approach axis is unchanged. This catches a sign error in the rotation.
    const point = resolveBoundPoint(target, { anchor: CENTRE, gap: 0 }, { x: 500, y: 50 })

    expect(point.x).toBeCloseTo(100, 6)
    expect(point.y).toBeCloseTo(50, 6)
  })

  it('rotates an explicit anchor with its target', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100, rotation: Math.PI / 2 })
    // The top-left corner of a square turned a quarter turn clockwise ends up top-right.
    const point = resolveBoundPoint(target, { anchor: { nx: 0, ny: 0 }, gap: 0 }, { x: 0, y: 0 })

    expect(point.x).toBeCloseTo(100, 6)
    expect(point.y).toBeCloseTo(0, 6)
  })
})

describe('solveArrowEnds', () => {
  it('leaves a free end exactly where it was', () => {
    const target = object({ x: 0, y: 0, w: 100, h: 100 })
    const solved = solveArrowEnds([400, 50, 900, 50], target, { anchor: CENTRE, gap: 0 }, null, null)

    expect(solved[0]).toBeCloseTo(100, 6)
    expect(solved[2]).toBe(900)
    expect(solved[3]).toBe(50)
  })

  it('does not depend on which end is solved first', () => {
    const left = object({ id: 'l', x: 0, y: 0, w: 100, h: 100 })
    const right = object({ id: 'r', x: 400, y: 0, w: 100, h: 100 })
    const binding = { anchor: CENTRE, gap: 0 }

    const solved = solveArrowEnds([50, 50, 450, 50], left, binding, right, binding)

    expect(solved[0]).toBeCloseTo(100, 6)
    expect(solved[2]).toBeCloseTo(400, 6)
  })
})

describe('routeOrthogonal', () => {
  it('turns once at the midpoint of the dominant axis', () => {
    expect(routeOrthogonal({ x: 0, y: 0 }, { x: 100, y: 40 })).toEqual([0, 0, 50, 0, 50, 40, 100, 40])
  })

  it('leads with the vertical when the drop is larger', () => {
    expect(routeOrthogonal({ x: 0, y: 0 }, { x: 40, y: 100 })).toEqual([0, 0, 0, 50, 40, 50, 40, 100])
  })

  it('stays a straight line when it is already axis-aligned', () => {
    // A dogleg here would be a kink in something that should just be a line.
    expect(routeOrthogonal({ x: 0, y: 0 }, { x: 100, y: 0 })).toEqual([0, 0, 100, 0])
  })
})

describe('hit-testing an arrow', () => {
  const arrow = object({
    type: 'arrow',
    x: 0,
    y: 0,
    w: 200,
    h: 200,
    props: { points: [0, 0, 200, 200], strokeWidth: 2 },
  })

  it('hits near the line', () => {
    expect(hitsObject(arrow, { x: 100, y: 100 }, 4)).toBe(true)
  })

  it('misses inside the bounding box but far from the line', () => {
    // The corner of the box a diagonal arrow spans. Testing bounds instead of the path
    // would make a long arrow selectable across a large empty rectangle.
    expect(hitsObject(arrow, { x: 195, y: 5 }, 4)).toBe(false)
  })

  it('misses past the end of the segment', () => {
    const flat = object({
      type: 'arrow',
      x: 0,
      y: 0,
      w: 100,
      h: 1,
      props: { points: [0, 0, 100, 0] },
    })
    // On the infinite line, well past the tip. The projection has to be clamped.
    expect(hitsObject(flat, { x: 400, y: 0 }, 4)).toBe(false)
  })
})

describe('bindings in the document', () => {
  function scene() {
    const doc = session()
    const boxId = addObject(doc, { type: 'rect', x: 0, y: 0, w: 100, h: 100 })
    const geometry = arrowGeometry([50, 50, 500, 50])
    const arrowId = addObject(doc, {
      type: 'arrow',
      x: geometry.x,
      y: geometry.y,
      w: geometry.w,
      h: geometry.h,
      props: { points: geometry.points },
    })
    bindArrow(doc, { arrowId, end: 'start', targetId: boxId, anchor: CENTRE, gap: 0 })
    return { doc, boxId, arrowId }
  }

  it('solves the endpoint as soon as the binding is made', () => {
    const { doc, arrowId } = scene()
    expect(points(doc, arrowId)[0]).toBeCloseTo(100, 6)
  })

  it('follows the target when it moves', () => {
    const { doc, boxId, arrowId } = scene()
    updateObject(doc, boxId, { x: 200 })

    // The box now spans 200..300, and the arrow comes from the right, so the endpoint
    // is on its right edge.
    expect(points(doc, arrowId)[0]).toBeCloseTo(300, 6)
  })

  it('follows the target when it is resized', () => {
    const { doc, boxId, arrowId } = scene()
    updateObject(doc, boxId, { w: 300 })

    expect(points(doc, arrowId)[0]).toBeCloseTo(300, 6)
  })

  it('keeps the arrow bounds in step with its solved points', () => {
    const { doc, boxId, arrowId } = scene()
    updateObject(doc, boxId, { x: 200 })

    const arrow = readObjectById(doc, arrowId)
    const solved = points(doc, arrowId)
    expect(arrow?.x).toBeCloseTo(Math.min(solved[0], solved[2]), 6)
    expect(arrow?.w).toBeCloseTo(Math.abs(solved[2] - solved[0]), 6)
  })

  it('snaps a bound end back when the arrow body is dragged', () => {
    const { doc, arrowId } = scene()
    const before = points(doc, arrowId)

    // Drag the whole arrow down. The free end goes with it; the bound end cannot
    // leave the box.
    const arrow = readObjectById(doc, arrowId)
    updateObject(doc, arrowId, { y: (arrow?.y ?? 0) + 100 })

    const after = points(doc, arrowId)

    // The free end moves the full distance.
    expect(after[3]).toBeCloseTo(before[3] + 100, 6)

    // The bound end stays pinned to the box's right edge. It does *not* stay at the
    // same y: a centre anchor aims at the centre, so when the far end drops the exit
    // point slides down the edge to keep pointing at it. That is the feature, not
    // drift, and it is why this asserts the boundary rather than the coordinate.
    expect(after[0]).toBeCloseTo(100, 6)
    expect(after[1]).toBeGreaterThan(before[1])
    expect(after[1]).toBeLessThanOrEqual(100)
  })

  it('survives its target being deleted, as a loose end', () => {
    const { doc, boxId, arrowId } = scene()
    const before = points(doc, arrowId)

    deleteObjects(doc, [boxId])

    // ARCHITECTURE 4: the arrow stays, the binding goes free, and the endpoint does
    // not jump. It keeps pointing at the space the shape used to occupy.
    expect(readObjectById(doc, arrowId)).toBeDefined()
    expect(arrowBindings(doc, arrowId).start?.targetId).toBeNull()
    expect(points(doc, arrowId)).toEqual(before)
  })

  it('stops following a target it is no longer bound to', () => {
    const { doc, boxId, arrowId } = scene()
    deleteObjects(doc, [boxId])

    const stranded = points(doc, arrowId)
    const other = addObject(doc, { type: 'rect', x: 700, y: 700, w: 50, h: 50 })
    updateObject(doc, other, { x: 800 })

    expect(points(doc, arrowId)).toEqual(stranded)
  })

  it('drops bindings belonging to a deleted arrow', () => {
    const { doc, arrowId } = scene()
    deleteObjects(doc, [arrowId])

    expect(doc.bindings.size).toBe(0)
  })

  it('replaces rather than stacks a second binding on the same end', () => {
    const { doc, arrowId } = scene()
    const other = addObject(doc, { type: 'rect', x: 300, y: 0, w: 100, h: 100 })

    bindArrow(doc, { arrowId, end: 'start', targetId: other, anchor: CENTRE, gap: 0 })

    // Two bindings on one end would both solve, and whichever ran last would win
    // silently.
    expect(doc.bindings.size).toBe(1)
    expect(arrowBindings(doc, arrowId).start?.targetId).toBe(other)
  })

  it('puts the arrow and its target back together on undo', () => {
    const { doc, boxId, arrowId } = scene()
    const before = points(doc, arrowId)

    doc.undo.stopCapturing()
    updateObject(doc, boxId, { x: 400 })
    expect(points(doc, arrowId)[0]).not.toBeCloseTo(before[0], 6)

    doc.undo.undo()

    // The solved points landed in the same transaction as the move, so one undo step
    // reverts both. If they were separate transactions this would leave the arrow
    // attached to where the box no longer is.
    expect(points(doc, arrowId)[0]).toBeCloseTo(before[0], 6)
  })

  it('refuses to bind for a read-only role', () => {
    const viewer = createDocSession(new Y.Doc(), 'viewer')
    expect(() => bindArrow(viewer, { arrowId: 'a', end: 'start', targetId: 'b', anchor: CENTRE, gap: 4 })).toThrow()
  })

  it('leaves an unbound arrow alone when other objects move', () => {
    const doc = session()
    const geometry = arrowGeometry([0, 0, 100, 100])
    const arrowId = addObject(doc, {
      type: 'arrow',
      x: geometry.x,
      y: geometry.y,
      w: geometry.w,
      h: geometry.h,
      props: { points: geometry.points },
    })
    const boxId = addObject(doc, { type: 'rect', x: 300, y: 300, w: 50, h: 50 })

    const before = points(doc, arrowId)
    updateObject(doc, boxId, { x: 900 })

    expect(points(doc, arrowId)).toEqual(before)
  })

  it('moves a free endpoint where it is put', () => {
    const { doc, arrowId } = scene()
    setArrowPoints(doc, arrowId, [50, 50, 700, 300])

    const after = points(doc, arrowId)
    expect(after[2]).toBeCloseTo(700, 6)
    expect(after[3]).toBeCloseTo(300, 6)
  })
})
