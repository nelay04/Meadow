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

import type { ObjectData } from '@meadow/schema'

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

/**
 * Is a world point inside this object?
 *
 * `tolerance` is in world units and grows the shape outwards, so thin or small objects
 * stay clickable when zoomed out.
 */
export function hitsObject(object: ObjectData, point: Point, tolerance = 0): boolean {
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
 * Marquee selection uses containment rather than intersection, matching Figma: a drag
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
