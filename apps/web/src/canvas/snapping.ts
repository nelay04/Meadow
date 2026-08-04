/**
 * Snapping. ARCHITECTURE 5: object edges and centres, plus grid, with a 5px threshold.
 *
 * The threshold is in *screen* pixels, converted to world units by the caller. A world
 * threshold would make snapping unusable at both ends of the zoom range: sticky at 0.1x
 * and unreachable at 8x.
 *
 * Only candidates already on screen are considered. Snapping to an object a mile away
 * produces a guide line pointing at nothing, which is worse than not snapping.
 */

import type { ObjectData } from '@meadow/schema'

import type { WorldRect } from './camera'

export const SNAP_THRESHOLD_PX = 5

export type SnapGuide = {
  axis: 'x' | 'y'
  /** World coordinate of the guide line. */
  position: number
  /** World-space span to draw the guide over, so it visibly connects the two objects. */
  from: number
  to: number
}

export type SnapResult = {
  dx: number
  dy: number
  guides: SnapGuide[]
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] }

function edgesOf(rect: WorldRect): number[] {
  return [rect.minX, (rect.minX + rect.maxX) / 2, rect.maxX]
}

function verticalEdgesOf(rect: WorldRect): number[] {
  return [rect.minY, (rect.minY + rect.maxY) / 2, rect.maxY]
}

function boundsOf(object: ObjectData): WorldRect {
  return { minX: object.x, minY: object.y, maxX: object.x + object.w, maxY: object.y + object.h }
}

/**
 * Best snap offset for a moving rectangle against a set of static ones.
 *
 * Each axis is resolved independently: an object can snap its left edge to one
 * neighbour and its top to a different one, which is what makes alignment feel like it
 * is doing the work for you.
 */
export function snapMove(
  moving: WorldRect,
  targets: readonly ObjectData[],
  threshold: number,
  gridSize = 0,
): SnapResult {
  if (threshold <= 0) return NO_SNAP

  const movingX = edgesOf(moving)
  const movingY = verticalEdgesOf(moving)

  let bestX: { delta: number; distance: number; guide: SnapGuide } | null = null
  let bestY: { delta: number; distance: number; guide: SnapGuide } | null = null

  for (const target of targets) {
    const rect = boundsOf(target)

    for (const edge of movingX) {
      for (const candidate of edgesOf(rect)) {
        const delta = candidate - edge
        const distance = Math.abs(delta)
        if (distance > threshold) continue
        if (bestX !== null && distance >= bestX.distance) continue
        bestX = {
          delta,
          distance,
          guide: {
            axis: 'x',
            position: candidate,
            from: Math.min(moving.minY, rect.minY),
            to: Math.max(moving.maxY, rect.maxY),
          },
        }
      }
    }

    for (const edge of movingY) {
      for (const candidate of verticalEdgesOf(rect)) {
        const delta = candidate - edge
        const distance = Math.abs(delta)
        if (distance > threshold) continue
        if (bestY !== null && distance >= bestY.distance) continue
        bestY = {
          delta,
          distance,
          guide: {
            axis: 'y',
            position: candidate,
            from: Math.min(moving.minX, rect.minX),
            to: Math.max(moving.maxX, rect.maxX),
          },
        }
      }
    }
  }

  // The grid is the fallback, never an override: an explicit alignment to another
  // object beats landing on an invisible grid line.
  if (bestX === null && gridSize > 0) {
    const snapped = Math.round(moving.minX / gridSize) * gridSize
    const delta = snapped - moving.minX
    if (Math.abs(delta) <= threshold) {
      bestX = { delta, distance: Math.abs(delta), guide: { axis: 'x', position: snapped, from: moving.minY, to: moving.maxY } }
    }
  }
  if (bestY === null && gridSize > 0) {
    const snapped = Math.round(moving.minY / gridSize) * gridSize
    const delta = snapped - moving.minY
    if (Math.abs(delta) <= threshold) {
      bestY = { delta, distance: Math.abs(delta), guide: { axis: 'y', position: snapped, from: moving.minX, to: moving.maxX } }
    }
  }

  const guides: SnapGuide[] = []
  if (bestX !== null) guides.push(bestX.guide)
  if (bestY !== null) guides.push(bestY.guide)

  return { dx: bestX?.delta ?? 0, dy: bestY?.delta ?? 0, guides }
}
