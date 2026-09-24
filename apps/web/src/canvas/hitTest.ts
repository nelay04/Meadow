/**
 * Hit-testing. ARCHITECTURE 5.
 *
 * Two stages. The R-tree narrows to candidates by bounding box, then each candidate
 * gets a precise per-type test. Bounding boxes alone would let a click near the corner
 * of a rotated diamond select it, which feels wrong immediately.
 *
 * Candidates are tested in reverse z-order and the first hit wins, so the object drawn
 * on top is the object selected.
 */

import {
  FREEDRAW_STRIDE,
  type ObjectData,
  arrowPolyline,
  cylinderCap,
  hitsInk,
  isArrowLike,
  isFreedraw,
  parallelogramSlant,
  polygonSidesOf,
  resolveArrowProps,
  resolveFreedrawProps,
  trapezoidInset,
} from '@meadow/schema'

import type { Point, WorldRect } from './camera'

/** Click tolerance in screen pixels, converted to world units by the caller. */
export const HIT_TOLERANCE_PX = 8

/** Move a world point into an object's unrotated local space, origin at its centre. */
export function toLocal(object: ObjectData, point: Point): Point {
  const centerX = object.x + object.w / 2
  const centerY = object.y + object.h / 2
  const dx = point.x - centerX
  const dy = point.y - centerY

  if (object.rotation === 0) return { x: dx, y: dy }

  // Rotate by -rotation to undo the object's own rotation.
  const cos = Math.cos(-object.rotation)
  const sin = Math.sin(-object.rotation)
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos }
}

/** Distance from a point to a segment, clamped to the segment's ends. */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy

  if (lengthSquared === 0) return Math.hypot(px - ax, py - ay)

  // Clamped projection, so the nearest point is on the segment rather than its
  // infinite line. Without the clamp, a click far past an arrow's tip would hit it.
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/**
 * Is a world point inside this object?
 *
 * `tolerance` is in world units and grows the shape outwards, so thin or small objects
 * stay clickable when zoomed out.
 */
export function hitsObject(object: ObjectData, point: Point, tolerance = 0): boolean {
  // A stroke is a path too, and a far worse fit for its box than an arrow is: the box
  // of a scribble is mostly the paper it was drawn around. Testing it would make a
  // circle drawn with a pen select from the empty space in the middle of it.
  if (isFreedraw(object.type)) {
    const props = resolveFreedrawProps(object)
    // `toLocal` puts the origin at the centre and undoes rotation; the stored samples
    // are measured from the box's corner, so shift back by the half-extent.
    const local = toLocal(object, point)
    return hitsInk(
      props.points,
      props,
      local.x + object.w / 2,
      local.y + object.h / 2,
      tolerance,
    )
  }

  // An arrow is a path, not a box. Testing its bounding box would make a long diagonal
  // arrow select from anywhere in the large empty rectangle it spans.
  if (isArrowLike(object.type)) {
    const props = resolveArrowProps(object)
    // The drawn path, not the stored points. On a curved arrow they are not the same
    // thing: the stored points are the two ends, and testing the chord between them
    // would make the bow itself unclickable while a click on empty space inside the
    // curve selected it.
    const points = arrowPolyline(props.points, props.routing, props.curvature, props.curvatureEnd)
    // Half the stroke, so a thick arrow is clickable across its full painted width.
    const reach = tolerance + props.strokeWidth / 2

    for (let index = 0; index + 3 < points.length; index += 2) {
      const distance = distanceToSegment(
        point.x - object.x,
        point.y - object.y,
        points[index],
        points[index + 1],
        points[index + 2],
        points[index + 3],
      )
      if (distance <= reach) return true
    }
    return false
  }

  const local = toLocal(object, point)
  const halfW = object.w / 2 + tolerance
  const halfH = object.h / 2 + tolerance

  switch (object.type) {
    case 'ellipse': {
      if (halfW <= 0 || halfH <= 0) return false
      const nx = local.x / halfW
      const ny = local.y / halfH
      return nx * nx + ny * ny <= 1
    }
    case 'diamond': {
      if (halfW <= 0 || halfH <= 0) return false
      return Math.abs(local.x) / halfW + Math.abs(local.y) / halfH <= 1
    }
    case 'parallelogram': {
      if (halfW <= 0 || halfH <= 0) return false
      // Undo the shear and the shape is a box again. The slant comes from the real
      // size rather than the tolerance-grown one, so the lean of the target matches
      // the lean that was drawn and the tolerance only widens it.
      const skew = parallelogramSlant(object.w, object.h) / 2
      const sheared = local.x + (skew / halfH) * local.y
      return Math.abs(sheared) <= halfW - skew && Math.abs(local.y) <= halfH
    }
    case 'triangle': {
      if (halfW <= 0 || halfH <= 0) return false
      // Apex at (0, -halfH), base corners at (+-halfW, +halfH). The target's half-width
      // grows linearly from nothing at the apex to the full width at the base, which is
      // the same line the SDF draws.
      if (Math.abs(local.y) > halfH) return false
      const down = (local.y + halfH) / (2 * halfH)
      return Math.abs(local.x) <= halfW * down
    }
    case 'trapezoid': {
      if (halfW <= 0 || halfH <= 0) return false
      // The inset comes from the real size rather than the tolerance-grown one, for the
      // same reason the parallelogram's slant does: the taper of the target has to be
      // the taper that was drawn, and the tolerance only widens it.
      const top = halfW - trapezoidInset(object.w, object.h)
      if (Math.abs(local.y) > halfH) return false
      const down = (local.y + halfH) / (2 * halfH)
      return Math.abs(local.x) <= top + (halfW - top) * down
    }
    case 'polygon': {
      if (halfW <= 0 || halfH <= 0) return false
      // In the box's normalised space the polygon is regular with a circumradius of 1,
      // so a point is inside when its distance along the nearest edge's normal is
      // within the apothem. Same fold the shader does, and the same vertex at the top.
      const nx = local.x / halfW
      const ny = local.y / halfH
      const sides = polygonSidesOf(object.props)
      const sector = (Math.PI * 2) / sides
      const base = -Math.PI / 2 + sector / 2
      const angle = Math.atan2(ny, nx) - base
      const offset = angle - sector * Math.round(angle / sector)
      return Math.hypot(nx, ny) * Math.cos(offset) <= Math.cos(Math.PI / sides)
    }
    case 'cylinder': {
      if (halfW <= 0 || halfH <= 0) return false
      // The union the shader draws: a body between the cap centres, and a cap ellipse
      // at each end. The cap comes from the real height, so the tolerance widens the
      // target rather than reshaping it.
      const cap = Math.max(cylinderCap(object.h), 1e-6)
      const body = Math.max(halfH - cap, 0)
      if (Math.abs(local.x) <= halfW && Math.abs(local.y) <= body) return true
      const ny = (Math.abs(local.y) - body) / cap
      const nx = local.x / halfW
      return nx * nx + ny * ny <= 1
    }
    default:
      return Math.abs(local.x) <= halfW && Math.abs(local.y) <= halfH
  }
}

/** Every corner of an object's rotated box, in world space. */
export function corners(object: ObjectData): Point[] {
  const halfW = object.w / 2
  const halfH = object.h / 2
  const centerX = object.x + halfW
  const centerY = object.y + halfH
  const cos = Math.cos(object.rotation)
  const sin = Math.sin(object.rotation)

  return [
    [-halfW, -halfH],
    [halfW, -halfH],
    [halfW, halfH],
    [-halfW, halfH],
  ].map(([dx, dy]) => ({
    x: centerX + dx * cos - dy * sin,
    y: centerY + dx * sin + dy * cos,
  }))
}

/**
 * Is the object fully inside the rectangle?
 *
 * Marquee selection uses containment rather than intersection: a drag
 * across a crowded board should not sweep up every object it grazes.
 */
export function containedBy(object: ObjectData, rect: WorldRect): boolean {
  return corners(object).every(
    (point) =>
      point.x >= rect.minX &&
      point.x <= rect.maxX &&
      point.y >= rect.minY &&
      point.y <= rect.maxY,
  )
}

/** Points on an ellipse outline. Fine enough that a lasso cannot slip between two. */
const ELLIPSE_SAMPLES = 32

/**
 * An object's drawn outline in world space, flat `[x, y, ...]`.
 *
 * `closed` is false for the two types that are paths rather than regions, an arrow and
 * a stroke, whose last point does not join back to the first.
 *
 * A lasso needs this where a marquee does not. A rectangle drawn round a circle always
 * contains the circle's box as well, so the marquee can test corners. A loop drawn
 * round a circle usually cuts across the corners of its box, and one drawn along a
 * diagonal arrow never gets near two of them, so testing the box would refuse exactly
 * the objects the loop was drawn round.
 */
export function outlineOf(object: ObjectData): { points: number[]; closed: boolean } {
  if (isArrowLike(object.type)) {
    // No rotation: an arrow's points are its geometry, as in `hitsObject`.
    const props = resolveArrowProps(object)
    const path = arrowPolyline(props.points, props.routing, props.curvature, props.curvatureEnd)
    const points: number[] = new Array(path.length)
    for (let index = 0; index + 1 < path.length; index += 2) {
      points[index] = path[index] + object.x
      points[index + 1] = path[index + 1] + object.y
    }
    return { points, closed: false }
  }

  const halfW = object.w / 2
  const halfH = object.h / 2
  // Local points, measured from the centre, before rotation.
  const local: number[] = []

  if (isFreedraw(object.type)) {
    const samples = resolveFreedrawProps(object).points
    for (let index = 0; index + FREEDRAW_STRIDE <= samples.length; index += FREEDRAW_STRIDE) {
      local.push(samples[index] - halfW, samples[index + 1] - halfH)
    }
  } else {
    switch (object.type) {
      case 'ellipse':
        for (let step = 0; step < ELLIPSE_SAMPLES; step += 1) {
          const angle = (step / ELLIPSE_SAMPLES) * Math.PI * 2
          local.push(Math.cos(angle) * halfW, Math.sin(angle) * halfH)
        }
        break
      case 'diamond':
        local.push(0, -halfH, halfW, 0, 0, halfH, -halfW, 0)
        break
      case 'parallelogram': {
        const slant = parallelogramSlant(object.w, object.h)
        local.push(-halfW + slant, -halfH, halfW, -halfH, halfW - slant, halfH, -halfW, halfH)
        break
      }
      case 'triangle':
        local.push(0, -halfH, halfW, halfH, -halfW, halfH)
        break
      case 'trapezoid': {
        const top = halfW - trapezoidInset(object.w, object.h)
        local.push(-top, -halfH, top, -halfH, halfW, halfH, -halfW, halfH)
        break
      }
      case 'polygon': {
        // Vertex at the top, as the shader and `hitsObject` have it.
        const sides = polygonSidesOf(object.props)
        for (let side = 0; side < sides; side += 1) {
          const angle = -Math.PI / 2 + (side / sides) * Math.PI * 2
          local.push(Math.cos(angle) * halfW, Math.sin(angle) * halfH)
        }
        break
      }
      case 'cylinder': {
        // The top of the upper cap, then the bottom of the lower one. The sides are the
        // straight runs between them.
        const cap = cylinderCap(object.h)
        const half = ELLIPSE_SAMPLES / 2
        for (let step = 0; step <= half; step += 1) {
          const angle = Math.PI + (step / half) * Math.PI
          local.push(Math.cos(angle) * halfW, -halfH + cap + Math.sin(angle) * cap)
        }
        for (let step = 0; step <= half; step += 1) {
          const angle = (step / half) * Math.PI
          local.push(Math.cos(angle) * halfW, halfH - cap + Math.sin(angle) * cap)
        }
        break
      }
      default:
        local.push(-halfW, -halfH, halfW, -halfH, halfW, halfH, -halfW, halfH)
    }
  }

  const centerX = object.x + halfW
  const centerY = object.y + halfH
  const cos = Math.cos(object.rotation)
  const sin = Math.sin(object.rotation)
  const points: number[] = new Array(local.length)
  for (let index = 0; index + 1 < local.length; index += 2) {
    const dx = local[index]
    const dy = local[index + 1]
    points[index] = centerX + dx * cos - dy * sin
    points[index + 1] = centerY + dx * sin + dy * cos
  }
  return { points, closed: !isFreedraw(object.type) }
}

/** The bounds of a flat `[x, y, ...]` list, or null when it is empty. */
export function pathBounds(points: readonly number[]): WorldRect | null {
  if (points.length < 2) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let index = 0; index + 1 < points.length; index += 2) {
    minX = Math.min(minX, points[index])
    minY = Math.min(minY, points[index + 1])
    maxX = Math.max(maxX, points[index])
    maxY = Math.max(maxY, points[index + 1])
  }
  return { minX, minY, maxX, maxY }
}

/**
 * Is a point inside a closed loop, by the even-odd rule?
 *
 * Even-odd rather than nonzero because a lasso is drawn by hand and often crosses
 * itself, and the region it shades on screen is the even-odd one: a figure of eight is
 * two loops, and the knot in the middle of one is outside it.
 */
export function insideLoop(loop: readonly number[], x: number, y: number): boolean {
  let inside = false
  const count = loop.length >> 1
  for (let index = 0, previous = count - 1; index < count; previous = index, index += 1) {
    const ax = loop[index * 2]
    const ay = loop[index * 2 + 1]
    const bx = loop[previous * 2]
    const by = loop[previous * 2 + 1]
    if (ay > y !== by > y && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside
  }
  return inside
}

/** Do segments ab and cd cross? Touching counts, so a loop grazing an outline refuses it. */
function segmentsCross(
  ax: number,
  ay: number,
  bx: number,
  by: number,
  cx: number,
  cy: number,
  dx: number,
  dy: number,
): boolean {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx)
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx)
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax)
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0 && d3 === 0 && d4 === 0)
}

/**
 * Is the object entirely inside a lasso?
 *
 * `loop` is the lasso's points, flat, closed implicitly from the last back to the
 * first; `bounds` is its box, passed in because the caller already has it and tests
 * many objects against one loop.
 *
 * Containment, as the marquee has it, and exact rather than sampled: an outline is
 * inside when one of its points is and no edge of the loop crosses it. A connected
 * outline cannot change sides without crossing, so that is the whole test. It also
 * keeps the cost on the objects near the loop's line rather than on every object in
 * it: only loop edges whose box meets the outline's box are tried against the outline,
 * and for an object sitting comfortably inside the loop there are none.
 */
export function containedByLoop(
  object: ObjectData,
  loop: readonly number[],
  bounds: WorldRect,
): boolean {
  if (loop.length < 6) return false
  const { points, closed } = outlineOf(object)
  const box = pathBounds(points)
  if (box === null) return false
  if (box.minX < bounds.minX || box.maxX > bounds.maxX) return false
  if (box.minY < bounds.minY || box.maxY > bounds.maxY) return false
  if (!insideLoop(loop, points[0], points[1])) return false

  const count = loop.length >> 1
  const segments = (points.length >> 1) - (closed ? 0 : 1)
  for (let index = 0; index < count; index += 1) {
    const next = (index + 1) % count
    const ax = loop[index * 2]
    const ay = loop[index * 2 + 1]
    const bx = loop[next * 2]
    const by = loop[next * 2 + 1]
    if (Math.max(ax, bx) < box.minX || Math.min(ax, bx) > box.maxX) continue
    if (Math.max(ay, by) < box.minY || Math.min(ay, by) > box.maxY) continue

    for (let segment = 0; segment < segments; segment += 1) {
      const end = (segment + 1) % (points.length >> 1)
      if (
        segmentsCross(
          ax,
          ay,
          bx,
          by,
          points[segment * 2],
          points[segment * 2 + 1],
          points[end * 2],
          points[end * 2 + 1],
        )
      ) {
        return false
      }
    }
  }
  return true
}

/**
 * The topmost object at a point.
 *
 * `ordered` must be in ascending z-order; it is walked backwards. `lookup` returns the
 * object for an id, or undefined if it has been deleted since the index was built.
 */
export function pickTop(
  ordered: readonly string[],
  candidates: ReadonlySet<string>,
  lookup: (id: string) => ObjectData | undefined,
  point: Point,
  tolerance: number,
): string | null {
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const id = ordered[index]
    if (!candidates.has(id)) continue
    const object = lookup(id)
    if (object === undefined || object.locked) continue
    if (hitsObject(object, point, tolerance)) return id
  }
  return null
}

/** Union of several objects' rotated bounds. Multi-select transforms use this. */
export function unionBounds(objects: readonly ObjectData[]): WorldRect | null {
  if (objects.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const object of objects) {
    for (const point of corners(object)) {
      minX = Math.min(minX, point.x)
      minY = Math.min(minY, point.y)
      maxX = Math.max(maxX, point.x)
      maxY = Math.max(maxY, point.y)
    }
  }

  return { minX, minY, maxX, maxY }
}
