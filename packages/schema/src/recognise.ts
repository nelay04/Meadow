/**
 * What the stroke was meant to be. ARCHITECTURE 5.
 *
 * A pen puts down exactly what the hand did, and most of the time that is what a pen
 * is for. The rest of the time somebody is drawing a box, and a hand-drawn box on a
 * diagram is a box that cannot be resized, cannot carry a label, and does not line up
 * with the one above it. This file is the bridge: it reads a finished stroke and says
 * either "that was a rectangle" or "that was an arrow with an elbow in it", precisely
 * enough that the tool can replace the ink with the real object.
 *
 * One question, asked once. The pen offers two degrees of assistance and they differ
 * only in what the tool does with the answer, never in the answer itself: `tidy` makes
 * the object and leaves it looking like the mark it replaced, and `shapes` makes the
 * same object with the board's own styling, indistinguishable from one drawn with the
 * rail. Two recognisers for those two would be two sets of thresholds to keep in step,
 * and the first stroke they disagreed about would be a bug nobody could describe.
 *
 * ### Why the shape test is a fit rather than a feature count
 *
 * The obvious classifier counts corners: four means a rectangle, none means an
 * ellipse. It is also the one that fails on real strokes, because a corner count is a
 * threshold on a threshold. A rounded rectangle has four soft corners, a hurried
 * circle has two sharp ones where the hand changed direction, and a diamond and a
 * square have the same four corners in different places, so the count has to be
 * propped up by more tests until nobody can say why any given stroke was classified
 * the way it was.
 *
 * So instead every candidate is built at the size the stroke actually has, and the one
 * whose outline the stroke sits closest to wins. That is the question being asked,
 * asked directly: which of these shapes did they draw. It reads the same for every
 * candidate, it degrades honestly - a scribble is far from all four and is refused -
 * and adding a shape to the family means adding its outline here and nothing else.
 *
 * The candidates are built from the same geometry the renderer uses, `parallelogramSlant`
 * included, so recognition cannot drift from what gets drawn afterwards.
 *
 * ### Why open strokes are handled by structure instead
 *
 * A connector has no area to fit, so the fit has nothing to measure. What separates a
 * line from an elbow from a curve is where the direction changes along the path, which
 * is exactly what a corner scan finds, and the barbs of a hand-drawn arrowhead are the
 * same signal read at the ends. Nothing here is a template match, because a connector
 * has no fixed proportions to match against.
 */

import { elbowFor, routeOrthogonal } from './arrowBinding'
import { type ArrowRouting, CURVE_HANDLE_TS, curvatureAt } from './arrows'
import { FREEDRAW_STRIDE, type FreedrawTip } from './freedraw'
import {
  type RecognisableShape,
  RECOGNISABLE_SHAPES,
  parallelogramSlant,
  trapezoidInset,
} from './objects'

/**
 * How much the pen is allowed to change what was drawn.
 *
 * A setting on the tool rather than on the stroke, like the nib is: it decides what
 * gets made, and once something is made it is that thing. `off` is the default and
 * stays the default, because a pen that silently rewrites what you drew the first time
 * you use it is a pen nobody trusts afterwards.
 *
 * The other two both replace the ink with the object it was. They differ in what that
 * object looks like: `tidy` keeps the pen's own colour and weight, so a sketch stays a
 * sketch and merely stops being crooked, while `shapes` gives it the styling the rail
 * gives a shape drawn with the shape tool, which is the point at which a drawing
 * becomes a diagram.
 */
export const PEN_ASSIST = ['off', 'tidy', 'shapes'] as const
export type PenAssist = (typeof PEN_ASSIST)[number]

/**
 * The nibs the assist is offered on.
 *
 * A ballpoint and a fineliner, and nothing else. The other three nibs exist because of
 * what they do to a line: a calligraphy nib is broad one way and a hairline the other,
 * a brush tapers, a highlighter is a translucent sweep. Nobody reaches for one of those
 * to draw a rectangle with, and a highlighter sweep turned into a rectangle has thrown
 * away the only reason it was drawn with a highlighter. So the assist is offered where
 * the nib is a plain line, and withheld where the nib is the point.
 *
 * Enforced in the tool as well as hidden in the rail: the setting is remembered across
 * sessions, so the nib can change under it.
 */
const ASSISTED_TIPS: ReadonlySet<string> = new Set<FreedrawTip>(['round', 'felt'])

export function tipTakesAssist(tip: FreedrawTip): boolean {
  return ASSISTED_TIPS.has(tip)
}

/** A stroke that was a predefined shape, at the size it was drawn. */
export type RecognisedShape = {
  kind: 'shape'
  type: RecognisableShape
  x: number
  y: number
  w: number
  h: number
}

/**
 * A stroke that was a connector.
 *
 * `start` and `end` are the two ends in world space and everything else says how the
 * line between them runs, which is exactly what the arrow schema stores. The caller
 * routes it, because routing an elbow is `routeOrthogonal` and there is no reason for
 * a second copy of it here.
 */
export type RecognisedConnector = {
  kind: 'connector'
  start: { x: number; y: number }
  end: { x: number; y: number }
  routing: ArrowRouting
  curvature: number
  curvatureEnd: number
  elbow: number
  /** Whether a hand-drawn head was found at each end. Neither one means it is a line. */
  startHead: boolean
  endHead: boolean
}

export type Recognition = RecognisedShape | RecognisedConnector

export type AssistOptions = {
  /**
   * The shortest stroke worth reading, in world units.
   *
   * The caller passes a screen distance converted at the drawing zoom, because this is
   * about what the hand was doing rather than about the document: a dot over an i and
   * a full stop are strokes a few pixels long whatever the camera is, and turning
   * either into a line is the single most annoying thing a recogniser can do.
   */
  minLength: number
}

// --- path plumbing ------------------------------------------------------------
//
// Everything below works on a resampled path with points spaced evenly along the arc,
// never on the raw samples. Even spacing is what lets a window of n points mean a
// fixed fraction of the stroke, and every threshold here is written as a fraction, so
// the same stroke drawn slowly and quickly reads the same.

type Path = { xs: number[]; ys: number[] }

type Box = { x: number; y: number; w: number; h: number }

/** Points the stroke is resampled to. Enough to hold a corner, few enough to be free. */
const SAMPLES = 64

/** Two samples closer than this in world units are the same place. */
const EPSILON = 1e-6

function strokePath(points: readonly number[]): Path {
  const xs: number[] = []
  const ys: number[] = []
  for (let index = 0; index + FREEDRAW_STRIDE <= points.length; index += FREEDRAW_STRIDE) {
    const x = points[index]
    const y = points[index + 1]
    const last = xs.length - 1
    if (last >= 0 && Math.abs(x - xs[last]) < EPSILON && Math.abs(y - ys[last]) < EPSILON) continue
    xs.push(x)
    ys.push(y)
  }
  return { xs, ys }
}

function pathLength(path: Path): number {
  let total = 0
  for (let index = 1; index < path.xs.length; index += 1) {
    total += Math.hypot(path.xs[index] - path.xs[index - 1], path.ys[index] - path.ys[index - 1])
  }
  return total
}

/** Evenly spaced points along the path, first and last preserved exactly. */
function resample(path: Path, count: number): Path {
  const total = pathLength(path)
  const last = path.xs.length - 1
  if (last < 1 || total < EPSILON) return { xs: [...path.xs], ys: [...path.ys] }

  const step = total / (count - 1)
  const xs = [path.xs[0]]
  const ys = [path.ys[0]]

  let index = 0
  let walked = 0
  for (let sample = 1; sample < count - 1; sample += 1) {
    const target = step * sample
    while (index < last) {
      const span = Math.hypot(path.xs[index + 1] - path.xs[index], path.ys[index + 1] - path.ys[index])
      if (walked + span >= target || index === last - 1) {
        const t = span < EPSILON ? 0 : (target - walked) / span
        xs.push(path.xs[index] + (path.xs[index + 1] - path.xs[index]) * t)
        ys.push(path.ys[index] + (path.ys[index + 1] - path.ys[index]) * t)
        break
      }
      walked += span
      index += 1
    }
  }

  xs.push(path.xs[last])
  ys.push(path.ys[last])
  return { xs, ys }
}

function boundsOf(path: Path): Box {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let index = 0; index < path.xs.length; index += 1) {
    if (path.xs[index] < minX) minX = path.xs[index]
    if (path.ys[index] < minY) minY = path.ys[index]
    if (path.xs[index] > maxX) maxX = path.xs[index]
    if (path.ys[index] > maxY) maxY = path.ys[index]
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** A point a fraction of the way along an evenly resampled path. */
function pointAt(path: Path, fraction: number): { x: number; y: number } {
  const last = path.xs.length - 1
  const position = Math.max(0, Math.min(last, fraction * last))
  const index = Math.min(last - 1, Math.floor(position))
  const t = position - index
  return {
    x: path.xs[index] + (path.xs[index + 1] - path.xs[index]) * t,
    y: path.ys[index] + (path.ys[index + 1] - path.ys[index]) * t,
  }
}

function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared < EPSILON) return Math.hypot(px - ax, py - ay)
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared))
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy))
}

/** Distance from a point to a flat [x,y,...] outline, closed or open. */
function distanceToOutline(px: number, py: number, outline: readonly number[], closed: boolean): number {
  let best = Infinity
  for (let index = 0; index + 3 < outline.length; index += 2) {
    const distance = distanceToSegment(
      px,
      py,
      outline[index],
      outline[index + 1],
      outline[index + 2],
      outline[index + 3],
    )
    if (distance < best) best = distance
  }
  if (closed && outline.length >= 4) {
    const tail = outline.length - 2
    const distance = distanceToSegment(px, py, outline[tail], outline[tail + 1], outline[0], outline[1])
    if (distance < best) best = distance
  }
  return best
}

// --- corners ------------------------------------------------------------------

/**
 * Where the direction changes sharply, as indices into the path.
 *
 * The turn at a point is measured between the chord coming into it and the chord
 * leaving it, each spanning `WINDOW` of the stroke rather than a single sample. Over
 * one sample the measurement is all tremor: a slow hand on a straight line registers
 * larger angles than a fast hand rounding a corner. Over a window it is the shape.
 *
 * Then only local maxima survive, one per window, because a real corner is drawn over
 * several samples and would otherwise be reported as a cluster of five corners that no
 * count-based test could interpret.
 */
const WINDOW = 0.07

/** Below this turn in radians, a bend is a curve rather than a corner. Thirty-four degrees. */
const CORNER_TURN = 0.6

/**
 * A copy of the path with the tremor taken out, for measuring only.
 *
 * Direction is a derivative, and the derivative of a noisy signal is noise. A hand's
 * wobble of a few units over a window of twenty reads as a thirty degree turn, which
 * is most of a corner, so a scan run straight on the samples reports corners all along
 * a line somebody drew straight. Structure is measured here and acted on there: what
 * comes back is indices into the original, and nothing the caller keeps has been
 * smoothed behind its back.
 */
function relaxed(path: Path, passes: number): Path {
  const xs = [...path.xs]
  const ys = [...path.ys]
  for (let pass = 0; pass < passes; pass += 1) {
    const fromX = [...xs]
    const fromY = [...ys]
    for (let index = 1; index + 1 < xs.length; index += 1) {
      xs[index] = fromX[index] + ((fromX[index - 1] + fromX[index + 1]) / 2 - fromX[index]) * 0.5
      ys[index] = fromY[index] + ((fromY[index - 1] + fromY[index + 1]) / 2 - fromY[index]) * 0.5
    }
  }
  return { xs, ys }
}

/** How much the copy the corner scan measures is smoothed first. */
const CORNER_SMOOTHING = 3

function cornerIndices(source: Path, closed: boolean): number[] {
  const count = source.xs.length
  const span = Math.max(2, Math.round(count * WINDOW))
  if (count < span * 2 + 1) return []

  const path = relaxed(source, CORNER_SMOOTHING)
  const turns = new Float64Array(count)
  const first = closed ? 0 : span
  const last = closed ? count - 1 : count - 1 - span

  for (let index = first; index <= last; index += 1) {
    const back = closed ? (index - span + count) % count : index - span
    const forward = closed ? (index + span) % count : index + span
    const ax = path.xs[index] - path.xs[back]
    const ay = path.ys[index] - path.ys[back]
    const bx = path.xs[forward] - path.xs[index]
    const by = path.ys[forward] - path.ys[index]
    if (Math.hypot(ax, ay) < EPSILON || Math.hypot(bx, by) < EPSILON) continue
    // Signed cross and dot rather than two atan2s: the angle between is what is
    // wanted, and this gives it without either branch wrapping at pi.
    turns[index] = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))
  }

  const ranked: number[] = []
  for (let index = first; index <= last; index += 1) {
    if (turns[index] >= CORNER_TURN) ranked.push(index)
  }
  ranked.sort((a, b) => turns[b] - turns[a])

  const kept: number[] = []
  for (const index of ranked) {
    const clash = kept.some((other) => {
      const gap = Math.abs(other - index)
      return (closed ? Math.min(gap, count - gap) : gap) < span
    })
    if (!clash) kept.push(index)
  }

  return kept.sort((a, b) => a - b)
}

/** How far a run of the path strays from the straight line between its two ends. */
function straightness(path: Path, from: number, to: number): number {
  const ax = path.xs[from]
  const ay = path.ys[from]
  const bx = path.xs[to]
  const by = path.ys[to]
  const chord = Math.hypot(bx - ax, by - ay)
  if (chord < EPSILON) return Infinity

  let worst = 0
  for (let index = from + 1; index < to; index += 1) {
    const distance = distanceToSegment(path.xs[index], path.ys[index], ax, ay, bx, by)
    if (distance > worst) worst = distance
  }
  return worst / chord
}

// --- closed strokes -----------------------------------------------------------

/** Points an ellipse candidate is flattened to. Fine enough that the fit is the shape. */
const ELLIPSE_SEGMENTS = 48

/**
 * The outline of a candidate shape at a given size, in world space.
 *
 * The one place a candidate's geometry is written. The parallelogram and the trapezoid
 * are the two whose shape is not implied by their box, and both read the same constant
 * the renderer's SDF and the hit test do, so the three agree by construction rather
 * than by having been checked once.
 */
function shapeOutline(type: RecognisableShape, box: Box): number[] {
  const { x, y, w, h } = box
  switch (type) {
    case 'rect':
      return [x, y, x + w, y, x + w, y + h, x, y + h]
    case 'diamond':
      return [x + w / 2, y, x + w, y + h / 2, x + w / 2, y + h, x, y + h / 2]
    case 'parallelogram': {
      // Top edge pushed right, bottom edge left, matching the lean `parallelogramSlant`
      // gives the hit test and the SDF.
      const slant = parallelogramSlant(w, h)
      return [x + slant, y, x + w, y, x + w - slant, y + h, x, y + h]
    }
    case 'triangle':
      // Apex centred on the top edge, base spanning the full width.
      return [x + w / 2, y, x + w, y + h, x, y + h]
    case 'trapezoid': {
      // Wider at the bottom, narrower at the top, each side of the top edge stepped in
      // by the inset.
      const inset = trapezoidInset(w, h)
      return [x + inset, y, x + w - inset, y, x + w, y + h, x, y + h]
    }
    case 'ellipse': {
      const out: number[] = []
      for (let step = 0; step < ELLIPSE_SEGMENTS; step += 1) {
        const angle = (step / ELLIPSE_SEGMENTS) * Math.PI * 2
        out.push(x + w / 2 + Math.cos(angle) * (w / 2), y + h / 2 + Math.sin(angle) * (h / 2))
      }
      return out
    }
  }
}

/**
 * How badly a stroke misses a candidate, as a fraction of the box's diagonal.
 *
 * Mean rather than worst distance. A single wild sample - the hook where somebody
 * lifted the pen - would dominate a worst-case measure and reject a shape that reads
 * perfectly well as the thing it is.
 */
function outlineError(path: Path, outline: readonly number[], diagonal: number): number {
  let total = 0
  for (let index = 0; index < path.xs.length; index += 1) {
    total += distanceToOutline(path.xs[index], path.ys[index], outline, true)
  }
  return total / path.xs.length / diagonal
}

/**
 * How far from its candidate a stroke may sit and still be that shape.
 *
 * Seven per cent of the diagonal, averaged over the whole path, is a lot of slack, and
 * deliberately: this is the mean and the winner is already the closest candidate, so
 * the threshold is not deciding between shapes. It is deciding whether a scribble gets
 * turned into a rectangle, and that is the only thing it has to get right.
 */
const SHAPE_TOLERANCE = 0.07

/**
 * The aspect ratio within which a shape is taken to be regular.
 *
 * Nobody draws a square square. A box drawn a tenth wider than it is tall was almost
 * certainly meant to be square, and half the value of snapping to real shapes is that
 * the results line up with each other afterwards.
 */
const REGULAR_ASPECT = 0.9

function regularise(box: Box): Box {
  const shorter = Math.min(box.w, box.h)
  const longer = Math.max(box.w, box.h)
  if (longer < EPSILON || shorter / longer < REGULAR_ASPECT) return box

  const side = (box.w + box.h) / 2
  return {
    x: box.x + (box.w - side) / 2,
    y: box.y + (box.h - side) / 2,
    w: side,
    h: side,
  }
}

function recogniseClosed(path: Path): Recognition | null {
  const box = boundsOf(path)
  const diagonal = Math.hypot(box.w, box.h)
  if (diagonal < EPSILON) return null

  let best: RecognisableShape | null = null
  let bestError = Infinity
  for (const type of RECOGNISABLE_SHAPES) {
    const error = outlineError(path, shapeOutline(type, box), diagonal)
    if (error < bestError) {
      bestError = error
      best = type
    }
  }

  if (best === null || bestError > SHAPE_TOLERANCE) return null

  // A very flat closed stroke is a scribble through something, not a shape. The fit
  // would happily call it a rectangle, because at that aspect every candidate collapses
  // onto the same thin bar and the winner is arbitrary.
  if (Math.min(box.w, box.h) < diagonal * 0.06) return null

  const sized = regularise(box)
  return { kind: 'shape', type: best, x: sized.x, y: sized.y, w: sized.w, h: sized.h }
}

// --- open strokes -------------------------------------------------------------

/**
 * The turn that makes a bend a barb rather than a corner, in radians.
 *
 * A hundred degrees. An arrowhead doubles back on the shaft, so its barbs turn through
 * far more than a right angle, and an elbow turns through exactly one. The gap between
 * the two is what keeps a right-angled connector from being read as an arrowhead with
 * no shaft.
 */
const BARB_TURN = 1.75

/** How much of the end of a stroke is searched for a head, as a fraction of its length. */
const HEAD_WINDOW = 0.3

/** The shortest a head may be, so a wobble at the end of a line is not an arrowhead. */
const MIN_HEAD_LENGTH = 0.04

/**
 * How far a head may reach from where it leaves the shaft, against the shaft's own
 * length.
 *
 * The test that separates an arrowhead from a stroke that merely ends in a hook. A
 * head is a small thing on the end of a long thing: a barb a third as long as the line
 * it sits on is not an arrowhead, it is half of whatever was actually drawn, and
 * cutting it off would silently throw the drawing away.
 */
const HEAD_REACH = 0.3

/**
 * Where the arrowhead at the end of the path begins, or null.
 *
 * The turn is measured between the run arriving at a candidate point and the straight
 * line from there to the very end of the stroke, rather than a window either side. A
 * head is drawn without lifting the pen - along the shaft, out to one barb, back to
 * the tip, out to the other - so every leg of it doubles back, and measuring against
 * the end catches the first of them as readily as the last.
 *
 * The *earliest* qualifying junction wins, which is what makes this one cut rather
 * than a trim repeated until nothing matches. Repeating it was the first version, and
 * it is how a recogniser talks itself into an answer: each pass ate one hump of a
 * wave, and four passes turned a scribble into a confident arrow.
 */
function headStartsAt(path: Path, totalLength: number): number | null {
  const count = path.xs.length
  const span = Math.max(2, Math.round(count * WINDOW))
  if (count < span + 3) return null

  const endX = path.xs[count - 1]
  const endY = path.ys[count - 1]

  let found: number | null = null
  let tail = 0
  // Backwards, so the last candidate accepted is the earliest one in the tail.
  for (let index = count - 2; index > span; index -= 1) {
    tail += Math.hypot(path.xs[index + 1] - path.xs[index], path.ys[index + 1] - path.ys[index])
    if (tail > totalLength * HEAD_WINDOW) break
    if (tail < totalLength * MIN_HEAD_LENGTH) continue

    const ax = path.xs[index] - path.xs[index - span]
    const ay = path.ys[index] - path.ys[index - span]
    const bx = endX - path.xs[index]
    const by = endY - path.ys[index]
    if (Math.hypot(ax, ay) < EPSILON || Math.hypot(bx, by) < EPSILON) continue

    const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))
    if (turn > BARB_TURN) found = index
  }

  return found
}

function slice(path: Path, from: number, to: number): Path {
  return { xs: path.xs.slice(from, to + 1), ys: path.ys.slice(from, to + 1) }
}

function reversed(path: Path): Path {
  return { xs: [...path.xs].reverse(), ys: [...path.ys].reverse() }
}

/**
 * Cut any arrowhead off one end.
 *
 * `tip` is where the arrow actually points, which is not where the shaft was cut. The
 * cut is deliberately made early, back where the head can no longer be confused with
 * the line, and an arrow that ended there would stop visibly short of what was aimed
 * at. The tip is the far point of the head instead, measured from the other end of the
 * stroke, which is the point of an arrowhead in both senses.
 */
type Split = { path: Path; head: boolean; tip: { x: number; y: number } | null }

function splitHead(path: Path, totalLength: number): Split {
  const at = headStartsAt(path, totalLength)
  if (at === null) return { path, head: false, tip: null }

  let reach = 0
  for (let index = at + 1; index < path.xs.length; index += 1) {
    const distance = Math.hypot(path.xs[index] - path.xs[at], path.ys[index] - path.ys[at])
    if (distance > reach) reach = distance
  }

  const shaft = slice(path, 0, at)
  if (reach > pathLength(shaft) * HEAD_REACH) return { path, head: false, tip: null }

  let tip = { x: path.xs[at], y: path.ys[at] }
  let farthest = -1
  for (let index = at; index < path.xs.length; index += 1) {
    const distance = Math.hypot(path.xs[index] - path.xs[0], path.ys[index] - path.ys[0])
    if (distance > farthest) {
      farthest = distance
      tip = { x: path.xs[index], y: path.ys[index] }
    }
  }

  return { path: shaft, head: true, tip }
}

/** Below this deviation from its own chord, as a fraction of it, a run is straight. */
const STRAIGHT = 0.045

/** A turn this close to a right angle, in radians, is one an elbow can be made of. */
const RIGHT_ANGLE_SLACK = 0.55

/** How far off an axis a straight stroke may be and still be snapped onto it. */
const AXIS_SNAP = 0.13

/**
 * Snap a nearly-axis-aligned or nearly-diagonal line onto the exact angle.
 *
 * The end moves, not the start: a line is drawn from somewhere to somewhere, and the
 * first of those is the one the person aimed. The length is kept, so a snap changes
 * the angle and nothing else.
 */
function snapAngle(start: { x: number; y: number }, end: { x: number; y: number }) {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const length = Math.hypot(dx, dy)
  if (length < EPSILON) return end

  const angle = Math.atan2(dy, dx)
  const step = Math.PI / 4
  const nearest = Math.round(angle / step) * step
  if (Math.abs(angle - nearest) > AXIS_SNAP) return end

  return { x: start.x + Math.cos(nearest) * length, y: start.y + Math.sin(nearest) * length }
}

function recogniseOpen(path: Path, totalLength: number): Recognition | null {
  // Both ends, so an arrow drawn right to left is the same arrow, and one with a head
  // at each end is read as one rather than as a line.
  const fromEnd = splitHead(path, totalLength)
  const fromStart = splitHead(reversed(fromEnd.path), totalLength)
  const shaft = reversed(fromStart.path)

  if (shaft.xs.length < 4) return null

  const last = shaft.xs.length - 1
  const start = fromStart.tip ?? { x: shaft.xs[0], y: shaft.ys[0] }
  const end = fromEnd.tip ?? { x: shaft.xs[last], y: shaft.ys[last] }
  const heads = { startHead: fromStart.head, endHead: fromEnd.head }

  const bends = cornerIndices(shaft, false)

  if (bends.length === 0) {
    const deviation = straightness(shaft, 0, last)

    if (deviation <= STRAIGHT) {
      return {
        kind: 'connector',
        start,
        end: snapAngle(start, end),
        routing: 'straight',
        curvature: 0,
        curvatureEnd: 0,
        elbow: 0.5,
        ...heads,
      }
    }

    // A bow, not a corner. Anything this bent is a loop or a scrawl rather than a
    // connector, and calling it an arrow would hide most of what was drawn.
    if (deviation > 0.75) return null

    /*
     * Both bows solved against the curve the schema will actually draw, by the same
     * function the curve handles use. Each solve assumes the other bow, so the two are
     * run alternately until they agree, which takes a handful of passes because each
     * control point dominates its own third of the curve.
     */
    const through = CURVE_HANDLE_TS.map((t) => pointAt(shaft, t))
    let curvature = 0
    let curvatureEnd = 0
    for (let pass = 0; pass < 4; pass += 1) {
      curvature = curvatureAt(start, end, through[0], CURVE_HANDLE_TS[0], 0, curvatureEnd)
      curvatureEnd = curvatureAt(start, end, through[1], CURVE_HANDLE_TS[1], 1, curvature)
    }

    return { kind: 'connector', start, end, routing: 'curved', curvature, curvatureEnd, elbow: 0.5, ...heads }
  }

  if (bends.length <= 2) {
    // Every leg straight and every turn square. A soft bend or an acute one is not a
    // route, it is a drawing, and there is no arrow in the schema shaped like it.
    const stops = [0, ...bends, last]
    for (let index = 0; index + 1 < stops.length; index += 1) {
      if (straightness(shaft, stops[index], stops[index + 1]) > STRAIGHT * 2) return null
    }
    // The angle between the two legs, measured leg to leg rather than over a window
    // either side of the bend. A hand does not turn a corner in one sample and the pen
    // rounds what is left of it, so a local window on a perfectly good right angle
    // reports about half of one. The legs are what the person drew, and the angle
    // between them is the angle they meant.
    for (let index = 1; index + 1 < stops.length; index += 1) {
      const bend = stops[index]
      const ax = shaft.xs[bend] - shaft.xs[stops[index - 1]]
      const ay = shaft.ys[bend] - shaft.ys[stops[index - 1]]
      const bx = shaft.xs[stops[index + 1]] - shaft.xs[bend]
      const by = shaft.ys[stops[index + 1]] - shaft.ys[bend]
      const turn = Math.abs(Math.atan2(ax * by - ay * bx, ax * bx + ay * by))
      if (Math.abs(turn - Math.PI / 2) > RIGHT_ANGLE_SLACK) return null
    }

    // Where the dogleg sits, taken from the first corner drawn. A two-corner route has
    // its dogleg between them, and the first corner is the one on the axis the schema's
    // own router leaves along, so it is the one that reproduces what was drawn.
    const corner = { x: shaft.xs[bends[0]], y: shaft.ys[bends[0]] }
    return {
      kind: 'connector',
      start,
      end,
      routing: 'orthogonal',
      curvature: 0,
      curvatureEnd: 0,
      elbow: elbowFor(start, end, corner),
      ...heads,
    }
  }

  // Three or more corners. Handwriting lives here, and so does everything else this
  // has no object for. Refusing is the whole reason the caller has a fallback.
  return null
}

/**
 * What a finished stroke was, or null if it was not any of them.
 *
 * Null is a real answer and the common one for anybody writing rather than drawing.
 * The caller keeps the ink when it comes back.
 */
export function recogniseStroke(
  points: readonly number[],
  options: AssistOptions,
): Recognition | null {
  const raw = strokePath(points)
  if (raw.xs.length < 4) return null

  const total = pathLength(raw)
  if (total < options.minLength) return null

  const path = resample(raw, SAMPLES)
  const last = path.xs.length - 1
  const gap = Math.hypot(path.xs[last] - path.xs[0], path.ys[last] - path.ys[0])

  /*
   * Closed enough to be a shape.
   *
   * Measured against the path's own length rather than against its box, so it does not
   * depend on how big the thing is or how round. A circle left a fifth of the way open
   * is still a circle to the person who drew it; a C is not, and lands at about a
   * third.
   */
  return gap < total * 0.22 ? recogniseClosed(path) : recogniseOpen(path, total)
}

/**
 * The two endpoints of a recognised connector, routed.
 *
 * Here rather than in the tool because the elbow's waypoints are geometry, and geometry
 * that the renderer, the hit test and the tool all have to agree about lives in this
 * package. `curved` keeps its two endpoints and derives the bow at draw time, which is
 * the schema's own rule for it.
 */
export function connectorPoints(connector: RecognisedConnector): number[] {
  if (connector.routing === 'orthogonal') {
    return routeOrthogonal(connector.start, connector.end, connector.elbow)
  }
  return [connector.start.x, connector.start.y, connector.end.x, connector.end.y]
}
