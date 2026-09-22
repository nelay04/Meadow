/**
 * Place a text object or a sticky note, then edit it immediately.
 *
 * The immediate edit is the point. A text object that appears empty and waits to be
 * double-clicked is two gestures for one intention, and the empty box left behind when
 * someone misses the second gesture is litter that syncs to everyone else.
 *
 * The two types differ in how a drag is interpreted, which follows from what they are.
 * A text object has a width the user cares about and a height derived from its content,
 * so a drag sets the width only. A sticky is a fixed card, so a drag sets both and it
 * keeps whatever box was drawn.
 *
 * A click is the case where nobody chose a width at all, and that is what `autoWidth`
 * is for: the object starts as narrow as a caret and grows with the words. Before it
 * did, one letter sat in a box a couple of hundred units wide, which is a hit area and
 * an arrow target spanning empty canvas either side of the text. A drag is the opposite
 * statement - this wide, wrap inside it - so it turns the flag off.
 */

import {
  STICKY_DEFAULT_SIZE,
  TEXT_DEFAULT_SIZE,
  minimumTextHeight,
  minimumTextWidth,
  textProps,
} from '@meadow/schema'

import type { Point } from '../camera'
import type { CanvasPointerEvent, Tool, ToolContext } from './types'

/** Below this drag distance in world units, treat the gesture as a click. */
const DRAG_THRESHOLD = 6

export type TextToolKind = 'text' | 'sticky'

export function createTextTool(context: ToolContext, kind: TextToolKind): Tool {
  let origin: Point | null = null

  const defaults = kind === 'sticky' ? STICKY_DEFAULT_SIZE : TEXT_DEFAULT_SIZE
  const defaultProps = textProps.parse({})

  const boxFrom = (start: Point, end: Point): { x: number; y: number; w: number; h: number } => {
    const x = Math.min(start.x, end.x)
    const y = Math.min(start.y, end.y)
    const w = Math.abs(end.x - start.x)
    const h = Math.abs(end.y - start.y)

    if (kind === 'sticky') return { x, y, w, h }

    // A dragged text box keeps its width and starts one line tall. The first
    // measurement after mounting grows it to fit whatever gets typed.
    return {
      x,
      y,
      w: Math.max(w, minimumTextWidth(defaultProps)),
      h: minimumTextHeight(defaultProps),
    }
  }

  return {
    id: kind,
    cursor: 'text',

    onPointerDown(event: CanvasPointerEvent): void {
      if (!context.canWrite) return
      origin = event.world
    },

    onPointerMove(): void {
      // Nothing is created until the gesture ends. Unlike a shape, there is no useful
      // preview to draw: an empty text box is an empty rectangle either way, and
      // creating early would put a stray object in the undo history.
    },

    onPointerUp(event: CanvasPointerEvent): void {
      if (origin === null) return

      const start = origin
      origin = null

      const dragged =
        Math.abs(event.world.x - start.x) > DRAG_THRESHOLD ||
        Math.abs(event.world.y - start.y) > DRAG_THRESHOLD

      const box = dragged
        ? boxFrom(start, event.world)
        : {
            // Click places the object with the pointer at its top-left for text, and
            // centred for a sticky. A sticky is a card you drop; a text object is a
            // caret you put somewhere.
            x: kind === 'sticky' ? event.world.x - defaults.w / 2 : event.world.x,
            y: kind === 'sticky' ? event.world.y - defaults.h / 2 : event.world.y,
            // A clicked text box opens at the caret's own width. The overlay measures
            // it on the frame it mounts, so it is never seen at this size for longer
            // than it takes to type the first letter.
            w: kind === 'sticky' ? defaults.w : minimumTextWidth(defaultProps),
            h: kind === 'sticky' ? defaults.h : minimumTextHeight(defaultProps),
          }

      const id = context.createObject({
        type: kind,
        ...box,
        // A note is signed. Stamped at creation because `createdBy` is a user id and
        // nothing can turn one into a name for somebody who has since disconnected.
        props:
          kind === 'sticky'
            ? context.authorName !== ''
              ? { author: context.authorName }
              : {}
            : { autoWidth: !dragged },
      })
      if (id === null) return

      context.commit()
      context.setSelection([id])
      context.beginTextEdit(id)
      context.requestRender()
    },

    cancel(): void {
      origin = null
    },
  }
}
