/**
 * Which shape an arrow end lands on, where it lands, and attaching it there.
 *
 * Shared because three gestures now attach connectors: the arrow tool draws one, the
 * pen draws one by recognising it, and the select tool re-aims the end of one that
 * already exists. An arrow that attached when drawn with the arrow tool but not when
 * its end was dragged onto the same shape afterwards would be a difference nobody
 * could explain. Attachment is a property of connectors, not of the gesture that made
 * one.
 */

import {
  type ObjectData,
  anchorFor,
  isArrowLike,
  resolveBoundPoint,
} from '@meadow/schema'

import type { Point } from '../camera'
import { hitsObject } from '../hitTest'
import type { ToolContext } from './types'

/**
 * How far off a shape an endpoint may be dropped and still attach, in screen pixels.
 *
 * Not zero, which is what this was, and the zero is the whole of the bug: an outline
 * is where you aim when you mean "connect to this", and a point *on* a two-unit stroke
 * is as likely to land a pixel outside the shape as inside it. Requiring the drop to
 * be strictly interior made attaching a coin toss at the one place people attach.
 *
 * Wider than `HIT_TOLERANCE_PX` on purpose. Selecting is a question about one object,
 * where a generous target steals clicks from the canvas; binding is asked only while
 * an endpoint is already in the air, where there is nothing else the gesture could
 * have meant.
 */
export const BIND_TOLERANCE_PX = 14

/** Standoff between a bound endpoint and the outline it stops at, in world units. */
export const BIND_GAP = 4

/**
 * A shape an arrow end can attach to.
 *
 * Arrows are excluded. Arrow-to-arrow bindings are expressible in the schema and are a
 * rabbit hole: the target has no interior to aim at, so the anchor maths degenerates,
 * and a chain of them can cycle. Not worth it for v1.
 */
function bindable(object: ObjectData | undefined): object is ObjectData {
  return object !== undefined && !object.locked && !isArrowLike(object.type)
}

/** The topmost shape under or beside a point that an arrow end could bind to, or null. */
export function bindTarget(context: ToolContext, point: Point, exclude: string | null): string | null {
  const tolerance = context.camera.toWorldDistance(BIND_TOLERANCE_PX)
  const candidates = new Set(
    context.query({
      minX: point.x - tolerance,
      minY: point.y - tolerance,
      maxX: point.x + tolerance,
      maxY: point.y + tolerance,
    }),
  )

  // Reverse z-order, so the shape drawn on top is the one attached to.
  const order = context.order()
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const id = order[index]
    if (id === exclude || !candidates.has(id)) continue
    const object = context.object(id)
    if (!bindable(object)) continue
    if (hitsObject(object, point, tolerance)) return id
  }
  return null
}

/** What an endpoint released here would become: a target, an anchor, and a position. */
export type BindPreview = {
  targetId: string | null
  anchor: { nx: number; ny: number }
  /** Where the end should be drawn: on the target's outline, or the pointer itself. */
  point: Point
}

/**
 * Where a dragged endpoint should sit right now, given what is under the pointer.
 *
 * The endpoint leaves the pointer and lands on the outline the moment the shape is in
 * reach, rather than following the cursor and jumping into place on release. That is
 * the whole feel of the gesture: you see the connection make itself while you are
 * still holding it, so releasing confirms something already on screen instead of
 * revealing something you had to guess at.
 *
 * `toward` is the arrow's other end, which is what makes a centre anchor directional.
 */
export function previewBind(
  context: ToolContext,
  point: Point,
  exclude: string | null,
  toward: Point,
): BindPreview {
  const targetId = bindTarget(context, point, exclude)
  const target = targetId === null ? undefined : context.object(targetId)
  if (targetId === null || !bindable(target)) {
    return { targetId: null, anchor: { nx: 0.5, ny: 0.5 }, point }
  }

  const anchor = anchorFor(target, point)
  return {
    targetId,
    anchor,
    // Solved the same way the document will solve it on release, so nothing moves
    // between the last frame of the drag and the first frame after it.
    point: resolveBoundPoint(target, { anchor, gap: BIND_GAP }, toward),
  }
}

/**
 * Attach one end of an arrow to whatever is under `point`, if anything is.
 *
 * `arrowId` is passed rather than read from a tool's own state, because the gesture
 * state is cleared before binding: a tool reading its own field here would see null
 * and silently bind nothing at all.
 */
export function attachArrowEnd(
  context: ToolContext,
  arrowId: string,
  end: 'start' | 'end',
  point: Point,
): void {
  const targetId = bindTarget(context, point, arrowId)
  if (targetId === null) return

  const target = context.object(targetId)
  if (target === undefined) return

  context.bindArrow({
    arrowId,
    end,
    targetId,
    anchor: anchorFor(target, point),
    gap: BIND_GAP,
  })
}
