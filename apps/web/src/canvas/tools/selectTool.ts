/**
 * Select, move, resize, rotate, and marquee.
 *
 * The gesture is decided on pointer-down and does not change mid-drag. Re-deciding on
 * movement is how a canvas ends up starting a marquee because the pointer left the
 * object it grabbed.
 */

import type { ObjectData } from '@meadow/schema'

import type { Point, WorldRect } from '../camera'
import { HIT_TOLERANCE_PX, containedBy, pickTop, unionBounds } from '../hitTest'
import { SNAP_THRESHOLD_PX, snapMove } from '../snapping'
import {
  HANDLE_CURSORS,
  type HandleId,
  ROTATE_HANDLE_OFFSET_PX,
  applyRectToObject,
  handleAt,
  resizeRect,
  rotateAbout,
  rotationFor,
} from '../transform'
import type { CanvasPointerEvent, Tool, ToolContext } from './types'

const HANDLE_GRAB_PX = 6

type Gesture =
  | { kind: 'none' }
  | { kind: 'marquee'; origin: Point; additive: boolean }
  | { kind: 'move'; origin: Point; start: ObjectData[]; box: WorldRect; moved: boolean }
  | { kind: 'resize'; handle: HandleId; start: ObjectData[]; box: WorldRect }
  | { kind: 'rotate'; center: Point; start: ObjectData[]; startAngle: number }

export function createSelectTool(context: ToolContext): Tool {
  let gesture: Gesture = { kind: 'none' }

  const selectedObjects = (): ObjectData[] => {
    const out: ObjectData[] = []
    for (const id of context.selection()) {
      const object = context.object(id)
      if (object !== undefined && !object.locked) out.push(object)
    }
    return out
  }

  const selectionBox = (): WorldRect | null => unionBounds(selectedObjects())

  const hitAt = (world: Point): string | null => {
    const tolerance = context.camera.toWorldDistance(HIT_TOLERANCE_PX)
    const rect: WorldRect = {
      minX: world.x - tolerance,
      minY: world.y - tolerance,
      maxX: world.x + tolerance,
      maxY: world.y + tolerance,
    }
    return pickTop(
      context.order(),
      new Set(context.query(rect)),
      (id) => context.object(id),
      world,
      tolerance,
    )
  }

  return {
    id: 'select',
    cursor: 'default',

    onPointerDown(event: CanvasPointerEvent): void {
      const box = selectionBox()

      // Handles win over everything, including objects drawn on top of them.
      if (box !== null && context.canWrite) {
        const handle = handleAt(
          box,
          event.world,
          context.camera.toWorldDistance(HANDLE_GRAB_PX),
          context.camera.toWorldDistance(ROTATE_HANDLE_OFFSET_PX),
        )

        if (handle === 'rotate') {
          const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
          gesture = {
            kind: 'rotate',
            center,
            start: selectedObjects(),
            startAngle: rotationFor(center, event.world, false),
          }
          return
        }
        if (handle !== null) {
          gesture = { kind: 'resize', handle, start: selectedObjects(), box }
          return
        }
      }

      const hit = hitAt(event.world)

      if (hit === null) {
        if (!event.shiftKey) context.setSelection([])
        gesture = { kind: 'marquee', origin: event.world, additive: event.shiftKey }
        context.requestRender()
        return
      }

      const selection = context.selection()
      if (event.shiftKey) {
        const next = new Set(selection)
        if (next.has(hit)) next.delete(hit)
        else next.add(hit)
        context.setSelection(next)
      } else if (!selection.has(hit)) {
        context.setSelection([hit])
      }

      if (!context.canWrite) {
        gesture = { kind: 'none' }
        context.requestRender()
        return
      }

      const start = selectedObjects()
      const startBox = unionBounds(start)
      gesture =
        startBox === null
          ? { kind: 'none' }
          : { kind: 'move', origin: event.world, start, box: startBox, moved: false }
      context.requestRender()
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (gesture.kind === 'none') {
        // Hover feedback: show the resize cursor before the user commits to a drag.
        const box = selectionBox()
        if (box !== null && context.canWrite) {
          const handle = handleAt(
            box,
            event.world,
            context.camera.toWorldDistance(HANDLE_GRAB_PX),
            context.camera.toWorldDistance(ROTATE_HANDLE_OFFSET_PX),
          )
          context.setCursor(handle === null ? 'default' : HANDLE_CURSORS[handle])
        } else {
          context.setCursor('default')
        }
        return
      }

      if (gesture.kind === 'marquee') {
        const rect: WorldRect = {
          minX: Math.min(gesture.origin.x, event.world.x),
          minY: Math.min(gesture.origin.y, event.world.y),
          maxX: Math.max(gesture.origin.x, event.world.x),
          maxY: Math.max(gesture.origin.y, event.world.y),
        }
        context.setMarquee(rect)

        const inside = context
          .query(rect)
          .filter((id) => {
            const object = context.object(id)
            return object !== undefined && !object.locked && containedBy(object, rect)
          })

        context.setSelection(gesture.additive ? new Set([...context.selection(), ...inside]) : inside)
        context.requestRender()
        return
      }

      if (gesture.kind === 'move') {
        let dx = event.world.x - gesture.origin.x
        let dy = event.world.y - gesture.origin.y

        // Shift constrains to the dominant axis.
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }

        const moving: WorldRect = {
          minX: gesture.box.minX + dx,
          minY: gesture.box.minY + dy,
          maxX: gesture.box.maxX + dx,
          maxY: gesture.box.maxY + dy,
        }

        // Alt disables snapping, the usual escape hatch for placing something between
        // two aligned neighbours.
        if (!event.altKey) {
          const selected = context.selection()
          const targets = context.visibleObjects().filter((object) => !selected.has(object.id))
          const snap = snapMove(
            moving,
            targets,
            context.camera.toWorldDistance(SNAP_THRESHOLD_PX),
          )
          dx += snap.dx
          dy += snap.dy
          context.setGuides(snap.guides)
        } else {
          context.setGuides([])
        }

        context.applyPatches(
          gesture.start.map((object) => ({
            id: object.id,
            patch: { x: object.x + dx, y: object.y + dy },
          })),
        )
        gesture.moved = true
        context.requestRender()
        return
      }

      if (gesture.kind === 'resize') {
        // Bound to a const first: `gesture` is reassigned by the other handlers, so
        // TypeScript drops the narrowing inside the map callback below.
        const active = gesture
        const after = resizeRect(active.box, active.handle, event.world, {
          preserveAspect: event.shiftKey,
          fromCenter: event.altKey,
        })
        context.applyPatches(
          active.start.map((object) => ({
            id: object.id,
            patch: applyRectToObject(object, active.box, after),
          })),
        )
        context.requestRender()
        return
      }

      if (gesture.kind === 'rotate') {
        const active = gesture
        const angle = rotationFor(active.center, event.world, event.shiftKey)
        const delta = angle - active.startAngle
        context.applyPatches(
          active.start.map((object) => ({
            id: object.id,
            patch: rotateAbout(object, active.center, delta),
          })),
        )
        context.requestRender()
      }
    },

    onPointerUp(): void {
      const wasActive = gesture.kind !== 'none'
      gesture = { kind: 'none' }
      context.setMarquee(null)
      context.setGuides([])
      if (wasActive) context.commit()
      context.requestRender()
    },

    cancel(): void {
      gesture = { kind: 'none' }
      context.setMarquee(null)
      context.setGuides([])
    },
  }
}
