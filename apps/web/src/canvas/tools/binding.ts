/**
 * Which shape an arrow end lands on, and attaching it there.
 *
 * Shared because two tools now draw connectors. The arrow tool does it on purpose and
 * the pen does it by recognising one, and an arrow that attaches when drawn with the
 * arrow tool but not when drawn with the pen would be a difference nobody could
 * explain. Attachment is a property of connectors, not of the gesture that made one.
 */

import { type ObjectData, anchorFor, isArrowLike } from '@meadow/schema'

import type { Point } from '../camera'
import { HIT_TOLERANCE_PX, hitsObject } from '../hitTest'
import type { ToolContext } from './types'

/**
 * A shape an arrow end can attach to.
 *
 * Arrows are excluded. Arrow-to-arrow bindings are expressible in the schema and are a
 * rabbit hole: the target has no interior to aim at, so the anchor maths degenerates,
 * and a chain of them can cycle. Not worth it for v1.
 */
function bindable(object: ObjectData | undefined): boolean {
  return object !== undefined && !object.locked && !isArrowLike(object.type)
}

/** The topmost shape under a point that an arrow end could bind to, or null. */
export function bindTarget(context: ToolContext, point: Point, exclude: string | null): string | null {
  const tolerance = context.camera.toWorldDistance(HIT_TOLERANCE_PX)
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
    // No tolerance here: an arrow should attach when dropped *on* a shape, not when
    // dropped a few pixels off it.
    if (hitsObject(object as ObjectData, point)) return id
  }
  return null
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
    gap: 4,
  })
}
