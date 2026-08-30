/**
 * Draw one of the primitive shapes by dragging.
 *
 * A click without a drag creates a default-sized shape centred on the pointer, which
 * is what people expect after picking a shape from a toolbar.
 */

import type { ObjectData, ObjectType } from '@meadow/schema'

import type { Point } from '../camera'
import type { CanvasPointerEvent, Tool, ToolContext, ToolId } from './types'

const DEFAULT_WIDTH = 140
const DEFAULT_HEIGHT = 90
/** Below this drag distance in world units, treat the gesture as a click. */
const DRAG_THRESHOLD = 4

export function createShapeTool(context: ToolContext, type: ObjectType & ToolId): Tool {
  let origin: Point | null = null
  let preview: string | null = null

  /*
   * The side count is written at creation, the way the arrow writes its routing: it is
   * the polygon's own geometry from its first frame rather than a default that the rail
   * corrects afterwards. Read per shape rather than once, so a count changed between
   * two drags applies to the second one.
   */
  const propsFor = (): Partial<ObjectData> =>
    type === 'polygon' ? { props: { polygonSides: context.polygonSides } } : {}

  const rectFrom = (start: Point, current: Point, square: boolean, fromCenter: boolean) => {
    let width = current.x - start.x
    let height = current.y - start.y

    if (square) {
      const size = Math.max(Math.abs(width), Math.abs(height))
      width = Math.sign(width || 1) * size
      height = Math.sign(height || 1) * size
    }

    if (fromCenter) {
      return {
        x: start.x - Math.abs(width),
        y: start.y - Math.abs(height),
        w: Math.abs(width) * 2,
        h: Math.abs(height) * 2,
      }
    }

    return {
      x: Math.min(start.x, start.x + width),
      y: Math.min(start.y, start.y + height),
      w: Math.abs(width),
      h: Math.abs(height),
    }
  }

  return {
    id: type,
    cursor: 'crosshair',

    onPointerDown(event: CanvasPointerEvent): void {
      if (!context.canWrite) return
      origin = event.world
      preview = null
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (origin === null) return

      const box = rectFrom(origin, event.world, event.shiftKey, event.altKey)
      if (box.w < DRAG_THRESHOLD && box.h < DRAG_THRESHOLD) return

      if (preview === null) {
        // Create on the first real movement rather than on pointerdown, so a click
        // that turns out to be a drag does not leave a stray default-sized shape in
        // the undo history behind the one actually drawn.
        preview = context.createObject({ type, ...box, ...propsFor() })
        if (preview !== null) context.setSelection([preview])
      } else {
        context.applyPatches([{ id: preview, patch: box }])
      }
      context.requestRender()
    },

    onPointerUp(event: CanvasPointerEvent): void {
      if (origin === null) return

      if (preview === null) {
        const id = context.createObject({
          type,
          x: event.world.x - DEFAULT_WIDTH / 2,
          y: event.world.y - DEFAULT_HEIGHT / 2,
          w: DEFAULT_WIDTH,
          h: DEFAULT_HEIGHT,
          ...propsFor(),
        })
        if (id !== null) context.setSelection([id])
      }

      origin = null
      preview = null
      context.commit()
      // Back to select, so the shape just drawn can be moved, labelled or resized
      // without a trip to the rail first.
      context.setTool('select')
      context.requestRender()
    },

    cancel(): void {
      origin = null
      preview = null
    },
  }
}
