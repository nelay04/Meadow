/**
 * Tests for stroke recognition.
 *
 * A recogniser is the kind of code that looks like it works. Fed a perfect rectangle
 * it answers "rectangle" whatever it is doing inside, so a test that draws perfect
 * shapes tests nothing that a person drawing on a board will ever exercise. Every
 * stroke here is therefore drawn the way a hand draws one: sampled unevenly, wobbling
 * off the ideal by a few per cent of its own size, starting and stopping somewhere
 * arbitrary, and in the closed cases either falling short of the start or running past
 * it.
 *
 * The jitter is deterministic. A recogniser that passes on one random seed and fails
 * on the next has told you nothing, and a test that fails once a fortnight in CI gets
 * deleted rather than fixed.
 *
 * What is asserted is the pair of things that actually matter: the right shapes are
 * recognised, and the wrong ones are refused. The second half is the important one.
 * Anything can be made to classify a circle if it is allowed to classify handwriting
 * as a line on the way.
 */

import {
  type Recognition,
  FREEDRAW_TIPS,
  PARALLELOGRAM_SLANT,
  recogniseStroke,
  tipTakesAssist,
} from '@meadow/schema'
import { describe, expect, it } from 'vitest'

/** No stroke in these tests is short enough for the floor to matter. */
const ASSIST = { minLength: 20 }

/**
 * A repeatable pseudo-random sequence in -1..1.
 *
 * Its own generator rather than `Math.random`, so a failure can be reproduced from the
 * test name alone.
 */
function wobble(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return (state / 0xffffffff) * 2 - 1
  }
}

/**
 * Sample a parametric path the way a hand would.
 *
 * `noise` is a fraction of the shape's own size, so the same number means the same
 * unsteadiness at any scale. The sample spacing is deliberately uneven: a real pen
 * emits on a clock while the hand speeds up and slows down, and code that assumes
 * evenly spaced input passes on synthetic strokes and fails on real ones.
 */
function draw(
  at: (t: number) => { x: number; y: number },
  options: { count?: number; noise?: number; scale?: number; seed?: number; from?: number; to?: number } = {},
): number[] {
  const count = options.count ?? 90
  const noise = (options.noise ?? 0.012) * (options.scale ?? 100)
  const random = wobble(options.seed ?? 7)
  const from = options.from ?? 0
  const to = options.to ?? 1

  const points: number[] = []
  for (let step = 0; step < count; step += 1) {
    // Unevenly spaced, biased by a smooth function of the index rather than randomly,
    // so the path is still traced in order but not at a constant speed.
    const even = step / (count - 1)
    const eased = even + Math.sin(even * Math.PI * 2) * 0.04
    const t = from + (to - from) * Math.min(1, Math.max(0, eased))
    const point = at(t)
    points.push(point.x + random() * noise, point.y + random() * noise, 0.5)
  }
  return points
}

/** Walk a closed polygon by perimeter, so corners land where the shape has them. */
function polygon(corners: readonly { x: number; y: number }[]): (t: number) => { x: number; y: number } {
  const closed = [...corners, corners[0]]
  const lengths = closed.slice(1).map((point, index) => Math.hypot(point.x - closed[index].x, point.y - closed[index].y))
  const total = lengths.reduce((sum, length) => sum + length, 0)

  return (t: number) => {
    let remaining = Math.min(1, Math.max(0, t)) * total
    for (let index = 0; index < lengths.length; index += 1) {
      if (remaining <= lengths[index] || index === lengths.length - 1) {
        const fraction = lengths[index] === 0 ? 0 : Math.min(1, remaining / lengths[index])
        return {
          x: closed[index].x + (closed[index + 1].x - closed[index].x) * fraction,
          y: closed[index].y + (closed[index + 1].y - closed[index].y) * fraction,
        }
      }
      remaining -= lengths[index]
    }
    return closed[0]
  }
}

function polyline(corners: readonly { x: number; y: number }[]): (t: number) => { x: number; y: number } {
  const lengths = corners.slice(1).map((point, index) => Math.hypot(point.x - corners[index].x, point.y - corners[index].y))
  const total = lengths.reduce((sum, length) => sum + length, 0)

  return (t: number) => {
    let remaining = Math.min(1, Math.max(0, t)) * total
    for (let index = 0; index < lengths.length; index += 1) {
      if (remaining <= lengths[index] || index === lengths.length - 1) {
        const fraction = lengths[index] === 0 ? 0 : Math.min(1, remaining / lengths[index])
        return {
          x: corners[index].x + (corners[index + 1].x - corners[index].x) * fraction,
          y: corners[index].y + (corners[index + 1].y - corners[index].y) * fraction,
        }
      }
      remaining -= lengths[index]
    }
    return corners[corners.length - 1]
  }
}

function shapeOf(result: Recognition | null): string {
  if (result === null) return 'none'
  return result.kind === 'shape' ? result.type : `${result.routing}-connector`
}

describe('closed strokes', () => {
  it('reads a hand-drawn rectangle as a rect at the size it was drawn', () => {
    const stroke = draw(
      polygon([
        { x: 100, y: 100 },
        { x: 320, y: 100 },
        { x: 320, y: 260 },
        { x: 100, y: 260 },
      ]),
      { scale: 220, count: 140 },
    )

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('rect')
    if (result === null || result.kind !== 'shape') throw new Error('unreachable')
    expect(result.w).toBeCloseTo(220, -1)
    expect(result.h).toBeCloseTo(160, -1)
    expect(result.x).toBeCloseTo(100, -1)
    expect(result.y).toBeCloseTo(100, -1)
  })

  it('reads a circle as an ellipse and squares it up', () => {
    // Drawn slightly wider than tall, the way anybody draws a circle freehand.
    const stroke = draw((t) => ({ x: 200 + Math.cos(t * Math.PI * 2) * 106, y: 200 + Math.sin(t * Math.PI * 2) * 98 }), {
      scale: 200,
      count: 120,
    })

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('ellipse')
    if (result === null || result.kind !== 'shape') throw new Error('unreachable')
    // Within a tenth of square, so it comes out square. A circle drawn by hand is
    // meant to be a circle.
    expect(result.w).toBeCloseTo(result.h, 5)
  })

  it('keeps an oval oval', () => {
    const stroke = draw((t) => ({ x: 200 + Math.cos(t * Math.PI * 2) * 160, y: 200 + Math.sin(t * Math.PI * 2) * 70 }), {
      scale: 200,
      count: 120,
    })

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('ellipse')
    if (result === null || result.kind !== 'shape') throw new Error('unreachable')
    expect(result.w / result.h).toBeGreaterThan(2)
  })

  it('tells a diamond from the rectangle around it', () => {
    const stroke = draw(
      polygon([
        { x: 200, y: 60 },
        { x: 340, y: 170 },
        { x: 200, y: 280 },
        { x: 60, y: 170 },
      ]),
      { scale: 280, count: 140 },
    )

    expect(shapeOf(recogniseStroke(stroke, ASSIST))).toBe('diamond')
  })

  it('tells a parallelogram from the rectangle it leans out of', () => {
    // Built from the project's own lean, so the test is asking whether the recogniser
    // agrees with the renderer rather than with a number invented here.
    const w = 260
    const h = 150
    const slant = Math.min(w, h) * PARALLELOGRAM_SLANT
    const stroke = draw(
      polygon([
        { x: 100 + slant, y: 100 },
        { x: 100 + w, y: 100 },
        { x: 100 + w - slant, y: 100 + h },
        { x: 100, y: 100 + h },
      ]),
      { scale: 260, count: 140 },
    )

    expect(shapeOf(recogniseStroke(stroke, ASSIST))).toBe('parallelogram')
  })

  it('closes a shape whose ends fell short', () => {
    const stroke = draw(
      polygon([
        { x: 100, y: 100 },
        { x: 300, y: 100 },
        { x: 300, y: 240 },
        { x: 100, y: 240 },
      ]),
      // Stops a tenth of the perimeter early, which is the ordinary way a hand-drawn
      // box ends.
      { scale: 200, count: 130, to: 0.9 },
    )

    expect(shapeOf(recogniseStroke(stroke, ASSIST))).toBe('rect')
  })

  it('refuses a scribble', () => {
    const stroke = draw(
      (t) => ({
        x: 100 + t * 240,
        y: 180 + Math.sin(t * Math.PI * 9) * 70,
      }),
      { scale: 240, count: 160 },
    )

    expect(recogniseStroke(stroke, ASSIST)).toBeNull()
  })
})

describe('open strokes', () => {
  it('reads a straight stroke as a line with no heads', () => {
    const stroke = draw(polyline([{ x: 80, y: 200 }, { x: 380, y: 260 }]), { scale: 300, count: 80 })

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('straight-connector')
    if (result === null || result.kind !== 'connector') throw new Error('unreachable')
    expect(result.startHead).toBe(false)
    expect(result.endHead).toBe(false)
  })

  it('snaps a nearly horizontal stroke flat', () => {
    const stroke = draw(polyline([{ x: 80, y: 200 }, { x: 380, y: 214 }]), { scale: 300, count: 80 })

    const result = recogniseStroke(stroke, ASSIST)
    if (result === null || result.kind !== 'connector') throw new Error('unreachable')
    expect(result.end.y).toBeCloseTo(result.start.y, 5)
  })

  it('reads a shaft with an arrowhead as an arrow, ending at the tip', () => {
    // One continuous stroke: along the shaft, up to a barb, back to the tip, out to
    // the other barb. That is how an arrow is drawn without lifting the pen.
    const stroke = draw(
      polyline([
        { x: 80, y: 200 },
        { x: 300, y: 200 },
        { x: 272, y: 182 },
        { x: 300, y: 200 },
        { x: 272, y: 218 },
      ]),
      { scale: 220, count: 130, noise: 0.008 },
    )

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('straight-connector')
    if (result === null || result.kind !== 'connector') throw new Error('unreachable')
    expect(result.endHead).toBe(true)
    expect(result.startHead).toBe(false)
    // The arrow ends where it was aimed, not where the pen stopped.
    expect(result.end.x).toBeCloseTo(300, -1)
    expect(result.end.y).toBeCloseTo(200, -1)
  })

  it('reads a right-angled stroke as an elbow', () => {
    const stroke = draw(
      polyline([
        { x: 80, y: 120 },
        { x: 300, y: 120 },
        { x: 300, y: 300 },
      ]),
      { scale: 220, count: 120, noise: 0.008 },
    )

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('orthogonal-connector')
    if (result === null || result.kind !== 'connector') throw new Error('unreachable')
    expect(result.start.x).toBeCloseTo(80, -1)
    expect(result.end.y).toBeCloseTo(300, -1)
  })

  it('reads a bowed stroke as a curve that passes through the bow', () => {
    const stroke = draw(
      (t) => ({
        // A quadratic bow off the chord, which is the shape a curved connector has.
        x: 80 + t * 300,
        y: 200 - Math.sin(t * Math.PI) * 90,
      }),
      { scale: 300, count: 110 },
    )

    const result = recogniseStroke(stroke, ASSIST)
    expect(shapeOf(result)).toBe('curved-connector')
    if (result === null || result.kind !== 'connector') throw new Error('unreachable')
    // Both halves lean the same way, which is what makes it a C rather than an S.
    expect(Math.sign(result.curvature)).toBe(Math.sign(result.curvatureEnd))
    expect(Math.abs(result.curvature)).toBeGreaterThan(0.1)
  })

  it('refuses handwriting', () => {
    // A cursive 'e' into an 'l': several corners, no structure a connector has.
    const stroke = draw(
      (t) => ({
        x: 100 + t * 160,
        y: 200 - Math.sin(t * Math.PI * 5) * 40 - t * 30,
      }),
      { scale: 160, count: 140 },
    )

    expect(recogniseStroke(stroke, ASSIST)).toBeNull()
  })

  it('leaves a stroke smaller than the floor alone', () => {
    const dot = draw(polyline([{ x: 100, y: 100 }, { x: 104, y: 108 }]), { scale: 10, count: 12 })
    expect(recogniseStroke(dot, { minLength: 40 })).toBeNull()
  })
})

describe('which nibs take the assist', () => {
  it('offers it on the two plain nibs and on nothing else', () => {
    expect(FREEDRAW_TIPS.filter(tipTakesAssist)).toEqual(['round', 'felt'])
  })

  it('withholds it from the nibs whose shape is the point of them', () => {
    // A highlighter sweep turned into a rectangle has thrown away the only reason it
    // was drawn with a highlighter.
    expect(tipTakesAssist('chisel')).toBe(false)
    expect(tipTakesAssist('brush')).toBe(false)
    expect(tipTakesAssist('highlighter')).toBe(false)
  })
})
