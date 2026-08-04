/**
 * Tests for the canvas maths.
 *
 * These are the parts where a wrong sign or a swapped axis produces something that
 * still renders and still feels roughly right, which is exactly the kind of bug that
 * survives manual testing.
 */

import type { ObjectData } from '@meadow/schema'
import { describe, expect, it } from 'vitest'

import { Camera, MAX_ZOOM, MIN_ZOOM } from './camera'
import { containedBy, hitsObject, pickTop, toLocal, unionBounds } from './hitTest'
import { SNAP_THRESHOLD_PX, snapMove } from './snapping'
import { SpatialIndex } from './spatialIndex'
import { applyRectToObject, handleAt, resizeRect, rotateAbout } from './transform'

function object(overrides: Partial<ObjectData> = {}): ObjectData {
  return {
    id: 'a',
    type: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    rotation: 0,
    opacity: 1,
    locked: false,
    parentId: null,
    createdBy: '',
    props: {},
    ...overrides,
  }
}

describe('Camera', () => {
  it('round-trips screen and world coordinates', () => {
    const camera = new Camera()
    camera.x = 137.5
    camera.y = -42.25
    camera.zoom = 1.37

    const world = camera.screenToWorld(311, 209)
    const screen = camera.worldToScreen(world.x, world.y)

    expect(screen.x).toBeCloseTo(311, 6)
    expect(screen.y).toBeCloseTo(209, 6)
  })

  it('keeps the world point under the cursor fixed while zooming', () => {
    const camera = new Camera()
    camera.x = 20
    camera.y = 30

    const anchorScreen = { x: 400, y: 250 }
    const before = camera.screenToWorld(anchorScreen.x, anchorScreen.y)
    camera.zoomBy(anchorScreen.x, anchorScreen.y, 2.5)
    const after = camera.screenToWorld(anchorScreen.x, anchorScreen.y)

    expect(after.x).toBeCloseTo(before.x, 6)
    expect(after.y).toBeCloseTo(before.y, 6)
  })

  it('clamps zoom to the documented range', () => {
    const camera = new Camera()
    camera.zoomAt(0, 0, 500)
    expect(camera.zoom).toBe(MAX_ZOOM)
    camera.zoomAt(0, 0, 0.0001)
    expect(camera.zoom).toBe(MIN_ZOOM)
  })

  it('pans in the direction of the drag, independent of zoom', () => {
    const camera = new Camera()
    camera.zoom = 2
    camera.panByScreen(100, 0)
    // Dragging content right moves the camera left by the same distance in world units.
    expect(camera.x).toBeCloseTo(-50, 6)
  })

  it('reports the visible world rectangle', () => {
    const camera = new Camera()
    camera.x = 10
    camera.y = 20
    camera.zoom = 2
    const rect = camera.visibleWorld(800, 400)
    expect(rect).toEqual({ minX: 10, minY: 20, maxX: 410, maxY: 220 })
  })
})

describe('hit testing', () => {
  it('excludes the corners of an ellipse', () => {
    const ellipse = object({ type: 'ellipse', w: 100, h: 100 })
    expect(hitsObject(ellipse, { x: 50, y: 50 })).toBe(true)
    // Inside the bounding box, outside the ellipse.
    expect(hitsObject(ellipse, { x: 2, y: 2 })).toBe(false)
  })

  it('excludes the corners of a diamond', () => {
    const diamond = object({ type: 'diamond', w: 100, h: 100 })
    expect(hitsObject(diamond, { x: 50, y: 50 })).toBe(true)
    expect(hitsObject(diamond, { x: 5, y: 5 })).toBe(false)
    expect(hitsObject(diamond, { x: 50, y: 2 })).toBe(true)
  })

  it('accounts for rotation', () => {
    const rotated = object({ w: 100, h: 20, rotation: Math.PI / 2 })
    // Rotated a quarter turn, the box is now 20 wide and 100 tall about its centre.
    expect(hitsObject(rotated, { x: 50, y: 60 })).toBe(true)
    expect(hitsObject(rotated, { x: 95, y: 10 })).toBe(false)
  })

  it('maps a world point into unrotated local space', () => {
    const local = toLocal(object({ w: 100, h: 100, rotation: Math.PI / 2 }), { x: 100, y: 50 })
    expect(local.x).toBeCloseTo(0, 6)
    expect(local.y).toBeCloseTo(-50, 6)
  })

  it('picks the topmost object, walking z-order backwards', () => {
    const bottom = object({ id: 'bottom' })
    const top = object({ id: 'top' })
    const lookup = (id: string) => (id === 'bottom' ? bottom : top)

    const hit = pickTop(['bottom', 'top'], new Set(['bottom', 'top']), lookup, { x: 10, y: 10 }, 0)
    expect(hit).toBe('top')
  })

  it('never picks a locked object', () => {
    const locked = object({ id: 'locked', locked: true })
    const hit = pickTop(['locked'], new Set(['locked']), () => locked, { x: 10, y: 10 }, 0)
    expect(hit).toBeNull()
  })

  it('marquee requires containment, not intersection', () => {
    const straddling = object({ x: 90, y: 0, w: 100, h: 50 })
    const rect = { minX: 0, minY: 0, maxX: 150, maxY: 100 }
    expect(containedBy(straddling, rect)).toBe(false)
    expect(containedBy(object({ x: 10, y: 10, w: 50, h: 20 }), rect)).toBe(true)
  })

  it('unions rotated bounds', () => {
    const bounds = unionBounds([object({ w: 100, h: 100, rotation: Math.PI / 4 })])
    expect(bounds).not.toBeNull()
    // A square rotated 45 degrees has a diagonal of 100*sqrt(2).
    expect((bounds?.maxX ?? 0) - (bounds?.minX ?? 0)).toBeCloseTo(Math.SQRT2 * 100, 4)
  })
})

describe('SpatialIndex', () => {
  it('finds objects intersecting a query and drops removed ones', () => {
    const index = new SpatialIndex()
    index.insert('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 })
    index.insert('b', { minX: 100, minY: 100, maxX: 110, maxY: 110 })

    expect(index.search({ minX: -5, minY: -5, maxX: 5, maxY: 5 })).toEqual(['a'])

    index.remove('a')
    expect(index.search({ minX: -5, minY: -5, maxX: 5, maxY: 5 })).toEqual([])
    expect(index.size).toBe(1)
  })

  it('re-inserting an id replaces the old entry rather than duplicating it', () => {
    const index = new SpatialIndex()
    index.insert('a', { minX: 0, minY: 0, maxX: 10, maxY: 10 })
    index.insert('a', { minX: 500, minY: 500, maxX: 510, maxY: 510 })

    // The stale entry would show up here as a phantom hit far from the object.
    expect(index.search({ minX: 0, minY: 0, maxX: 20, maxY: 20 })).toEqual([])
    expect(index.search({ minX: 495, minY: 495, maxX: 515, maxY: 515 })).toEqual(['a'])
    expect(index.size).toBe(1)
  })
})

describe('snapping', () => {
  const target = object({ id: 'target', x: 200, y: 0, w: 100, h: 100 })

  it('snaps a near-aligned edge and reports a guide', () => {
    const moving = { minX: 197, minY: 300, maxX: 297, maxY: 400 }
    const result = snapMove(moving, [target], SNAP_THRESHOLD_PX)

    expect(result.dx).toBeCloseTo(3, 6)
    expect(result.guides.some((guide) => guide.axis === 'x')).toBe(true)
  })

  it('ignores targets beyond the threshold', () => {
    // Every edge and centre of the moving box is more than the threshold from every
    // edge and centre of the target. Note the centres: a box whose midpoint lands on
    // a neighbour's edge does snap, which is the point of tracking centres at all.
    const moving = { minX: 150, minY: 300, maxX: 180, maxY: 400 }
    expect(snapMove(moving, [target], SNAP_THRESHOLD_PX)).toEqual({ dx: 0, dy: 0, guides: [] })
  })

  it('prefers the nearest candidate edge', () => {
    const moving = { minX: 0, minY: 0, maxX: 10, maxY: 10 }
    const far = object({ id: 'far', x: 13, y: 500, w: 1, h: 1 })
    const near = object({ id: 'near', x: 11, y: 500, w: 1, h: 1 })

    // Alone, the far one pulls the right edge from 10 to 13.
    expect(snapMove(moving, [far], SNAP_THRESHOLD_PX).dx).toBeCloseTo(3, 6)
    // With both in range, the nearer one wins regardless of the order they arrive in.
    expect(snapMove(moving, [far, near], SNAP_THRESHOLD_PX).dx).toBeCloseTo(1, 6)
    expect(snapMove(moving, [near, far], SNAP_THRESHOLD_PX).dx).toBeCloseTo(1, 6)
  })

  it('falls back to the grid only when nothing else matches', () => {
    const moving = { minX: 998, minY: 998, maxX: 1048, maxY: 1048 }
    const result = snapMove(moving, [], SNAP_THRESHOLD_PX, 50)
    expect(result.dx).toBeCloseTo(2, 6)
    expect(result.dy).toBeCloseTo(2, 6)
  })
})

describe('transform', () => {
  const box = { minX: 0, minY: 0, maxX: 100, maxY: 50 }

  it('drags the south-east handle and leaves the anchor corner alone', () => {
    const after = resizeRect(box, 'se', { x: 150, y: 80 }, {
      preserveAspect: false,
      fromCenter: false,
    })
    expect(after).toEqual({ minX: 0, minY: 0, maxX: 150, maxY: 80 })
  })

  it('moves only one axis for an edge handle', () => {
    const after = resizeRect(box, 'e', { x: 200, y: 999 }, {
      preserveAspect: false,
      fromCenter: false,
    })
    expect(after.minY).toBe(0)
    expect(after.maxY).toBe(50)
    expect(after.maxX).toBe(200)
  })

  it('preserves aspect ratio with shift', () => {
    const after = resizeRect(box, 'se', { x: 200, y: 60 }, {
      preserveAspect: true,
      fromCenter: false,
    })
    const ratio = (after.maxX - after.minX) / (after.maxY - after.minY)
    expect(ratio).toBeCloseTo(2, 6)
  })

  it('resizes about the centre with alt', () => {
    const after = resizeRect(box, 'se', { x: 100, y: 50 }, {
      preserveAspect: false,
      fromCenter: true,
    })
    expect((after.minX + after.maxX) / 2).toBeCloseTo(50, 6)
    expect((after.minY + after.maxY) / 2).toBeCloseTo(25, 6)
  })

  it('never collapses a shape to zero size', () => {
    const after = resizeRect(box, 'se', { x: 0, y: 0 }, {
      preserveAspect: false,
      fromCenter: false,
    })
    expect(after.maxX - after.minX).toBeGreaterThan(0)
    expect(after.maxY - after.minY).toBeGreaterThan(0)
  })

  it('distributes a box resize proportionally across a multi-selection', () => {
    const member = object({ x: 50, y: 0, w: 50, h: 50 })
    const patch = applyRectToObject(member, box, { minX: 0, minY: 0, maxX: 200, maxY: 50 })
    expect(patch.x).toBeCloseTo(100, 6)
    expect(patch.w).toBeCloseTo(100, 6)
    expect(patch.h).toBeCloseTo(50, 6)
  })

  it('rotates an object about an external point', () => {
    const member = object({ x: 100, y: -25, w: 50, h: 50 })
    const patch = rotateAbout(member, { x: 0, y: 0 }, Math.PI / 2)
    // The centre at (125, 0) swings to (0, 125).
    expect((patch.x ?? 0) + 25).toBeCloseTo(0, 6)
    expect((patch.y ?? 0) + 25).toBeCloseTo(125, 6)
    expect(patch.rotation).toBeCloseTo(Math.PI / 2, 6)
  })

  it('finds the rotate handle above the box and resize handles on it', () => {
    expect(handleAt(box, { x: 50, y: -20 }, 6, 20)).toBe('rotate')
    expect(handleAt(box, { x: 100, y: 50 }, 6, 20)).toBe('se')
    expect(handleAt(box, { x: 50, y: 25 }, 6, 20)).toBeNull()
  })
})
