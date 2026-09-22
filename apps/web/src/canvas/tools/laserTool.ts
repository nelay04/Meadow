/**
 * The laser. ARCHITECTURE 5.
 *
 * The thinnest tool on the rail, and deliberately: everything that makes a laser look
 * like one - the fade, the taper, the trail's lifetime - lives in the engine, because
 * it has to go on happening after this tool has stopped being told anything. A tool
 * only ever hears about the pointer, and a trail that decays for three quarters of a
 * second after the pointer lifts has nobody to tell it to.
 *
 * So this forwards samples and holds one boolean: whether the button is down, which the
 * engine cannot see and needs, since a laser held still over one word sends no events
 * and must not go out. It writes nothing, which is what makes it the one drawing tool a
 * viewer is given: `pushLaser` goes to presence and transient engine state, never
 * through `doc/mutations`, so there is no write for a role check to refuse.
 *
 * It does not chase the pointer the way the pen does. Streamline exists to take hand
 * tremor out of a mark somebody is going to look at afterwards; a laser is looked at
 * while it is moving and is gone a moment later, and the lag would be the only part of
 * it anybody noticed.
 */

import type { CanvasPointerEvent, Tool, ToolContext } from './types'

export function createLaserTool(context: ToolContext): Tool {
  let pointing = false

  return {
    id: 'laser',
    // A crosshair rather than the arrow: the tool is aiming, and the system cursor is
    // still drawn over the dot, so it may as well say so.
    cursor: 'crosshair',

    // The trail is the shape of the gesture, not a sample of it. A flick between two
    // frames is a straight line across the board if only the waking event is read,
    // which is the same reason the pen asks for these.
    usesCoalesced: true,

    onPointerDown(event: CanvasPointerEvent): void {
      pointing = true
      // Seeded on the press, so a tap with no movement still puts a dot on the board.
      // Pointing at something without waving at it is most of what a laser is for.
      context.pushLaser(event.world)
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (!pointing) return
      context.pushLaser(event.world)
    },

    onPointerUp(): void {
      pointing = false
      // Not a clear: the trail goes on fading on its own clock, and cutting it off
      // here would make every mark end in a hard stop. What this says is only that
      // nobody is holding the head still any more, so it may start ageing.
      context.pushLaser(null)
    },

    cancel(): void {
      if (!pointing) return
      pointing = false
      // Switching tools mid-mark leaves the trail to fade, for the same reason a
      // pointer-up does, but the head has to be released or it would hang on the
      // board until something else happened to touch the laser.
      context.pushLaser(null)
    },
  }
}
