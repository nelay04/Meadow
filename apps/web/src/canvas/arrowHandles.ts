/**
 * The handles a selected arrow gets, and where they sit.
 *
 * Shared between the select tool, which hit-tests them, and the engine, which draws
 * them. Two copies of "where is the middle of this arrow" is two answers, and the
 * symptom is a handle you can see but not grab.
 *
 * There is no bounding box and there are no resize handles, on purpose. See the note
 * at the top of tools/selectTool.ts for why an arrow is not transformed like a shape.
 *
 * A straight arrow gets one bend handle in the middle; a curved one gets two, at a
 * third and two thirds along. That is not an inconsistency, it is the point. One
 * handle can only describe a C, and the first grab on a straight line should be the
 * simple one. Once it is a curve, each half needs its own, because opposite leans are
 * what make an S.
 */

import {
  CURVE_HANDLE_TS,
  type ObjectData,
  arrowPolyline,
  pointAlongPath,
  pointOnCurve,
  resolveArrowProps,
} from '@meadow/schema'

import type { Point } from './camera'

/** `bend0` and `bend1` are the two thirds; `bend` is the single midpoint. */
export type ArrowHandleId = 'start' | 'end' | 'bend' | 'bend0' | 'bend1' | 'elbow'

/** Screen-space, converted by the caller, so the targets do not change size with zoom. */
export const ARROW_HANDLE_RADIUS_PX = 5
export const ARROW_HANDLE_GRAB_PX = 10

export type ArrowHandlePoints = {
  start: Point
  end: Point
  /** The bend handles, in the order they run along the arrow. */
  bends: { id: ArrowHandleId; at: Point; t: number }[]
}

/** Where an arrow's handles are, in world coordinates. */
export function arrowHandles(arrow: ObjectData): ArrowHandlePoints {
  const props = resolveArrowProps(arrow)
  const path = arrowPolyline(props.points, props.routing, props.curvature, props.curvatureEnd)
  const last = path.length - 2

  const start = { x: path[0] + arrow.x, y: path[1] + arrow.y }
  const end = { x: path[last] + arrow.x, y: path[last + 1] + arrow.y }

  if (props.routing === 'curved') {
    const bends = CURVE_HANDLE_TS.map((t, index) => {
      const point = pointOnCurve(props.points, props.curvature, props.curvatureEnd, t)
      return {
        id: (index === 0 ? 'bend0' : 'bend1') as ArrowHandleId,
        at: { x: point.x + arrow.x, y: point.y + arrow.y },
        t,
      }
    })
    return { start, end, bends }
  }

  /*
   * An elbow's handle slides its dogleg; it does not bend it into a curve.
   *
   * Two earlier versions of this were both wrong. The first turned an elbow into a
   * curve, which is not something anybody asks for by grabbing a corner. The second
   * gave it no handle at all, which is worse: a press in the middle fell through to
   * the arrow itself and started a *move*, and moving an arrow with one end pinned to
   * a shape stretches it, so reaching for the dogleg made the connector shoot across
   * the board.
   *
   * The handle sits on the middle of the crossing segment, which is the segment the
   * fraction actually controls.
   */
  if (props.routing === 'orthogonal') {
    if (path.length < 8) return { start, end, bends: [] }
    const corner = 2
    const middle = {
      x: (path[corner] + path[corner + 2]) / 2 + arrow.x,
      y: (path[corner + 1] + path[corner + 3]) / 2 + arrow.y,
    }
    return { start, end, bends: [{ id: 'elbow', at: middle, t: 0.5 }] }
  }

  // Half way along the path by arc length, not the midpoint of the chord.
  const middle = pointAlongPath(path, 0.5)
  return {
    start,
    end,
    bends: [{ id: 'bend', at: { x: middle.x + arrow.x, y: middle.y + arrow.y }, t: 0.5 }],
  }
}

/**
 * Which handle is under a point, or null.
 *
 * The ends win over the bends. On a very short arrow they all overlap, and moving an
 * end is both the more common intent and the one that can undo the overlap.
 */
export function arrowHandleAt(
  handles: ArrowHandlePoints,
  point: Point,
  grab: number,
): ArrowHandleId | null {
  const near = (at: Point): boolean => Math.hypot(point.x - at.x, point.y - at.y) <= grab

  if (near(handles.start)) return 'start'
  if (near(handles.end)) return 'end'
  for (const bend of handles.bends) {
    if (near(bend.at)) return bend.id
  }
  return null
}
