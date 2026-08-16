/**
 * Snapping and the guides that explain it. ARCHITECTURE 5.
 *
 * Three kinds of help, in the order a user notices them missing:
 *
 * 1. **Alignment.** Edges and centres line up with a neighbour's, and a line is drawn
 *    through both so it is obvious *which* neighbour was matched.
 * 2. **Distribution.** The gap either side of the object being dragged is equalised,
 *    or matched to a gap that already exists further along the row. This is the one
 *    that makes a diagram look laid out rather than nudged, and it is what the first
 *    version of this file was missing: it could tell you two boxes shared an edge, but
 *    not that three boxes were evenly spaced.
 * 3. **Size parity.** While resizing, an edge snaps to a neighbour's edge, so a column
 *    of boxes ends up the same width without anybody typing a number.
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
import type { ResizeHandle } from './transform'

export const SNAP_THRESHOLD_PX = 5

export type SnapGuide = {
  /**
   * `align` is a line through two edges that now agree. `spacing` is a measured gap,
   * drawn as a bar with end ticks between the two things it separates.
   */
  kind: 'align' | 'spacing'
  axis: 'x' | 'y'
  /**
   * For `align`, the coordinate of the line itself. For `spacing`, the coordinate of
   * the *other* axis: where along the row the measuring bar is drawn.
   */
  position: number
  from: number
  to: number
}

export type SnapResult = {
  dx: number
  dy: number
  guides: SnapGuide[]
}

const NO_SNAP: SnapResult = { dx: 0, dy: 0, guides: [] }

/** Gaps closer than this are treated as touching, not as a distribution to match. */
const MIN_GAP = 0.5

function edgesOf(rect: WorldRect): number[] {
  return [rect.minX, (rect.minX + rect.maxX) / 2, rect.maxX]
}

function verticalEdgesOf(rect: WorldRect): number[] {
  return [rect.minY, (rect.minY + rect.maxY) / 2, rect.maxY]
}

export function boundsOf(object: ObjectData): WorldRect {
  return { minX: object.x, minY: object.y, maxX: object.x + object.w, maxY: object.y + object.h }
}

/**
 * One axis of the distribution search, written once and called twice.
 *
 * The two axes are the same problem with the coordinates swapped, and writing it out
 * twice is how the horizontal case ends up with a fix the vertical one never got.
 * `lo`/`hi` are the axis being spaced along, `crossLo`/`crossHi` the one that decides
 * whether two objects are even in the same row.
 */
type Span = { lo: number; hi: number; crossLo: number; crossHi: number }

function spanOf(rect: WorldRect, axis: 'x' | 'y'): Span {
  return axis === 'x'
    ? { lo: rect.minX, hi: rect.maxX, crossLo: rect.minY, crossHi: rect.maxY }
    : { lo: rect.minY, hi: rect.maxY, crossLo: rect.minX, crossHi: rect.maxX }
}

type SpacingSnap = { delta: number; distance: number; guides: SnapGuide[] }

/** A measuring bar between `lo` and `hi` on `axis`, drawn at `at` on the other one. */
function spacingGuide(axis: 'x' | 'y', lo: number, hi: number, at: number): SnapGuide {
  return { kind: 'spacing', axis, position: at, from: lo, to: hi }
}

/**
 * Equalise the gaps around the moving rectangle along one axis.
 *
 * Two patterns, both of which Figma offers and both of which come up constantly:
 *
 * - **Centred between two neighbours.** One object each side, and the gap either side
 *   is made the same. This is what you want when dropping a box into a row.
 * - **Continuing a rhythm.** Two objects on the same side already have a gap between
 *   them, and the new one repeats it. This is what you want when adding to the end of
 *   a row, where there is no neighbour on the far side to be centred against.
 *
 * Only objects that actually overlap the mover on the cross axis count. Without that
 * test a box three rows down would be treated as being in the same row and the tool
 * would offer a spacing that means nothing.
 */
function snapSpacing(
  moving: WorldRect,
  targets: readonly ObjectData[],
  threshold: number,
  axis: 'x' | 'y',
): SpacingSnap | null {
  const self = spanOf(moving, axis)
  const size = self.hi - self.lo

  const before: Span[] = []
  const after: Span[] = []

  for (const target of targets) {
    const span = spanOf(boundsOf(target), axis)
    // Same row, or same column. Strict overlap, so objects merely touching corners do
    // not drag an unrelated part of the board into the calculation.
    if (span.crossHi <= self.crossLo || span.crossLo >= self.crossHi) continue
    if (span.hi <= self.lo) before.push(span)
    else if (span.lo >= self.hi) after.push(span)
  }

  before.sort((a, b) => b.hi - a.hi)
  after.sort((a, b) => a.lo - b.lo)

  // Where the bar is drawn: the middle of the band the mover and its neighbour share.
  const barAt = (other: Span): number =>
    (Math.max(self.crossLo, other.crossLo) + Math.min(self.crossHi, other.crossHi)) / 2

  let best: SpacingSnap | null = null
  const consider = (targetLo: number, guides: (lo: number) => SnapGuide[]): void => {
    const delta = targetLo - self.lo
    const distance = Math.abs(delta)
    if (distance > threshold) return
    if (best !== null && distance >= best.distance) return
    best = { delta, distance, guides: guides(targetLo) }
  }

  // Centred between the nearest neighbour on each side.
  if (before.length > 0 && after.length > 0) {
    const left = before[0]
    const right = after[0]
    const gap = (right.lo - left.hi - size) / 2
    if (gap >= MIN_GAP) {
      consider(left.hi + gap, (lo) => [
        spacingGuide(axis, left.hi, lo, barAt(left)),
        spacingGuide(axis, lo + size, right.lo, barAt(right)),
      ])
    }
  }

  // Repeating the gap that already exists between the two nearest on one side.
  if (before.length > 1) {
    const near = before[0]
    const far = before[1]
    const gap = near.lo - far.hi
    if (gap >= MIN_GAP) {
      consider(near.hi + gap, (lo) => [
        spacingGuide(axis, far.hi, near.lo, barAt(far)),
        spacingGuide(axis, near.hi, lo, barAt(near)),
      ])
    }
  }
  if (after.length > 1) {
    const near = after[0]
    const far = after[1]
    const gap = far.lo - near.hi
    if (gap >= MIN_GAP) {
      consider(near.lo - gap - size, (lo) => [
        spacingGuide(axis, lo + size, near.lo, barAt(near)),
        spacingGuide(axis, near.hi, far.lo, barAt(far)),
      ])
    }
  }

  return best
}

/**
 * Best snap offset for a moving rectangle against a set of static ones.
 *
 * Each axis is resolved independently: an object can snap its left edge to one
 * neighbour and its top to a different one, which is what makes alignment feel like it
 * is doing the work for you.
 *
 * Alignment beats distribution on the same axis. When both are in range they usually
 * disagree by a pixel or two, and an edge visibly lining up is a stronger claim about
 * what the user meant than a gap being equal to another gap.
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
            kind: 'align',
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
            kind: 'align',
            axis: 'y',
            position: candidate,
            from: Math.min(moving.minX, rect.minX),
            to: Math.max(moving.maxX, rect.maxX),
          },
        }
      }
    }
  }

  const guides: SnapGuide[] = []
  let dx = 0
  let dy = 0

  if (bestX !== null) {
    dx = bestX.delta
    guides.push(bestX.guide)
  } else {
    const spacing = snapSpacing(moving, targets, threshold, 'x')
    if (spacing !== null) {
      dx = spacing.delta
      guides.push(...spacing.guides)
    }
  }

  if (bestY !== null) {
    dy = bestY.delta
    guides.push(bestY.guide)
  } else {
    const spacing = snapSpacing(moving, targets, threshold, 'y')
    if (spacing !== null) {
      dy = spacing.delta
      guides.push(...spacing.guides)
    }
  }

  // The grid is the last fallback, never an override: an explicit alignment to another
  // object, or an even gap, beats landing on an invisible grid line.
  if (dx === 0 && bestX === null && gridSize > 0) {
    const snapped = Math.round(moving.minX / gridSize) * gridSize
    const delta = snapped - moving.minX
    if (Math.abs(delta) <= threshold) {
      dx = delta
      guides.push({ kind: 'align', axis: 'x', position: snapped, from: moving.minY, to: moving.maxY })
    }
  }
  if (dy === 0 && bestY === null && gridSize > 0) {
    const snapped = Math.round(moving.minY / gridSize) * gridSize
    const delta = snapped - moving.minY
    if (Math.abs(delta) <= threshold) {
      dy = delta
      guides.push({ kind: 'align', axis: 'y', position: snapped, from: moving.minX, to: moving.maxX })
    }
  }

  return { dx, dy, guides }
}

/** Which edges of the box a handle drags. Mirrors `MOVING_EDGES` in transform.ts. */
const RESIZE_AXES: Record<ResizeHandle, { x: 'min' | 'max' | null; y: 'min' | 'max' | null }> = {
  nw: { x: 'min', y: 'min' },
  n: { x: null, y: 'min' },
  ne: { x: 'max', y: 'min' },
  e: { x: 'max', y: null },
  se: { x: 'max', y: 'max' },
  s: { x: null, y: 'max' },
  sw: { x: 'min', y: 'max' },
  w: { x: 'min', y: null },
}

export type ResizeSnap = { rect: WorldRect; guides: SnapGuide[] }

/**
 * Pull the edges a resize is moving onto a neighbour's edges or centre.
 *
 * Only the edges the handle actually drags are snapped. Snapping the fixed edge as
 * well would move the side the user is holding still, which reads as the shape sliding
 * out from under the pointer.
 *
 * The centre lines are in the candidate set on purpose: centring one box over another
 * while resizing is common, and it is not expressible as an edge match.
 */
export function snapResize(
  rect: WorldRect,
  handle: ResizeHandle,
  targets: readonly ObjectData[],
  threshold: number,
): ResizeSnap {
  if (threshold <= 0) return { rect, guides: [] }

  const axes = RESIZE_AXES[handle]
  const out = { ...rect }
  const guides: SnapGuide[] = []

  const snapEdge = (
    axis: 'x' | 'y',
    value: number,
    candidates: (target: WorldRect) => number[],
  ): { value: number; guide: SnapGuide } | null => {
    let best: { value: number; distance: number; span: WorldRect } | null = null
    for (const target of targets) {
      const bounds = boundsOf(target)
      for (const candidate of candidates(bounds)) {
        const distance = Math.abs(candidate - value)
        if (distance > threshold) continue
        if (best !== null && distance >= best.distance) continue
        best = { value: candidate, distance, span: bounds }
      }
    }
    if (best === null) return null
    return {
      value: best.value,
      guide:
        axis === 'x'
          ? {
              kind: 'align',
              axis: 'x',
              position: best.value,
              from: Math.min(rect.minY, best.span.minY),
              to: Math.max(rect.maxY, best.span.maxY),
            }
          : {
              kind: 'align',
              axis: 'y',
              position: best.value,
              from: Math.min(rect.minX, best.span.minX),
              to: Math.max(rect.maxX, best.span.maxX),
            },
    }
  }

  if (axes.x !== null) {
    const current = axes.x === 'min' ? rect.minX : rect.maxX
    const snapped = snapEdge('x', current, edgesOf)
    if (snapped !== null) {
      if (axes.x === 'min') out.minX = snapped.value
      else out.maxX = snapped.value
      guides.push(snapped.guide)
    }
  }

  if (axes.y !== null) {
    const current = axes.y === 'min' ? rect.minY : rect.maxY
    const snapped = snapEdge('y', current, verticalEdgesOf)
    if (snapped !== null) {
      if (axes.y === 'min') out.minY = snapped.value
      else out.maxY = snapped.value
      guides.push(snapped.guide)
    }
  }

  return { rect: out, guides }
}
