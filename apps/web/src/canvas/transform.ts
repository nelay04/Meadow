/**
 * Resize and rotation handles, and the maths that applies them.
 *
 * Handles are laid out on the selection's axis-aligned bounding box. A multi-select
 * transform operates on the union box, per ARCHITECTURE 5, and distributes the result
 * to each member proportionally.
 */

import {
  type ObjectData,
  isFreedraw,
  resolveFreedrawProps,
  scaleInk,
  scaleNib,
} from '@meadow/schema'

import type { Point, WorldRect } from './camera'

export const HANDLE_SIZE_PX = 8

/**
 * How far outside a corner the rotate zone reaches, in screen pixels.
 *
 * Rotation used to be a dot floating above the box. That is one more piece of chrome
 * to draw, it only ever offered one grab point, and it sat exactly where a user
 * reaching for the top edge expects nothing to be. Figma puts the gesture in the empty
 * space just outside each corner instead: no affordance to draw, four places to start
 * it, and the cursor is what tells you it is there.
 */
export const ROTATE_REACH_PX = 18

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

/** The corners, in the order `ROTATE_CORNERS` names them. */
export type RotateCorner = 'nw' | 'ne' | 'se' | 'sw'

export type HandleId = ResizeHandle | 'rotate'

export const RESIZE_HANDLES: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']

export const ROTATE_CORNERS: RotateCorner[] = ['nw', 'ne', 'se', 'sw']

/**
 * A rotate cursor, inline.
 *
 * No stock CSS cursor means "rotate": `grab` reads as pan and `crosshair` reads as
 * draw, and both are already used elsewhere on this canvas for those. A data URI
 * costs no request and no build step, and it is the only signal that the zone is
 * there at all.
 */
const ROTATE_CURSOR =
  "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g fill='none' stroke='white' stroke-width='3.4' stroke-linecap='round' stroke-linejoin='round'><path d='M6.5 9.5a6.5 6.5 0 1 1-.7 5'/><path d='M3 5.5v4.5h4.5'/></g><g fill='none' stroke='black' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'><path d='M6.5 9.5a6.5 6.5 0 1 1-.7 5'/><path d='M3 5.5v4.5h4.5'/></g></svg>\") 12 12, grab"

export const HANDLE_CURSORS: Record<HandleId, string> = {
  nw: 'nwse-resize',
  n: 'ns-resize',
  ne: 'nesw-resize',
  e: 'ew-resize',
  se: 'nwse-resize',
  s: 'ns-resize',
  sw: 'nesw-resize',
  w: 'ew-resize',
  rotate: ROTATE_CURSOR,
}

/** Handle positions in world space, given a selection box. */
export function handlePositions(rect: WorldRect): Record<ResizeHandle, Point> {
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
  }
}

/**
 * Which handle is under a point, or null.
 *
 * Resize wins over rotate wherever they overlap. The handle is a visible square the
 * user is aiming at; the rotate zone is the empty space beyond it, and a tie there
 * should always resolve to the thing you can see.
 */
export function handleAt(
  rect: WorldRect,
  point: Point,
  worldTolerance: number,
  rotateReachWorld: number,
): HandleId | null {
  const positions = handlePositions(rect)

  for (const id of RESIZE_HANDLES) {
    const position = positions[id]
    if (
      Math.abs(point.x - position.x) <= worldTolerance &&
      Math.abs(point.y - position.y) <= worldTolerance
    ) {
      return id
    }
  }

  return rotateCornerAt(rect, point, worldTolerance, rotateReachWorld) === null ? null : 'rotate'
}

/**
 * The corner whose rotate zone contains a point, or null.
 *
 * The zone is the quarter-square *outside* the corner: past the resize handle on both
 * axes, and within reach on both. Bounding it on both axes is what keeps it out of
 * the way of the edge handles, which a plain radius around the corner would swallow
 * on a small selection.
 */
export function rotateCornerAt(
  rect: WorldRect,
  point: Point,
  worldTolerance: number,
  rotateReachWorld: number,
): RotateCorner | null {
  const positions = handlePositions(rect)

  for (const corner of ROTATE_CORNERS) {
    const position = positions[corner]
    const outX = corner === 'nw' || corner === 'sw' ? position.x - point.x : point.x - position.x
    const outY = corner === 'nw' || corner === 'ne' ? position.y - point.y : point.y - position.y
    if (
      outX > worldTolerance &&
      outY > worldTolerance &&
      outX <= rotateReachWorld &&
      outY <= rotateReachWorld
    ) {
      return corner
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
const MOVING_EDGES: Record<ResizeHandle, { x: Edge; y: Edge }> = {
  nw: { x: 'min', y: 'min' },
  n: { x: null, y: 'min' },
  ne: { x: 'max', y: 'min' },
  e: { x: 'max', y: null },
  se: { x: 'max', y: 'max' },
  s: { x: null, y: 'max' },
  sw: { x: 'min', y: 'max' },
  w: { x: 'min', y: null },
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
  handle: ResizeHandle,
  pointer: Point,
  options: ResizeOptions,
): WorldRect {
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

  const patch: Partial<ObjectData> = {
    x: after.minX + (object.x - before.minX) * scaleX,
    y: after.minY + (object.y - before.minY) * scaleY,
    w: Math.max(MIN_SIZE, object.w * scaleX),
    h: Math.max(MIN_SIZE, object.h * scaleY),
  }

  /*
   * Ink is the one object whose drawing is not implied by its box.
   *
   * A rectangle's `w` *is* the rectangle. A stroke's `w` is only the box its samples
   * happen to span, so a resize that writes bounds and stops leaves the original
   * scribble sitting inside a box that no longer fits it, unchanged and now wrong.
   * The samples and the nib are scaled here, in the one function every resize path
   * already goes through, rather than in a freedraw-shaped branch in the select tool.
   */
  if (isFreedraw(object.type)) {
    const props = resolveFreedrawProps(object)
    patch.props = {
      points: scaleInk(props.points, scaleX, scaleY),
      size: scaleNib(props.size, scaleX, scaleY),
    }
  }

  return patch
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
