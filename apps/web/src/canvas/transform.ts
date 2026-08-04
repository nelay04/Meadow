/**
 * Resize and rotation handles, and the maths that applies them.
 *
 * Handles are laid out on the selection's axis-aligned bounding box. A multi-select
 * transform operates on the union box, per ARCHITECTURE 5, and distributes the result
 * to each member proportionally.
 */

import type { ObjectData } from '@meadow/schema'

import type { Point, WorldRect } from './camera'

export const HANDLE_SIZE_PX = 8
export const ROTATE_HANDLE_OFFSET_PX = 22

export type HandleId =
  | 'nw'
  | 'n'
  | 'ne'
  | 'e'
  | 'se'
  | 's'
  | 'sw'
  | 'w'
  | 'rotate'

export const RESIZE_HANDLES: HandleId[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
  rotate: 'grab',
}

/** Handle positions in world space, given a selection box. */
export function handlePositions(rect: WorldRect): Record<HandleId, Point> {
  const midX = (rect.minX + rect.maxX) / 2
  const midY = (rect.minY + rect.maxY) / 2

  return {
    nw: { x: rect.minX, y: rect.minY },
    n: { x: midX, y: rect.minY },
    ne: { x: rect.maxX, y: rect.minY },
    e: { x: rect.maxX, y: midY },
    se: { x: rect.maxX, y: rect.maxY },
    s: { x: midX, y: rect.maxY },
    sw: { x: rect.minX, y: rect.maxY },
    w: { x: rect.minX, y: midY },
    // Sits above the box; the offset is applied in screen space by the caller so it
    // stays the same distance away at every zoom.
    rotate: { x: midX, y: rect.minY },
  }
}

/** Which handle is under a screen point, or null. */
export function handleAt(
  rect: WorldRect,
  point: Point,
  worldTolerance: number,
  rotateOffsetWorld: number,
): HandleId | null {
  const positions = handlePositions(rect)

  const rotate = { x: positions.rotate.x, y: positions.rotate.y - rotateOffsetWorld }
  if (Math.hypot(point.x - rotate.x, point.y - rotate.y) <= worldTolerance) return 'rotate'

  for (const id of RESIZE_HANDLES) {
    const position = positions[id]
    if (
      Math.abs(point.x - position.x) <= worldTolerance &&
      Math.abs(point.y - position.y) <= worldTolerance
    ) {
      return id
    }
  }
  return null
}

type Edge = 'min' | 'max' | null

/**
 * Which edges each handle drags.
 *
 * Stated as the edge that moves, not the corner that stays. The inverse phrasing is
 * easy to write and easy to get backwards, and the symptom is a shape that jumps to
 * the far side of the pointer on the first pixel of the drag.
 */
const MOVING_EDGES: Record<HandleId, { x: Edge; y: Edge }> = {
  nw: { x: 'min', y: 'min' },
  n: { x: null, y: 'min' },
  ne: { x: 'max', y: 'min' },
  e: { x: 'max', y: null },
  se: { x: 'max', y: 'max' },
  s: { x: null, y: 'max' },
  sw: { x: 'min', y: 'max' },
  w: { x: 'min', y: null },
  rotate: { x: null, y: null },
}

export type ResizeOptions = {
  /** Shift: keep the box's aspect ratio. */
  preserveAspect: boolean
  /** Alt: resize about the centre instead of the opposite corner. */
  fromCenter: boolean
}

/** Minimum extent, so a shape cannot be collapsed to nothing and become unclickable. */
const MIN_SIZE = 1

/**
 * The selection box after dragging `handle` to `pointer`.
 *
 * Returned as a rectangle rather than applied directly, so the caller can snap it
 * before distributing the change to the selected objects.
 */
export function resizeRect(
  start: WorldRect,
  handle: HandleId,
  pointer: Point,
  options: ResizeOptions,
): WorldRect {
  if (handle === 'rotate') return start

  const edges = MOVING_EDGES[handle]
  const width = start.maxX - start.minX
  const height = start.maxY - start.minY

  let minX = start.minX
  let minY = start.minY
  let maxX = start.maxX
  let maxY = start.maxY

  if (edges.x === 'min') minX = pointer.x
  else if (edges.x === 'max') maxX = pointer.x
  if (edges.y === 'min') minY = pointer.y
  else if (edges.y === 'max') maxY = pointer.y

  // Alt: mirror the dragged edge about the original centre, so the box grows both ways.
  if (options.fromCenter) {
    const centerX = (start.minX + start.maxX) / 2
    const centerY = (start.minY + start.maxY) / 2
    if (edges.x !== null) {
      const half = Math.max(Math.abs(pointer.x - centerX), MIN_SIZE / 2)
      minX = centerX - half
      maxX = centerX + half
    }
    if (edges.y !== null) {
      const half = Math.max(Math.abs(pointer.y - centerY), MIN_SIZE / 2)
      minY = centerY - half
      maxY = centerY + half
    }
  }

  // Dragging a handle past the opposite edge flips the box rather than inverting it.
  if (minX > maxX) [minX, maxX] = [maxX, minX]
  if (minY > maxY) [minY, maxY] = [maxY, minY]

  if (maxX - minX < MIN_SIZE) maxX = minX + MIN_SIZE
  if (maxY - minY < MIN_SIZE) maxY = minY + MIN_SIZE

  if (options.preserveAspect && width > 0 && height > 0) {
    const ratio = width / height
    const currentWidth = maxX - minX
    const currentHeight = maxY - minY

    // Grow the lagging axis to match, so the box always follows the pointer outwards
    // rather than shrinking away from it.
    if (currentWidth / currentHeight > ratio) {
      const target = currentWidth / ratio
      if (options.fromCenter || edges.y === null) {
        const centerY = (minY + maxY) / 2
        minY = centerY - target / 2
        maxY = centerY + target / 2
      } else if (edges.y === 'max') {
        // The top edge is the one staying put.
        maxY = minY + target
      } else {
        minY = maxY - target
      }
    } else {
      const target = currentHeight * ratio
      if (options.fromCenter || edges.x === null) {
        const centerX = (minX + maxX) / 2
        minX = centerX - target / 2
        maxX = centerX + target / 2
      } else if (edges.x === 'max') {
        maxX = minX + target
      } else {
        minX = maxX - target
      }
    }
  }

  return { minX, minY, maxX, maxY }
}

/**
 * Map a selection-box resize onto one object.
 *
 * Each object keeps its proportional position and size within the box, so resizing a
 * multi-selection scales the arrangement rather than stacking everything in a corner.
 */
export function applyRectToObject(
  object: ObjectData,
  before: WorldRect,
  after: WorldRect,
): Partial<ObjectData> {
  const beforeWidth = before.maxX - before.minX
  const beforeHeight = before.maxY - before.minY
  if (beforeWidth <= 0 || beforeHeight <= 0) return {}

  const scaleX = (after.maxX - after.minX) / beforeWidth
  const scaleY = (after.maxY - after.minY) / beforeHeight

  return {
    x: after.minX + (object.x - before.minX) * scaleX,
    y: after.minY + (object.y - before.minY) * scaleY,
    w: Math.max(MIN_SIZE, object.w * scaleX),
    h: Math.max(MIN_SIZE, object.h * scaleY),
  }
}

/** Rotation in radians from the selection centre to the pointer, zero pointing up. */
export function rotationFor(center: Point, pointer: Point, snapToIncrement: boolean): number {
  const angle = Math.atan2(pointer.y - center.y, pointer.x - center.x) + Math.PI / 2
  if (!snapToIncrement) return angle
  const step = Math.PI / 12 // 15 degrees
  return Math.round(angle / step) * step
}

/** Rotate an object about an arbitrary world point, keeping its size. */
export function rotateAbout(
  object: ObjectData,
  center: Point,
  delta: number,
): Partial<ObjectData> {
  const objectCenterX = object.x + object.w / 2
  const objectCenterY = object.y + object.h / 2
  const cos = Math.cos(delta)
  const sin = Math.sin(delta)
  const dx = objectCenterX - center.x
  const dy = objectCenterY - center.y

  const rotatedX = center.x + dx * cos - dy * sin
  const rotatedY = center.y + dx * sin + dy * cos

  return {
    x: rotatedX - object.w / 2,
    y: rotatedY - object.h / 2,
    rotation: object.rotation + delta,
  }
}
