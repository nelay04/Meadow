/**
 * Tests for the canvas maths.
 *
 * These are the parts where a wrong sign or a swapped axis produces something that
 * still renders and still feels roughly right, which is exactly the kind of bug that
 * survives manual testing.
 */

import type { ObjectData } from '@meadow/schema'
import { describe, expect, it } from 'vitest'

import { Camera, MAX_ZOOM, MIN_ZOOM, projectPoint, viewTransform } from './camera'
import { containedBy, hitsObject, pickTop, toLocal, unionBounds } from './hitTest'
import { SNAP_THRESHOLD_PX, snapMove } from './snapping'
import { splitAroundBox } from './renderers/arrowPass'
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

/**
 * ARCHITECTURE 5 calls layer drift the hard part of the DOM overlay, and names the
 * awkward zooms to check. These tests cover the arithmetic; scripts/overlay-smoke.mjs
 * covers what the browser actually paints.
 */
describe('viewTransform', () => {
  const AWKWARD_ZOOMS = [0.33, 0.67, 1, 1.37, 2, 2.5]

  it('agrees with the camera to within half a device pixel', () => {
    for (const zoom of AWKWARD_ZOOMS) {
      for (const dpr of [1, 2]) {
        const camera = new Camera()
        camera.x = 137.5
        camera.y = -42.25
        camera.zoom = zoom

        const transform = viewTransform(camera, dpr)
        for (const world of [
          { x: 0, y: 0 },
          { x: 813.5, y: -211.75 },
          { x: -1e4, y: 1e4 },
        ]) {
          const exact = camera.worldToScreen(world.x, world.y)
          const drawn = projectPoint(transform, world.x, world.y)

          // Input reads the continuous camera and rendering reads the snapped
          // transform. They may differ by the snap, and never by more.
          expect(Math.abs(drawn.x - exact.x)).toBeLessThanOrEqual(0.5 / dpr + 1e-9)
          expect(Math.abs(drawn.y - exact.y)).toBeLessThanOrEqual(0.5 / dpr + 1e-9)
        }
      }
    }
  })

  it('lands the translation on a whole device pixel at every zoom', () => {
    for (const zoom of AWKWARD_ZOOMS) {
      for (const dpr of [1, 1.5, 2, 3]) {
        const camera = new Camera()
        camera.x = 137.5
        camera.y = -42.25
        camera.zoom = zoom

        const { tx, ty } = viewTransform(camera, dpr)
        expect(Math.abs(tx * dpr - Math.round(tx * dpr))).toBeLessThan(1e-9)
        expect(Math.abs(ty * dpr - Math.round(ty * dpr))).toBeLessThan(1e-9)
      }
    }
  })

  it('does not quantise the camera itself, so a sub-pixel pan still accumulates', () => {
    const camera = new Camera()
    camera.zoom = 0.33

    // A trackpad emits fractional deltas. Rounding the camera rather than the render
    // transform would swallow every one of these and the pan would sit still.
    for (let i = 0; i < 20; i += 1) camera.panByScreen(0.4, 0)

    expect(camera.x).toBeCloseTo(-8 / 0.33, 6)
  })

  it('keeps the scale exact, since only the translation can be snapped', () => {
    const camera = new Camera()
    camera.zoom = 1.37
    expect(viewTransform(camera, 2).scale).toBe(1.37)
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

  it('excludes the corners a parallelogram leans away from', () => {
    // 100x100, so the slant is 30: the top edge runs from x=30 to x=100 and the
    // bottom from x=0 to x=70.
    const skewed = object({ type: 'parallelogram', w: 100, h: 100 })
    expect(hitsObject(skewed, { x: 50, y: 50 })).toBe(true)
    // Under the top edge's overhang, and over the bottom edge's.
    expect(hitsObject(skewed, { x: 5, y: 5 })).toBe(false)
    expect(hitsObject(skewed, { x: 95, y: 95 })).toBe(false)
    // The two corners the shape does reach.
    expect(hitsObject(skewed, { x: 95, y: 5 })).toBe(true)
    expect(hitsObject(skewed, { x: 5, y: 95 })).toBe(true)
  })

  it('narrows a triangle towards its apex', () => {
    const triangle = object({ type: 'triangle', w: 100, h: 100 })
    // The apex is centred on the top edge, so the shape is a point up there and the
    // full width along the bottom.
    expect(hitsObject(triangle, { x: 50, y: 5 })).toBe(true)
    expect(hitsObject(triangle, { x: 5, y: 5 })).toBe(false)
    expect(hitsObject(triangle, { x: 5, y: 95 })).toBe(true)
    expect(hitsObject(triangle, { x: 95, y: 95 })).toBe(true)
  })

  it('cuts the top corners off a trapezoid', () => {
    // 100x100, so the inset is 20: the top edge runs from x=20 to x=80.
    const trapezoid = object({ type: 'trapezoid', w: 100, h: 100 })
    expect(hitsObject(trapezoid, { x: 50, y: 50 })).toBe(true)
    expect(hitsObject(trapezoid, { x: 5, y: 2 })).toBe(false)
    expect(hitsObject(trapezoid, { x: 95, y: 2 })).toBe(false)
    // The bottom edge is the full width.
    expect(hitsObject(trapezoid, { x: 2, y: 98 })).toBe(true)
    expect(hitsObject(trapezoid, { x: 98, y: 98 })).toBe(true)
  })

  it('puts a polygon vertex at the top and a flat edge between two others', () => {
    const hexagon = object({ type: 'polygon', w: 100, h: 100, props: { polygonSides: 6 } })
    expect(hitsObject(hexagon, { x: 50, y: 50 })).toBe(true)
    // The vertex at the top is on the outline; the box's corners are well outside it.
    expect(hitsObject(hexagon, { x: 50, y: 1 })).toBe(true)
    expect(hitsObject(hexagon, { x: 2, y: 2 })).toBe(false)
    // A square asked for as a four-sided polygon is a diamond, not a box.
    const square = object({ type: 'polygon', w: 100, h: 100, props: { polygonSides: 4 } })
    expect(hitsObject(square, { x: 50, y: 2 })).toBe(true)
    expect(hitsObject(square, { x: 2, y: 2 })).toBe(false)
  })

  it('keeps a cylinder out of the corners its caps curve away from', () => {
    // 100x200, so each cap is 20 deep and the body runs from y=20 to y=180.
    const cylinder = object({ type: 'cylinder', w: 100, h: 200 })
    expect(hitsObject(cylinder, { x: 50, y: 100 })).toBe(true)
    // The sides of the body are the full width.
    expect(hitsObject(cylinder, { x: 1, y: 100 })).toBe(true)
    // The cap is an ellipse, so its corners are empty and its middle is not.
    expect(hitsObject(cylinder, { x: 50, y: 1 })).toBe(true)
    expect(hitsObject(cylinder, { x: 2, y: 2 })).toBe(false)
    expect(hitsObject(cylinder, { x: 98, y: 198 })).toBe(false)
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

  it('puts the resize handles on the box and the rotate zone outside its corners', () => {
    expect(handleAt(box, { x: 100, y: 50 }, 6, 20)).toBe('se')
    expect(handleAt(box, { x: 50, y: 25 }, 6, 20)).toBeNull()

    // Diagonally outside a corner, past the handle and within reach on both axes.
    expect(handleAt(box, { x: 112, y: 62 }, 6, 20)).toBe('rotate')
    expect(handleAt(box, { x: -12, y: -12 }, 6, 20)).toBe('rotate')

    // Straight out from an edge is not a rotate zone. It is the empty space beside
    // the box, and grabbing there used to be how you started a marquee.
    expect(handleAt(box, { x: 50, y: -14 }, 6, 20)).toBeNull()
    expect(handleAt(box, { x: 114, y: 25 }, 6, 20)).toBeNull()

    // Too far out to be reaching for the corner.
    expect(handleAt(box, { x: 130, y: 80 }, 6, 20)).toBeNull()
  })
})

describe('splitAroundBox', () => {
  const box = { minX: 40, minY: -10, maxX: 60, maxY: 10 }

  it('cuts a two-point segment that crosses the box with both ends outside', () => {
    // The case the first version got wrong: neither vertex is inside, so classifying
    // vertices leaves the line running straight through the caption.
    const pieces = splitAroundBox([0, 0, 100, 0], box)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toEqual([0, 0, 40, 0])
    expect(pieces[1]).toEqual([60, 0, 100, 0])
  })

  it('leaves a segment that misses the box alone', () => {
    expect(splitAroundBox([0, 40, 100, 40], box)).toEqual([[0, 40, 100, 40]])
  })

  it('leaves a segment running parallel just outside the slab alone', () => {
    // `direction === 0` on one axis. Rejecting it needs the origin tested against the
    // slab; a version that only skips the division keeps the segment and cuts it.
    expect(splitAroundBox([0, 11, 100, 11], box)).toEqual([[0, 11, 100, 11]])
  })

  it('drops a segment lying entirely inside', () => {
    expect(splitAroundBox([45, 0, 55, 0], box)).toEqual([])
  })

  it('keeps the tail of a segment that starts inside', () => {
    const pieces = splitAroundBox([50, 0, 100, 0], box)
    expect(pieces).toHaveLength(1)
    expect(pieces[0]).toEqual([60, 0, 100, 0])
  })

  it('cuts a polyline across the segment that happens to cross', () => {
    // Three segments; only the middle one meets the box.
    const pieces = splitAroundBox([0, 0, 20, 0, 80, 0, 100, 0], box)
    expect(pieces).toHaveLength(2)
    expect(pieces[0]).toEqual([0, 0, 20, 0, 40, 0])
    expect(pieces[1]).toEqual([60, 0, 80, 0, 100, 0])
  })
})
