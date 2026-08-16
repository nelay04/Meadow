/**
 * Draw an arrow or a line by dragging, attaching to whatever is under each end.
 *
 * Attachment is implicit. Dropping an endpoint on a shape binds to it; dropping it in
 * space leaves it free. There is no modifier to hold and no connection handle to aim
 * at, because the common case is "connect these two boxes" and it should cost one
 * drag.
 *
 * Where on the shape you drop matters. Near the middle binds to the centre, which
 * makes the arrow aim at the middle and stop at the outline, following the shape as it
 * moves. Near an edge pins to that spot. `anchorFor` owns that threshold.
 */

import {
  type ObjectData,
  type ObjectType,
  anchorFor,
  arrowGeometry,
  routeOrthogonal,
  isArrowLike,
} from '@meadow/schema'

import type { Point } from '../camera'
import { HIT_TOLERANCE_PX, hitsObject } from '../hitTest'
import type { CanvasPointerEvent, Tool, ToolContext, ToolId } from './types'

/** Below this drag distance in world units, the gesture is a click and creates nothing. */
const DRAG_THRESHOLD = 6

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

export function createArrowTool(context: ToolContext, type: ObjectType & ToolId): Tool {
  let origin: Point | null = null
  let arrowId: string | null = null

  const pickTarget = (point: Point, exclude: string | null): string | null => {
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
   * `id` is passed in rather than read from the closure. The gesture state is cleared
   * before binding, so reading `arrowId` here would always see null and silently bind
   * nothing at all.
   */
  const attach = (id: string, end: 'start' | 'end', point: Point): void => {
    const targetId = pickTarget(point, id)
    if (targetId === null) return

    const target = context.object(targetId)
    if (target === undefined) return

    context.bindArrow({
      arrowId: id,
      end,
      targetId,
      anchor: anchorFor(target, point),
      gap: 4,
    })
  }

  const cancel = (): void => {
    origin = null
    arrowId = null
    context.setHoverTarget(null)
  }

  return {
    id: type,
    cursor: 'crosshair',

    onPointerDown(event: CanvasPointerEvent): void {
      if (!context.canWrite) return
      origin = event.world
      arrowId = null
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (origin === null) {
        // Idle: still show what the pointer would attach to, so the binding is not a
        // surprise that only becomes visible after the drag.
        context.setHoverTarget(pickTarget(event.world, null))
        context.requestRender()
        return
      }

      const dragged =
        Math.abs(event.world.x - origin.x) > DRAG_THRESHOLD ||
        Math.abs(event.world.y - origin.y) > DRAG_THRESHOLD
      if (!dragged) return

      // Routed as it is drawn, not on release. An elbow that renders as a straight
      // line for the whole drag and snaps into shape at the end is the tool lying
      // about what it is making, and it is impossible to aim.
      const absolute =
        context.arrowRouting === 'orthogonal'
          ? routeOrthogonal(origin, event.world)
          : [origin.x, origin.y, event.world.x, event.world.y]

      if (arrowId === null) {
        // Created on the first real movement, like the shape tool, so a click that
        // turns out to be a drag leaves no stray zero-length arrow behind it.
        const geometry = arrowGeometry(absolute)
        arrowId = context.createObject({
          type,
          x: geometry.x,
          y: geometry.y,
          w: geometry.w,
          h: geometry.h,
          // The routing chosen in the rail, written at creation so the arrow is the
          // shape the user picked from its very first frame rather than snapping into
          // it when the drag ends.
          props: { points: geometry.points, routing: context.arrowRouting },
        })
        if (arrowId !== null) context.setSelection([arrowId])
      } else {
        context.setArrowPoints(arrowId, absolute)
      }

      context.setHoverTarget(pickTarget(event.world, arrowId))
      context.requestRender()
    },

    onPointerUp(event: CanvasPointerEvent): void {
      const start = origin
      const id = arrowId
      origin = null
      arrowId = null
      context.setHoverTarget(null)

      if (start === null || id === null) {
        // Nothing was drawn - a click rather than a drag. Still drop back to select,
        // so an accidental tap on the canvas does not leave the tool armed.
        if (start !== null) context.setTool('select')
        context.requestRender()
        return
      }

      // Bind after the geometry is final. Binding first would solve the endpoint
      // against a half-drawn arrow and then immediately overwrite it.
      attach(id, 'start', start)
      attach(id, 'end', event.world)

      // An elbow's waypoints are stored rather than derived, so a route has to be
      // generated once the two ends are settled. Harmless for the other two, which
      // re-derive from the same endpoints.
      context.setArrowRouting(id, { routing: context.arrowRouting })

      context.commit()
      context.setTool('select')
      context.requestRender()
    },

    cancel,
  }
}
