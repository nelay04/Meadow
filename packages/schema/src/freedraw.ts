/**
 * Freehand ink. ARCHITECTURE 4 and 5.
 *
 * `freedraw` was in the object type union from the start and unimplemented until now.
 * It stores what a pen actually produces: a run of samples, each with the pressure it
 * was drawn at, and a nib that says how those samples become a shape.
 *
 * Points are stored the way an arrow's are, relative to the object's own x,y with w/h
 * holding the painted extent, so dragging a stroke is a write to x and y and nothing
 * else and the R-tree, culling, marquee and the union box need no idea what ink is.
 * The stride is three rather than two: `[x, y, pressure, ...]`. Pressure belongs with
 * the point it was sampled at, and a parallel array would be a second thing to keep
 * the same length as the first.
 *
 * A flat array rather than `{x,y,p}[]`, for the reason arrows.ts gives and with more
 * force: a minute of drawing is a few thousand samples, and one object per sample is
 * garbage the frame budget cannot afford.
 *
 * ### What a tip is
 *
 * Every nib here is the same construction: the ink is the region swept by a shape
 * dragged along the path. Two shapes cover all five.
 *
 * A *round* nib sweeps a disc, so its edge is the path offset along its own normal by
 * the radius at that sample. Pressure changes the radius, which is where the swell in
 * a ballpoint line comes from.
 *
 * A *bladed* nib sweeps a line segment held at a fixed angle, so its edge is the path
 * offset by that segment and nothing else. This is why a chisel stroke is broad across
 * the nib and hairline along it, and it falls out of the construction rather than
 * being faked with a direction test.
 */

import { z } from 'zod'

import type { ObjectData, ObjectType } from './objects'

/** Values per sample in the stored array: x, y, pressure. */
export const FREEDRAW_STRIDE = 3

export const FREEDRAW_TIPS = ['round', 'felt', 'chisel', 'brush', 'highlighter'] as const
export type FreedrawTip = (typeof FREEDRAW_TIPS)[number]

/**
 * What a nib does, as numbers rather than as a branch per tip.
 *
 * The alternative was a switch in the outline builder, and it went wrong the first
 * time a tip needed two of another tip's traits: a highlighter is a chisel that does
 * not taper and a felt tip that is not round. Traits compose, names do not.
 */
export type TipProfile = {
  /** A blade held at `angle`, rather than a disc. */
  bladed: boolean
  /** How much of the width pressure may take away, 0 for a nib that ignores it. */
  thinning: number
  /** How the ends are finished. A blade cut flat is what leaves the calligraphic edge. */
  cap: 'round' | 'flat'
  /**
   * Multiplier on the chosen size.
   *
   * So that one size control means the same thing on every tip: a highlighter at
   * "medium" has to be several times a ballpoint at "medium" or it is not a
   * highlighter, and asking the person drawing to know that is asking them to
   * calibrate the tool before using it.
   */
  scale: number
  /** Resting opacity. Only the highlighter is translucent, and that is what it is. */
  alpha: number
  /** How far the ends ramp up from nothing, in nib widths. Zero for a cut nib. */
  taper: number
  /**
   * The angle this nib is naturally held at, in radians. Meaningless for a disc.
   *
   * A property of the nib rather than of the person, because getting it wrong does not
   * look like a preference, it looks like a broken tool: a highlighter whose blade lies
   * along the sweep leaves nothing at all behind it. The italic default is the angle a
   * right-handed writer holds a cut nib at, and the highlighter's is a quarter turn
   * from it so that a left-to-right sweep is the full width of the chisel.
   */
  angle: number
}

export const TIP_PROFILES: Readonly<Record<FreedrawTip, TipProfile>> = {
  // A ballpoint. Slight pressure response, round ends, the default for a reason: it
  // is the pen everybody has held.
  round: {
    bladed: false,
    thinning: 0.45,
    cap: 'round',
    scale: 1,
    alpha: 1,
    taper: 1.2,
    angle: 0,
  },
  // A fineliner. Constant width is the whole character of the thing, so no thinning
  // and no taper: it puts down the same line however hard you lean on it.
  felt: { bladed: false, thinning: 0, cap: 'round', scale: 1.4, alpha: 1, taper: 0, angle: 0 },
  // An italic nib, cut flat and held at `angle`.
  chisel: {
    bladed: true,
    thinning: 0.2,
    cap: 'flat',
    scale: 1.9,
    alpha: 1,
    taper: 0,
    angle: -Math.PI / 7,
  },
  // A brush. Heavy pressure response and long tapers, so a fast stroke comes to a
  // point at both ends.
  brush: {
    bladed: false,
    thinning: 0.82,
    cap: 'round',
    scale: 2.4,
    alpha: 1,
    taper: 3.4,
    angle: 0,
  },
  // A marker. Broad, flat, translucent, and drawn under the DOM text layer, which is
  // what makes it highlight rather than obliterate.
  highlighter: {
    bladed: true,
    thinning: 0,
    cap: 'flat',
    scale: 6.5,
    alpha: 0.32,
    taper: 0,
    angle: Math.PI / 2,
  },
}

export const freedrawProps = z.object({
  /** Flat [x0,y0,p0, x1,y1,p1, ...] relative to the object's x,y. Pressure is 0..1. */
  points: z.array(z.number()).default([0, 0, 0.5]),
  tip: z.enum(FREEDRAW_TIPS).default('round'),
  /** The nib's full width in world units, before the tip's own scale. */
  size: z.number().min(0.5).max(64).default(3),
  /**
   * The angle a bladed nib is held at, in radians. Ignored by round nibs.
   *
   * The default is the one a right-handed person writing italic holds a pen at, which
   * is the angle that makes a downstroke broad and a cross-stroke fine. Zero would be
   * a nib held horizontally, and every horizontal stroke would vanish.
   */
  angle: z.number().min(-Math.PI).max(Math.PI).default(-Math.PI / 7),
  stroke: z.number().int().default(0x1f2a24),
  strokeAlpha: z.number().min(0).max(1).default(1),
})

export type FreedrawProps = z.infer<typeof freedrawProps>

const DEFAULTS: FreedrawProps = freedrawProps.parse({})

export function isFreedraw(type: ObjectType): boolean {
  return type === 'freedraw'
}

/**
 * Read ink style without running the validator.
 *
 * Called once per stroke whenever the ink layer is rebuilt, and the points array is
 * handed back by reference so the outline cache can compare identity rather than
 * contents. Do not copy it here: that comparison is what keeps a rebuild from
 * re-tessellating every stroke on the board.
 */
export function resolveFreedrawProps(object: ObjectData): FreedrawProps {
  const props = object.props

  const number = (key: 'size' | 'angle' | 'stroke' | 'strokeAlpha', fallback: number): number => {
    const value = props[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback
  }

  const raw = props.points
  const points =
    Array.isArray(raw) && raw.length >= FREEDRAW_STRIDE && raw.every((v) => typeof v === 'number')
      ? (raw as number[])
      : DEFAULTS.points

  const tip =
    typeof props.tip === 'string' && (FREEDRAW_TIPS as readonly string[]).includes(props.tip)
      ? (props.tip as FreedrawTip)
      : DEFAULTS.tip

  return {
    points,
    tip,
    size: number('size', DEFAULTS.size),
    angle: number('angle', DEFAULTS.angle),
    stroke: number('stroke', DEFAULTS.stroke),
    // The tip's own resting opacity, not the schema default. A highlighter that has
    // never been restyled has to arrive translucent, and `strokeAlpha` is the only
    // place that can say so.
    strokeAlpha: number('strokeAlpha', TIP_PROFILES[tip].alpha),
  }
}

/**
 * The nib, and nothing else about the stroke.
 *
 * What the outline builder actually needs. Narrower than `FreedrawProps` on purpose,
 * so the stroke under the pointer, which has no colour resolved and no points stored
 * yet, can be drawn by the same function that draws the ones in the document, rather
 * than by a second one that would drift from it.
 */
export type InkStyle = Pick<FreedrawProps, 'tip' | 'size' | 'angle'>

/** Half the nib's width in world units, which is how far ink spreads from the path. */
export function nibRadius(props: Pick<FreedrawProps, 'tip' | 'size'>): number {
  return (props.size * TIP_PROFILES[props.tip].scale) / 2
}

export type FreedrawGeometry = { x: number; y: number; w: number; h: number; points: number[] }

/**
 * Origin, bounds and relative points for a run of world-space samples.
 *
 * The box is the sample extent grown by the nib radius, because the box has to contain
 * the *ink* and not the path down its middle. Without the pad, a stroke scrolls off
 * screen a nib-width before it has actually left, and the outer edge of a broad mark
 * cannot be clicked.
 */
export function freedrawGeometry(
  absolute: readonly number[],
  props: Pick<FreedrawProps, 'tip' | 'size'>,
): FreedrawGeometry {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (let index = 0; index + FREEDRAW_STRIDE <= absolute.length; index += FREEDRAW_STRIDE) {
    const x = absolute[index]
    const y = absolute[index + 1]
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }

  if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 1, h: 1, points: [...DEFAULTS.points] }

  const pad = nibRadius(props)
  const originX = minX - pad
  const originY = minY - pad

  const points: number[] = new Array(absolute.length)
  for (let index = 0; index + FREEDRAW_STRIDE <= absolute.length; index += FREEDRAW_STRIDE) {
    points[index] = absolute[index] - originX
    points[index + 1] = absolute[index + 1] - originY
    points[index + 2] = absolute[index + 2]
  }

  return {
    x: originX,
    y: originY,
    w: Math.max(maxX - minX + pad * 2, 1),
    h: Math.max(maxY - minY + pad * 2, 1),
    points,
  }
}

/** Move stored samples into world space. Allocates, so not per frame. */
export function absoluteInk(object: ObjectData, points: readonly number[]): number[] {
  const out: number[] = new Array(points.length)
  for (let index = 0; index + FREEDRAW_STRIDE <= points.length; index += FREEDRAW_STRIDE) {
    out[index] = points[index] + object.x
    out[index + 1] = points[index + 1] + object.y
    out[index + 2] = points[index + 2]
  }
  return out
}

/**
 * Scale a stroke's samples and its nib together.
 *
 * Resizing ink is the one transform that cannot be expressed as a box change. A
 * rectangle's `w` is its drawing; a stroke's `w` is only the box its drawing sits in,
 * so a resize that writes bounds and leaves the samples alone paints the original
 * stroke inside a box that no longer fits it.
 *
 * The nib scales by the geometric mean of the two axes, because a nib has one width
 * and a non-uniform resize has two. It is a compromise and it is the honest one: the
 * alternative is an elliptical nib, which is a real thing on paper but not one anybody
 * asked a resize handle for.
 */
export function scaleInk(points: readonly number[], scaleX: number, scaleY: number): number[] {
  const out: number[] = new Array(points.length)
  for (let index = 0; index + FREEDRAW_STRIDE <= points.length; index += FREEDRAW_STRIDE) {
    out[index] = points[index] * scaleX
    out[index + 1] = points[index + 1] * scaleY
    // Pressure is not a coordinate. Scaling it would make a stroke fade as it grew.
    out[index + 2] = points[index + 2]
  }
  return out
}

export function scaleNib(size: number, scaleX: number, scaleY: number): number {
  return size * Math.sqrt(Math.abs(scaleX * scaleY))
}

// --- outline ------------------------------------------------------------------
//
// One function builds the shape, and the renderer and the hit test both go through
// it, for the reason `arrowPolyline` exists: geometry computed twice is geometry that
// eventually disagrees, and ink you can see but not click is how it shows up.

/** Samples closer together than this carry no shape and cost a segment. World units. */
const MIN_SPACING = 0.55

/** Points around a round cap. Eight is smooth at any zoom a nib is visible at. */
const CAP_SEGMENTS = 8

/** Never let a tapered end reach zero area: a degenerate triangle renders as a spike. */
const MIN_RADIUS = 0.12

/**
 * How thick a blade is across its cutting edge, as a fraction of its length.
 *
 * A nib with no thickness sweeps no area at all when the stroke runs along it, so a
 * chisel dragged in its own direction would disappear rather than draw the hairline it
 * should. Real nibs have a thickness; this is it, and the hairline is made of it.
 */
const BLADE_THICKNESS = 0.14

/** One span of a uniform Catmull-Rom through four samples. */
function spline(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t
  const t3 = t2 * t
  const a = 2 * p1
  const b = (p2 - p0) * t
  const c = (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2
  const d = (-p0 + 3 * p1 - 3 * p2 + p3) * t3
  return 0.5 * (a + b + c + d)
}

function pushArc(
  out: number[],
  cx: number,
  cy: number,
  from: number,
  radius: number,
  segments: number,
): void {
  for (let step = 1; step < segments; step += 1) {
    const angle = from - (Math.PI * step) / segments
    out.push(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius)
  }
}

/** The mark a single tap leaves: a disc for a round nib, the nib itself for a blade. */
function dot(x: number, y: number, pressure: number, props: InkStyle): number[][] {
  const profile = TIP_PROFILES[props.tip]
  const radius = Math.max(
    MIN_RADIUS,
    nibRadius(props) * (1 - profile.thinning + profile.thinning * pressure),
  )
  const out: number[] = []

  if (!profile.bladed) {
    for (let step = 0; step < CAP_SEGMENTS * 2; step += 1) {
      const angle = (step / (CAP_SEGMENTS * 2)) * Math.PI * 2
      out.push(x + Math.cos(angle) * radius, y + Math.sin(angle) * radius)
    }
    return [out]
  }

  // A blade swept over no distance is a line segment, which has no area to fill. Give
  // it the thickness the nib itself has, so tapping a chisel pen leaves the short bar
  // it would leave on paper rather than nothing at all.
  const ox = Math.cos(props.angle) * radius
  const oy = Math.sin(props.angle) * radius
  const thickness = Math.max(MIN_RADIUS, radius * BLADE_THICKNESS)
  const nx = (-oy / radius) * thickness
  const ny = (ox / radius) * thickness
  out.push(x + ox + nx, y + oy + ny, x - ox + nx, y - oy + ny)
  out.push(x - ox - nx, y - oy - ny, x + ox - nx, y + oy - ny)
  return [out]
}

/**
 * The filled shape of a stroke, as convex pieces in the stroke's own space.
 *
 * Not a stroked polyline. A polyline has one width, and every interesting nib has a
 * width that changes along the path, so the two edges are built independently. That is
 * why the ink pass fills rather than strokes.
 *
 * **Pieces, not one closed outline, and self-crossing strokes are why.** The outline
 * of a stroke that crosses itself crosses itself too, and a triangulator is entitled
 * to do anything at all with a polygon that is not simple. What earcut actually does
 * is emit triangles spanning distant vertices, so a scribble came out as a solid slab
 * and a loop filled in: the thing you draw to cross something out ended up hiding it.
 * The web has not had to care about this because an SVG or canvas path fills by
 * winding rule and takes self-intersection in its stride; a WebGL triangulator does
 * not.
 *
 * So the body is one quad per segment, from the two offsets at one end of it to the
 * two at the other, and the caps are one piece each. Neighbouring quads share an edge
 * *exactly*, both of its vertices being the same two offsets, so there is no seam
 * between them, no gap on the outside of a turn, and nothing is drawn twice. Where the
 * stroke genuinely crosses itself, pieces from the two passes overlap, which is
 * invisible for opaque ink and is what a highlighter does on paper.
 *
 * **Every nib is an ellipse, and that is what keeps this a single polygon.** The
 * obvious way to draw a chisel is to offset the path by the nib's own direction, which
 * is what a segment-shaped nib does. It is also broken: the offset no longer follows
 * the path's normal, so the moment the stroke turns through the nib's angle the two
 * edges swap sides and the closed polygon through them crosses itself. Triangulating
 * that fills the loop the crossing encloses, and it is not a subtle artefact - a
 * chisel drawing a circle came out with a solid wedge across a quarter of it.
 *
 * Taking the ellipse's *support point* in the direction of the path's normal fixes it
 * at the root. The offset always has a positive component along that normal, so the
 * left edge stays left and the right edge stays right whatever the stroke does. Broad
 * across the nib and hairline along it still falls out of the shape rather than out of
 * a direction test, because that is what a flat ellipse is. A disc is the same formula
 * with equal axes, so there is one code path and not two.
 *
 * The remaining case is a turn tighter than the nib itself, where a single quad can
 * fold over. Every offset-based ink renderer has it, and now it costs one segment
 * rather than the whole stroke.
 *
 * Resampled in world units, never in screen units, so the result does not depend on
 * the camera. That is what lets it be cached per stroke and left alone while somebody
 * pans and zooms over it, which is the difference between ink being free and ink being
 * the most expensive thing on the board.
 */
export function strokeOutline(points: readonly number[], props: InkStyle): number[][] {
  const profile = TIP_PROFILES[props.tip]
  const radius = nibRadius(props)

  // 1. Thin the samples. A pointer parked in one place emits dozens of them.
  const xs: number[] = []
  const ys: number[] = []
  const ps: number[] = []
  for (let index = 0; index + FREEDRAW_STRIDE <= points.length; index += FREEDRAW_STRIDE) {
    const x = points[index]
    const y = points[index + 1]
    const last = xs.length - 1
    if (last >= 0 && Math.hypot(x - xs[last], y - ys[last]) < MIN_SPACING) continue
    xs.push(x)
    ys.push(y)
    ps.push(Math.min(1, Math.max(0, points[index + 2])))
  }

  if (xs.length === 0) return []
  if (xs.length === 1) return dot(xs[0], ys[0], ps[0], props)

  // 2. Smooth. The samples are already streamlined by the tool, so this is not noise
  // reduction: it is what stops a slow curve reading as a chain of flats once the
  // simplifier has thinned it, and it holds at any zoom because the step is in world
  // units.
  const step = Math.max(1.2, radius * 0.9)
  const cx: number[] = []
  const cy: number[] = []
  const cp: number[] = []
  const count = xs.length
  for (let index = 0; index + 1 < count; index += 1) {
    const before = Math.max(0, index - 1)
    const next = index + 1
    const after = Math.min(count - 1, index + 2)
    const span = Math.hypot(xs[next] - xs[index], ys[next] - ys[index])
    const steps = Math.min(4, Math.max(1, Math.round(span / step)))
    for (let sub = 0; sub < steps; sub += 1) {
      const t = sub / steps
      cx.push(spline(xs[before], xs[index], xs[next], xs[after], t))
      cy.push(spline(ys[before], ys[index], ys[next], ys[after], t))
      cp.push(ps[index] + (ps[next] - ps[index]) * t)
    }
  }
  cx.push(xs[count - 1])
  cy.push(ys[count - 1])
  cp.push(ps[count - 1])

  // 3. Arc length, for the taper. Measured on the smoothed line, since that is the one
  // being drawn.
  let total = 0
  for (let index = 1; index < cx.length; index += 1) {
    total += Math.hypot(cx[index] - cx[index - 1], cy[index] - cy[index - 1])
  }
  const taperLength = Math.min(profile.taper * radius, total * 0.4)

  const left: number[] = []
  const right: number[] = []
  let travelled = 0
  let firstAngle = 0
  let lastAngle = 0

  // The nib's long axis. Unused by a disc, whose two axes are the same length.
  const bladeX = profile.bladed ? Math.cos(props.angle) : 1
  const bladeY = profile.bladed ? Math.sin(props.angle) : 0

  for (let index = 0; index < cx.length; index += 1) {
    if (index > 0) {
      travelled += Math.hypot(cx[index] - cx[index - 1], cy[index] - cy[index - 1])
    }

    // Central difference, so a point's normal answers to the curve through it rather
    // than to whichever of its two segments happens to come first.
    const back = Math.max(0, index - 1)
    const forward = Math.min(cx.length - 1, index + 1)
    const dx = cx[forward] - cx[back]
    const dy = cy[forward] - cy[back]
    const angle = dx === 0 && dy === 0 ? lastAngle : Math.atan2(dy, dx)
    if (index === 0) firstAngle = angle
    lastAngle = angle

    let width = radius * (1 - profile.thinning + profile.thinning * cp[index])
    if (taperLength > 0) {
      const into = Math.min(1, travelled / taperLength)
      const outOf = Math.min(1, (total - travelled) / taperLength)
      // Square root rather than the ramp itself: a linear taper is a needle, and a pen
      // leaving the paper does not come to a needle.
      width *= Math.sqrt(Math.min(into, outOf))
    }
    width = Math.max(MIN_RADIUS, width)
    // A disc is an ellipse whose axes agree. A blade is a very flat one, and its short
    // axis is what a stroke drawn along it leaves behind.
    const thickness = profile.bladed ? Math.max(MIN_RADIUS, radius * BLADE_THICKNESS) : width

    /*
     * The nib's support point in the direction of the path's normal.
     *
     * The nib is an ellipse with semi-axis `width` along `props.angle` and `thickness`
     * across it, and this is where a line perpendicular to the travel direction last
     * touches it. For a disc the two axes are equal and it reduces to `normal * width`,
     * which is why there is no branch here for round nibs.
     *
     * `nu` and `nv` are the normal resolved onto the nib's own axes. The denominator
     * is the nib's extent in that direction, which is never zero because both axes are
     * held above `MIN_RADIUS`, and it is what stops a stroke running along a blade from
     * sweeping nothing at all.
     */
    const normalX = Math.cos(angle + Math.PI / 2)
    const normalY = Math.sin(angle + Math.PI / 2)
    const nu = normalX * bladeX + normalY * bladeY
    const nv = -normalX * bladeY + normalY * bladeX
    const spanU = width * nu
    const spanV = thickness * nv
    const extent = Math.hypot(spanU, spanV)
    const ox = (spanU * width * bladeX - spanV * thickness * bladeY) / extent
    const oy = (spanU * width * bladeY + spanV * thickness * bladeX) / extent

    left.push(cx[index] + ox, cy[index] + oy)
    right.push(cx[index] - ox, cy[index] - oy)
  }

  // 4. One quad per segment, plus a cap at each end.
  const pieces: number[][] = []

  for (let index = 0; index + 1 < cx.length; index += 1) {
    const a = index * 2
    const b = a + 2
    // A segment the smoother collapsed to a point has no quad. Skipping it costs
    // nothing, because its two offsets are the next segment's.
    if (cx[index] === cx[index + 1] && cy[index] === cy[index + 1]) continue

    pieces.push([left[a], left[a + 1], left[b], left[b + 1], right[b], right[b + 1], right[a], right[a + 1]])
  }

  if (pieces.length === 0) return dot(cx[0], cy[0], cp[0], props)

  if (profile.cap === 'round') {
    // A half disc beyond each end, closed on the chord between the two offsets there,
    // which is the same chord the neighbouring quad already ends on. Shared exactly,
    // so the cap neither gaps nor overlaps.
    const tail = cx.length - 1
    const endRadius = Math.hypot(left[left.length - 2] - cx[tail], left[left.length - 1] - cy[tail])
    const endCap = [left[left.length - 2], left[left.length - 1]]
    pushArc(endCap, cx[tail], cy[tail], lastAngle + Math.PI / 2, endRadius, CAP_SEGMENTS)
    endCap.push(right[right.length - 2], right[right.length - 1])
    pieces.push(endCap)

    const startRadius = Math.hypot(left[0] - cx[0], left[1] - cy[0])
    const startCap = [right[0], right[1]]
    pushArc(startCap, cx[0], cy[0], firstAngle - Math.PI / 2, startRadius, CAP_SEGMENTS)
    startCap.push(left[0], left[1])
    pieces.push(startCap)
  }

  return pieces
}

/**
 * Is a world point on this stroke?
 *
 * Tested against the path with the nib's reach, not against the outline polygon. A
 * point-in-polygon test on a shape that overlaps itself is the wrong question anyway,
 * and this one answers what the person is actually asking, which is whether they
 * clicked the line they can see.
 */
export function hitsInk(
  points: readonly number[],
  props: Pick<FreedrawProps, 'tip' | 'size'>,
  localX: number,
  localY: number,
  tolerance: number,
): boolean {
  if (points.length < FREEDRAW_STRIDE) return false

  const reach = nibRadius(props) + tolerance
  const reachSquared = reach * reach

  if (points.length < FREEDRAW_STRIDE * 2) {
    const dx = localX - points[0]
    const dy = localY - points[1]
    return dx * dx + dy * dy <= reachSquared
  }

  for (let index = 0; index + FREEDRAW_STRIDE * 2 <= points.length; index += FREEDRAW_STRIDE) {
    const ax = points[index]
    const ay = points[index + 1]
    const bx = points[index + FREEDRAW_STRIDE]
    const by = points[index + FREEDRAW_STRIDE + 1]
    const dx = bx - ax
    const dy = by - ay
    const lengthSquared = dx * dx + dy * dy
    const t =
      lengthSquared === 0
        ? 0
        : Math.max(0, Math.min(1, ((localX - ax) * dx + (localY - ay) * dy) / lengthSquared))
    const px = localX - (ax + t * dx)
    const py = localY - (ay + t * dy)
    if (px * px + py * py <= reachSquared) return true
  }

  return false
}
