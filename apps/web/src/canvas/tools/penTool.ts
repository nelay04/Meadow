/**
 * Freehand drawing. ARCHITECTURE 5.
 *
 * Three problems sit between a pointer and a line that looks like it was drawn by a
 * person, and this file is one answer to each.
 *
 * **The pointer is noisy.** Hand tremor and a sampling grid put a wobble on every
 * line, and it is most visible exactly where it matters, on a slow deliberate curve.
 * The pen therefore does not follow the pointer, it chases it: the nib is dragged
 * toward the cursor by a fraction of the gap each sample, which is the same low-pass
 * every drawing app calls streamline. It costs a little lag, and the lag is why the
 * line feels like ink rather than like a mouse trail.
 *
 * **Pressure is often a lie.** A stylus reports what it is being leant on. A mouse
 * reports a constant, and a constant run through a pressure curve is a line of uniform
 * width, which is the flattest a stroke can look. So when the pointer is not a pen,
 * width comes from speed instead: fast is thin, slow is thick, which is what a real
 * nib does because a hand moving fast has less time to press. It is the difference
 * between mouse-drawn ink that reads as handwriting and mouse-drawn ink that reads as
 * a graph.
 *
 * **Frames are slower than hands.** A quick flick between two frames is one straight
 * line if you only read the event that woke you. `usesCoalesced` is how the engine is
 * told to hand over everything the browser buffered instead.
 *
 * The stroke is written to the document once, on pointer up. See `WetInk` in types.ts
 * for why, and for what it costs.
 */

import {
  type FreedrawTip,
  type PenAssist,
  type RecognisedConnector,
  type RecognisedShape,
  TIP_PROFILES,
  arrowGeometry,
  connectorPoints,
  freedrawGeometry,
  nibRadius,
  recogniseStroke,
  tipTakesAssist,
} from '@meadow/schema'

import type { Point } from '../camera'
import { attachArrowEnd } from './binding'
import type { CanvasPointerEvent, Tool, ToolContext, WetInk } from './types'

/**
 * How much of the gap to the cursor the nib closes per sample, 0..1.
 *
 * Lower is smoother and laggier. This is tuned against a fast circle drawn with a
 * mouse: much below 0.4 the ink visibly trails the cursor on a direction change, and
 * much above it the tremor comes back.
 */
const STREAMLINE = 0.46

/** Screen pixels between recorded samples. Below this the shape gains nothing. */
const SAMPLE_SPACING_PX = 1.4

/** Simplification tolerance on commit, in screen pixels at the drawing zoom. */
const SIMPLIFY_PX = 0.5

/**
 * Speed, in screen pixels per millisecond, at which a velocity-driven nib runs out of
 * width. Roughly the speed of a fast confident stroke.
 */
const FAST_PX_PER_MS = 2.6

/** How much of the speed reading to keep per sample, so width does not flicker. */
const VELOCITY_SMOOTHING = 0.7

/**
 * How many extra chase steps to run when the pointer lifts.
 *
 * Enough for the nib to close any gap it can realistically be left with, since each
 * step closes `STREAMLINE` of what remains and the loop stops as soon as it is within
 * a sample's spacing.
 */
const SETTLE_STEPS = 16

/** What a pointer with nothing useful to say is worth. */
const NEUTRAL_PRESSURE = 0.5

/**
 * The shortest stroke the assist will touch, in screen pixels at the drawing zoom.
 *
 * Screen rather than world, because it is a fact about the hand and not about the
 * document: the dot over an i is the same flick of the wrist at any camera. Below this
 * nothing is corrected and nothing is recognised, which is what keeps punctuation from
 * being promoted into lines.
 */
const MIN_ASSIST_PX = 36

/**
 * The stroke width a recognised object inherits from the nib that drew it.
 *
 * The nib's full painted width, so the shape comes out the weight of the line it
 * replaces rather than the schema's default. Clamped because a broad highlighter is
 * six times its nominal size, and a rectangle outlined at fifty units is a filled
 * rectangle with a hole in it.
 */
function inheritedWeight(size: number, tip: FreedrawTip): number {
  return Math.max(1, Math.min(24, nibRadius({ tip, size }) * 2))
}

function simulatedPressure(speed: number): number {
  const from = 1 - Math.min(1, speed / FAST_PX_PER_MS)
  // Squared, so the thick end of the range is reached only by really slowing down.
  // Linear made every ordinary stroke sit in the middle and look uniform anyway.
  return 0.15 + 0.85 * from * from
}

/**
 * Ramer-Douglas-Peucker over a stride-3 sample array.
 *
 * Run once, on commit. Sixty samples a second for four seconds is a stroke with a
 * thousand points in it, and most of them lie on the line between their neighbours;
 * keeping them costs document size, sync bandwidth and tessellation forever, for a
 * shape nobody can tell apart. The tolerance is deliberately well under a pixel at the
 * zoom it was drawn at, so this removes redundancy and never smooths.
 *
 * Pressure rides along with the points that survive rather than being averaged into
 * them: it varies slowly next to position, and a kept sample's own reading is a better
 * answer than a blend of the ones either side of it.
 */
function simplify(points: readonly number[], epsilon: number): number[] {
  const count = points.length / 3
  if (count < 3) return [...points]

  const keep = new Uint8Array(count)
  keep[0] = 1
  keep[count - 1] = 1

  const stack: [number, number][] = [[0, count - 1]]
  while (stack.length > 0) {
    const span = stack.pop()
    if (span === undefined) continue
    const [first, last] = span
    if (last <= first + 1) continue

    const ax = points[first * 3]
    const ay = points[first * 3 + 1]
    const bx = points[last * 3]
    const by = points[last * 3 + 1]
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy

    let worst = -1
    let worstAt = first

    for (let index = first + 1; index < last; index += 1) {
      const px = points[index * 3]
      const py = points[index * 3 + 1]
      const t =
        lengthSquared === 0
          ? 0
          : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
      const distance = Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
      if (distance > worst) {
        worst = distance
        worstAt = index
      }
    }

    if (worst > epsilon) {
      keep[worstAt] = 1
      stack.push([first, worstAt], [worstAt, last])
    }
  }

  const out: number[] = []
  for (let index = 0; index < count; index += 1) {
    if (keep[index] === 0) continue
    out.push(points[index * 3], points[index * 3 + 1], points[index * 3 + 2])
  }
  return out
}

export function createPenTool(context: ToolContext): Tool {
  /** World-space samples of the stroke in progress, flat [x, y, pressure]. */
  let samples: number[] = []
  /** Where the nib is, which is behind the cursor by design. */
  let nib: Point | null = null
  let lastScreen: Point | null = null
  let lastAt = 0
  let speed = 0
  let drawing = false

  const settings = (): WetInk => ({
    points: samples,
    tip: context.pen.tip,
    size: context.pen.size,
    angle: context.pen.angle,
    color: context.pen.color,
  })

  const publish = (): void => {
    context.setWetInk(samples.length >= 3 ? settings() : null)
    context.requestRender()
  }

  const reset = (): void => {
    samples = []
    nib = null
    lastScreen = null
    drawing = false
    speed = 0
    context.setWetInk(null)
  }

  /**
   * What this sample's width should be driven by.
   *
   * A stylus reporting a contact force wins outright; a mouse and a finger fall back
   * to speed. The `pressure > 0` check matters, because a pen event with no contact
   * force reports zero and taking that literally makes the stroke vanish.
   *
   * The choice is made on `pointerType` and nothing else, deliberately. An earlier
   * version also rejected a reading of exactly 0.5, on the theory that a stylus
   * reporting the mouse's constant is not really reporting anything. That is true and
   * it is not worth what it costs: the test is per sample, so a real stylus passing
   * through half pressure mid-stroke switched to the velocity curve for one sample and
   * put a visible notch in the line. A stylus that reports a constant draws a line of
   * constant width, which is what that hardware is telling us.
   */
  const pressureFor = (event: CanvasPointerEvent): number => {
    if (event.pointerType === 'pen' && event.pressure > 0) return event.pressure
    if (TIP_PROFILES[context.pen.tip].thinning === 0) return NEUTRAL_PRESSURE
    return simulatedPressure(speed)
  }

  const track = (event: CanvasPointerEvent): void => {
    const now = performance.now()
    if (lastScreen !== null) {
      const elapsed = Math.max(1, now - lastAt)
      const moved = Math.hypot(event.screen.x - lastScreen.x, event.screen.y - lastScreen.y)
      // Exponentially smoothed, because a single slow frame reads as a stop and a
      // stroke that fattens once per stutter looks like a fault rather than a hand.
      speed = speed * VELOCITY_SMOOTHING + (moved / elapsed) * (1 - VELOCITY_SMOOTHING)
    }
    lastScreen = event.screen
    lastAt = now
  }

  const extend = (event: CanvasPointerEvent): void => {
    if (nib === null) return
    track(event)

    nib = {
      x: nib.x + (event.world.x - nib.x) * STREAMLINE,
      y: nib.y + (event.world.y - nib.y) * STREAMLINE,
    }

    const spacing = context.camera.toWorldDistance(SAMPLE_SPACING_PX)
    const last = samples.length - 3
    if (last >= 0 && Math.hypot(nib.x - samples[last], nib.y - samples[last + 1]) < spacing) return

    samples.push(nib.x, nib.y, pressureFor(event))
  }

  /**
   * Land the stroke where the pointer actually lifted.
   *
   * The nib chases the cursor, so at the moment the button comes up it is still short
   * of it, by more the faster the hand was moving. Committing there ends every stroke
   * before where the person stopped, which is invisible on a long sweep and glaring on
   * a tick, a full stop, or the tail of a letter. So the same chase is run on until it
   * arrives, and the last sample is the pointer's own position rather than the nib's:
   * the end of a stroke is not a place to be approximate about.
   */
  const settle = (event: CanvasPointerEvent): void => {
    if (nib === null) return
    const spacing = context.camera.toWorldDistance(SAMPLE_SPACING_PX)
    const pressure = pressureFor(event)

    let x = nib.x
    let y = nib.y
    for (let step = 0; step < SETTLE_STEPS; step += 1) {
      const dx = event.world.x - x
      const dy = event.world.y - y
      if (Math.hypot(dx, dy) <= spacing) break
      x += dx * STREAMLINE
      y += dy * STREAMLINE
      samples.push(x, y, pressure)
    }

    nib = { x, y }
    samples.push(event.world.x, event.world.y, pressure)
  }

  /** How much of what was drawn the assist is allowed to read, in world units. */
  const assistFloor = (): number => context.camera.toWorldDistance(MIN_ASSIST_PX)

  /**
   * What the assist is actually set to for the nib in hand.
   *
   * The rail hides the choice on the three nibs that do not take it, and this is the
   * other half of that: the setting outlives the session and the nib can change under
   * it, so a pen remembered on `shapes` and then switched to a highlighter has to draw
   * a highlighter sweep rather than quietly go on making rectangles.
   */
  const assistMode = (): PenAssist =>
    tipTakesAssist(context.pen.tip) ? context.pen.assist : 'off'

  /**
   * The style a recognised object takes from the pen that drew it.
   *
   * `tidy` only. Weight and colour follow the nib, because in that mode the object is
   * standing in for a mark that was made with it: what the person asked for was their
   * own drawing with the crookedness taken out, and a rectangle arriving in the
   * schema's default grey is not that. Colour is written only when they chose one, the
   * same rule the ink itself follows, so a shape drawn with the default pen still
   * answers to the theme.
   */
  const inheritedStyle = (): Record<string, unknown> => {
    const props: Record<string, unknown> = {
      strokeWidth: inheritedWeight(context.pen.size, context.pen.tip),
      // Unfilled, because what was drawn was an outline. A shape that arrived with the
      // default card fill would hide whatever it was drawn around, which on a
      // hand-annotated board is usually the reason a ring was drawn round it.
      fillAlpha: 0,
    }
    if (context.pen.color !== null) props.stroke = context.pen.color
    return props
  }

  /**
   * What `shapes` writes instead: nothing.
   *
   * A shape drawn with the rail carries no style of its own either, which is what lets
   * `resolveStyle` give it the surface's own fill and outline in both themes. Writing
   * the pen's colour here would produce something that merely resembled a shape from
   * the rail and then diverged from it the moment somebody switched theme, so the mode
   * that promises the board's own shape has to promise it exactly.
   */
  const templateStyle = (): Record<string, unknown> => ({})

  const createShape = (shape: RecognisedShape, style: Record<string, unknown>): boolean => {
    const id = context.createObject({
      type: shape.type,
      x: shape.x,
      y: shape.y,
      w: shape.w,
      h: shape.h,
      props: style,
    })
    if (id === null) return false
    context.setSelection([id])
    return true
  }

  const createConnector = (
    connector: RecognisedConnector,
    style: Record<string, unknown>,
  ): boolean => {
    const absolute = connectorPoints(connector)
    const geometry = arrowGeometry(absolute, connector)
    // A head at either end makes it an arrow. Nothing at either end is a line, which
    // is a real distinction in the schema rather than a default: a line has no heads
    // to lose when it is restyled.
    const headed = connector.startHead || connector.endHead

    const id = context.createObject({
      type: headed ? 'arrow' : 'line',
      x: geometry.x,
      y: geometry.y,
      w: geometry.w,
      h: geometry.h,
      props: {
        ...style,
        points: geometry.points,
        routing: connector.routing,
        curvature: connector.curvature,
        curvatureEnd: connector.curvatureEnd,
        elbow: connector.elbow,
        // Which ends have heads is not styling, it is what was drawn, so both modes
        // write it. An arrow with its head at the start would otherwise come out of
        // `shapes` with the default head at the wrong end.
        startHead: connector.startHead ? 'open' : 'none',
        endHead: connector.endHead ? 'open' : 'none',
      },
    })
    if (id === null) return false

    // Attached to whatever the two ends landed on, on exactly the terms the arrow tool
    // uses. An arrow drawn between two boxes with the pen has to behave like an arrow
    // drawn between them with the arrow tool, or the recognition is a trick rather
    // than a feature: the boxes move and the connector stays put.
    attachArrowEnd(context, id, 'start', connector.start)
    attachArrowEnd(context, id, 'end', connector.end)
    // Re-solved once the ends are bound, because an elbow's waypoints are stored and
    // binding has just moved the points they were generated from.
    context.setArrowRouting(id, {
      routing: connector.routing,
      curvature: connector.curvature,
      curvatureEnd: connector.curvatureEnd,
      elbow: connector.elbow,
    })

    context.setSelection([id])
    return true
  }

  /**
   * Replace the stroke with the object it was, or leave it alone.
   *
   * False is the ordinary answer for anybody writing rather than drawing, and the
   * caller keeps the ink when it comes. Nothing here refuses quietly and then creates
   * something approximate: an object that is not what was drawn is worse than the
   * stroke it replaced, because the stroke was at least honest.
   */
  const commitRecognised = (drawn: readonly number[], mode: PenAssist): boolean => {
    const recognition = recogniseStroke(drawn, { minLength: assistFloor() })
    if (recognition === null) return false

    const style = mode === 'shapes' ? templateStyle() : inheritedStyle()
    return recognition.kind === 'shape'
      ? createShape(recognition, style)
      : createConnector(recognition, style)
  }

  return {
    id: 'pen',
    // A crosshair, not a pointer. The nib is at the centre of the cross, and on a
    // surface where the mark lands exactly where you aimed that has to be visible.
    cursor: 'crosshair',
    usesCoalesced: true,

    onPointerDown(event: CanvasPointerEvent): void {
      if (!context.canWrite) return
      drawing = true
      samples = []
      nib = event.world
      lastScreen = event.screen
      lastAt = performance.now()
      // Starting at zero would make every stroke begin thick, since zero speed is the
      // slowest possible hand. Start neutral and let the first few samples decide.
      speed = FAST_PX_PER_MS * 0.35
      samples.push(event.world.x, event.world.y, pressureFor(event))
      publish()
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (!drawing) return
      extend(event)
      publish()
    },

    onPointerUp(event: CanvasPointerEvent): void {
      if (!drawing) return
      extend(event)
      settle(event)

      const drawn = samples
      const assist = assistMode()
      reset()

      if (drawn.length < 3) {
        context.requestRender()
        return
      }

      // Refusing is the common answer and the important one. When the stroke was not
      // any of the objects the board has, it stays exactly the ink that was drawn:
      // there is no half measure that smooths it on the way past, because a stroke
      // nobody asked to have redrawn is one that should come out as it went in.
      if (assist !== 'off' && commitRecognised(drawn, assist)) {
        context.commit()
        context.requestRender()
        return
      }

      const points = simplify(drawn, context.camera.toWorldDistance(SIMPLIFY_PX))

      const geometry = freedrawGeometry(points, context.pen)
      const props: Record<string, unknown> = {
        points: geometry.points,
        tip: context.pen.tip,
        size: context.pen.size,
        angle: context.pen.angle,
      }
      // Written only when the person chose one. A stroke with no colour of its own
      // follows the surface's ink in both themes, the same rule an unrestyled
      // connector follows, so a board drawn on in the light theme is not black ink on
      // a dark ground the next morning.
      if (context.pen.color !== null) props.stroke = context.pen.color

      context.createObject({
        type: 'freedraw',
        x: geometry.x,
        y: geometry.y,
        w: geometry.w,
        h: geometry.h,
        props,
      })

      // One stroke, one undo step. Not one gesture per drawing: undoing a sketch a
      // stroke at a time is what a person means by undo here.
      context.commit()

      // And the pen stays the pen. Every other creation tool hands back to select
      // once it has made something, because you almost always want to adjust what you
      // just drew. Drawing is the exception and it is not close: nobody draws one
      // stroke, and a pen that had to be picked up again after each one would be
      // unusable. Press V or Escape to stop.
      context.requestRender()
    },

    onKeyDown(event: KeyboardEvent): void {
      if (event.key !== 'Escape' || !drawing) return
      // Abandon the stroke rather than committing half of it. The engine's own Escape
      // handler calls `cancel` for the same reason; this is here for the case where
      // the key arrives while the pointer is still down.
      reset()
      context.requestRender()
    },

    cancel(): void {
      reset()
    },
  }
}
