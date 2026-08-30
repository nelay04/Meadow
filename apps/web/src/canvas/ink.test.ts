/**
 * Tests for freehand ink.
 *
 * The nib maths is the kind that produces something plausible when it is wrong. A
 * chisel with the sine of the wrong angle still draws a stroke that varies in width;
 * a taper applied from the wrong end still tapers. So these assert the properties that
 * separate right from plausible: a blade is wide across itself and thin along itself,
 * a closed outline stays closed, pressure moves the width in the direction it should,
 * and what you can see is what you can click.
 */

import {
  type FreedrawTip,
  type ObjectData,
  TIP_PROFILES,
  freedrawGeometry,
  hitsInk,
  nibRadius,
  resolveFreedrawProps,
  scaleInk,
  strokeOutline,
} from '@meadow/schema'
import { describe, expect, it } from 'vitest'

import { hitsObject } from './hitTest'
import { applyRectToObject } from './transform'

function ink(points: number[], props: Record<string, unknown> = {}): ObjectData {
  const geometry = freedrawGeometry(points, {
    tip: (props.tip as FreedrawTip) ?? 'round',
    size: (props.size as number) ?? 3,
  })
  return {
    id: 'ink',
    type: 'freedraw',
    x: geometry.x,
    y: geometry.y,
    w: geometry.w,
    h: geometry.h,
    rotation: 0,
    opacity: 1,
    locked: false,
    parentId: null,
    createdBy: '',
    props: { points: geometry.points, tip: 'round', size: 3, ...props },
  }
}

/**
 * The extent of a stroke along a unit direction, over every piece it is made of.
 *
 * `strokeOutline` returns convex pieces rather than one polygon. What is measured here
 * is the mark, not how many pieces it happens to be cut into.
 */
function spread(pieces: readonly (readonly number[])[], dx: number, dy: number): number {
  let low = Infinity
  let high = -Infinity
  for (const piece of pieces) {
    for (let index = 0; index + 1 < piece.length; index += 2) {
      const projection = piece[index] * dx + piece[index + 1] * dy
      low = Math.min(low, projection)
      high = Math.max(high, projection)
    }
  }
  return high - low
}

/** The longest distance between any two points of one piece. */
function diameter(piece: readonly number[]): number {
  let worst = 0
  for (let a = 0; a + 1 < piece.length; a += 2) {
    for (let b = a + 2; b + 1 < piece.length; b += 2) {
      worst = Math.max(worst, Math.hypot(piece[a] - piece[b], piece[a + 1] - piece[b + 1]))
    }
  }
  return worst
}

/** Every coordinate across every piece, for the checks that are about the numbers. */
function flatten(pieces: readonly (readonly number[])[]): number[] {
  return pieces.flatMap((piece) => [...piece])
}

/** A straight run of samples at one pressure. */
function line(length: number, pressure = 0.5, step = 4): number[] {
  const points: number[] = []
  for (let at = 0; at <= length; at += step) points.push(at, 0, pressure)
  return points
}

describe('freedrawGeometry', () => {
  it('grows the box by the nib, so the box holds the ink and not just the path', () => {
    const geometry = freedrawGeometry(line(40), { tip: 'round', size: 4 })
    const radius = nibRadius({ tip: 'round', size: 4 })

    expect(geometry.x).toBeCloseTo(-radius)
    expect(geometry.y).toBeCloseTo(-radius)
    expect(geometry.w).toBeCloseTo(40 + radius * 2)
    // A perfectly horizontal stroke has no vertical extent of its own, so its height
    // is the nib alone. This is the case that reads as a bug when the pad is missing.
    expect(geometry.h).toBeCloseTo(radius * 2)
  })

  it('stores points relative to the box, keeping pressure untouched', () => {
    const geometry = freedrawGeometry([100, 200, 0.25, 140, 260, 0.75], { tip: 'round', size: 2 })
    const radius = nibRadius({ tip: 'round', size: 2 })

    expect(geometry.points[0]).toBeCloseTo(radius)
    expect(geometry.points[1]).toBeCloseTo(radius)
    expect(geometry.points[2]).toBe(0.25)
    expect(geometry.points[5]).toBe(0.75)
  })

  it('survives an empty run rather than producing an infinite box', () => {
    const geometry = freedrawGeometry([], { tip: 'round', size: 3 })
    expect(Number.isFinite(geometry.x)).toBe(true)
    expect(geometry.w).toBeGreaterThan(0)
  })
})

describe('strokeOutline', () => {
  it('closes the outline around a straight stroke at roughly the nib width', () => {
    const outline = strokeOutline(line(60, 1), { tip: 'felt', size: 4, angle: 0 })
    const width = nibRadius({ tip: 'felt', size: 4 }) * 2

    expect(flatten(outline).length).toBeGreaterThan(8)
    // Across the stroke it is the nib. A felt tip does not thin, so this is exact
    // apart from the round caps, which only add length.
    expect(spread(outline, 0, 1)).toBeCloseTo(width, 1)
    expect(spread(outline, 1, 0)).toBeGreaterThan(60)
  })

  it('widens with pressure on a nib that answers to it', () => {
    const style = { tip: 'round' as const, size: 6, angle: 0 }
    const light = spread(strokeOutline(line(60, 0.1), style), 0, 1)
    const heavy = spread(strokeOutline(line(60, 1), style), 0, 1)

    expect(heavy).toBeGreaterThan(light * 1.3)
  })

  it('ignores pressure on a nib that does not answer to it', () => {
    const style = { tip: 'felt' as const, size: 6, angle: 0 }
    const light = spread(strokeOutline(line(60, 0.1), style), 0, 1)
    const heavy = spread(strokeOutline(line(60, 1), style), 0, 1)

    expect(heavy).toBeCloseTo(light, 4)
  })

  it('draws a blade broad across the nib and hairline along it', () => {
    // The nib lies along x. A stroke drawn along it is a hairline, and the same stroke
    // drawn across it is the blade's full width. That contrast is the whole of
    // calligraphy, and it is what fails if the offset is taken from the path's normal
    // instead of from the nib.
    const style = { tip: 'chisel' as const, size: 8, angle: 0 }
    const blade = nibRadius({ tip: 'chisel', size: 8 }) * 2

    // Full pressure on both, since a chisel does thin a little and the comparison
    // here is about direction rather than about how hard the nib was pressed.
    const along = strokeOutline(line(60, 1), style)
    expect(spread(along, 0, 1)).toBeLessThan(blade * 0.2)

    const down: number[] = []
    for (let at = 0; at <= 60; at += 4) down.push(0, at, 1)
    const across = strokeOutline(down, style)
    expect(spread(across, 1, 0)).toBeCloseTo(blade, 1)
  })

  it('never spans more than a segment, however often the stroke crosses itself', () => {
    /*
     * The bug this exists for, reported from the running app with a screenshot.
     *
     * A stroke that crosses itself has an outline that crosses itself, and a
     * triangulator handed a polygon that is not simple may do anything at all; earcut
     * emits triangles between distant vertices. A scribble came out as a solid slab
     * and a loop filled itself in, so the mark you make to cross something out covered
     * it up instead.
     *
     * The assertion is the one that catches it directly, and the one the earlier arc
     * test could not: no piece of a stroke may be larger than one step of that stroke
     * plus the nib drawing it. A triangle spanning the scribble fails it by an order of
     * magnitude whatever shape the scribble happens to be.
     */
    const scribble: number[] = []
    for (let step = 0; step <= 60; step += 1) {
      const t = step / 60
      // A lissajous figure: it crosses itself repeatedly and at many angles, which is
      // what a scribble does and what an arc never does.
      scribble.push(Math.sin(t * Math.PI * 6) * 60, Math.sin(t * Math.PI * 4 + 1) * 45, 1)
    }

    for (const tip of ['round', 'chisel', 'highlighter', 'brush'] as FreedrawTip[]) {
      const size = 11.4 / TIP_PROFILES[tip].scale
      const pieces = strokeOutline(scribble, { tip, size, angle: TIP_PROFILES[tip].angle })
      const nib = nibRadius({ tip, size })

      expect(pieces.length, tip).toBeGreaterThan(10)

      // A piece spans one resampled step plus the nib at either end. The allowance is
      // generous on purpose: what it has to tell apart is "a segment" from "the whole
      // drawing", and the scribble is 120 units across.
      const limit = nib * 6 + 12
      for (const piece of pieces) {
        expect(diameter(piece), `${tip}: piece of ${pieces.length}`).toBeLessThan(limit)
      }
    }
  })

  it('leaves a hairline when a blade is dragged along its own edge', () => {
    // Zero area is the honest answer for a nib with no thickness, and it renders as
    // the stroke disappearing for the stretch where it happens, which reads as a fault
    // rather than as calligraphy.
    const along = strokeOutline(line(60, 1), { tip: 'chisel', size: 8, angle: 0 })
    const thin = spread(along, 0, 1)

    expect(thin).toBeGreaterThan(0.3)
    expect(thin).toBeLessThan(nibRadius({ tip: 'chisel', size: 8 }) * 0.4)
  })

  it('leaves a mark for a single tap, on every nib', () => {
    for (const tip of Object.keys(TIP_PROFILES) as FreedrawTip[]) {
      const outline = strokeOutline([10, 10, 0.7], { tip, size: 4, angle: -0.4 })
      expect(flatten(outline).length, tip).toBeGreaterThanOrEqual(8)
      expect(spread(outline, 1, 0), tip).toBeGreaterThan(0)
      expect(spread(outline, 0, 1), tip).toBeGreaterThan(0)
    }
  })

  it('produces only finite coordinates when samples repeat exactly', () => {
    // A pointer that reports the same position twice used to give a zero-length
    // tangent and a NaN normal, which renders as nothing at all rather than as an
    // error.
    const outline = strokeOutline([0, 0, 0.5, 0, 0, 0.5, 30, 0, 0.5], {
      tip: 'round',
      size: 3,
      angle: 0,
    })
    expect(flatten(outline).every((value) => Number.isFinite(value))).toBe(true)
  })

  it('does not depend on how densely the same shape was sampled', () => {
    const style = { tip: 'felt' as const, size: 4, angle: 0 }
    const coarse = strokeOutline(line(80, 0.5, 20), style)
    const fine = strokeOutline(line(80, 0.5, 2), style)

    // Same drawing, different pointer rates. The width has to agree, or a stroke drawn
    // on a slow machine is a different stroke.
    expect(spread(coarse, 0, 1)).toBeCloseTo(spread(fine, 0, 1), 1)
  })
})

describe('hit-testing ink', () => {
  it('hits the line and misses the hole in the middle of it', () => {
    // A circle drawn with a pen. Its box is mostly the paper inside it, which is what
    // makes the bounding box test wrong here rather than merely imprecise.
    const points: number[] = []
    for (let step = 0; step <= 32; step += 1) {
      const angle = (step / 32) * Math.PI * 2
      points.push(100 + Math.cos(angle) * 50, 100 + Math.sin(angle) * 50, 0.5)
    }
    const object = ink(points, { size: 4 })

    expect(hitsObject(object, { x: 150, y: 100 }, 2)).toBe(true)
    expect(hitsObject(object, { x: 100, y: 100 }, 2)).toBe(false)
  })

  it('is clickable across the full width of a broad nib', () => {
    const object = ink(line(80), { tip: 'highlighter', size: 6 })
    const reach = nibRadius({ tip: 'highlighter', size: 6 })
    const props = resolveFreedrawProps(object)

    // Just inside the painted edge, measured in the object's own space.
    expect(hitsInk(props.points, props, 40 + reach, reach * 0.9, 0)).toBe(true)
    expect(hitsInk(props.points, props, 40 + reach, reach * 2.4, 0)).toBe(false)
  })
})

describe('resizing ink', () => {
  it('scales the samples and the nib, not just the box', () => {
    const object = ink(line(100), { size: 4 })
    const before = {
      minX: object.x,
      minY: object.y,
      maxX: object.x + object.w,
      maxY: object.y + object.h,
    }
    const after = { minX: 0, minY: 0, maxX: object.w * 2, maxY: object.h * 2 }

    const patch = applyRectToObject(object, before, after)
    const points = patch.props?.points as number[]

    expect(points).toBeDefined()
    // The last sample was at x = 100 plus the nib pad; doubled, it is twice as far
    // along. Without this the drawing stays its original size inside a doubled box.
    const original = resolveFreedrawProps(object).points
    expect(points[points.length - 3]).toBeCloseTo(original[original.length - 3] * 2)
    expect(patch.props?.size as number).toBeCloseTo(8)
  })

  it('leaves pressure alone when scaling, so a stroke does not fade as it grows', () => {
    const scaled = scaleInk([0, 0, 0.2, 10, 10, 0.9], 3, 3)
    expect(scaled).toEqual([0, 0, 0.2, 30, 30, 0.9])
  })
})

describe('resolveFreedrawProps', () => {
  it('gives a nib its own resting opacity when the document does not name one', () => {
    const highlighter = ink(line(20), { tip: 'highlighter' })
    expect(resolveFreedrawProps(highlighter).strokeAlpha).toBeCloseTo(
      TIP_PROFILES.highlighter.alpha,
    )

    const pen = ink(line(20), { tip: 'round' })
    expect(resolveFreedrawProps(pen).strokeAlpha).toBe(1)
  })

  it('hands the stored points back by reference, which the outline cache relies on', () => {
    const object = ink(line(20))
    expect(resolveFreedrawProps(object).points).toBe(object.props.points)
  })

  it('falls back rather than throwing on a document written by something else', () => {
    const object = ink(line(20))
    object.props = { points: 'nonsense', tip: 'quill', size: null }
    const props = resolveFreedrawProps(object)

    expect(props.tip).toBe('round')
    expect(props.size).toBeGreaterThan(0)
    expect(props.points.length).toBeGreaterThanOrEqual(3)
  })
})
