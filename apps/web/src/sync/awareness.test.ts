/**
 * What a peer is allowed to put on the wire.
 *
 * Awareness state is whatever the other end chose to send: a build from before this
 * feature, a build from after it, or something hand-written by somebody poking at a
 * socket. None of it can do damage - the worst an accepted laser mark does is draw a
 * line - but every one of these values ends up inside a render loop, and a NaN or a few
 * thousand points are both a board that stops drawing.
 */

import { describe, expect, it } from 'vitest'

import { readLaser } from './awareness'

describe('readLaser', () => {
  it('takes a well-formed mark unchanged', () => {
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, c: 0x30d158, w: 5 })).toEqual({
      points: [0, 0, 10, 12],
      alpha: 1,
      color: 0x30d158,
      width: 5,
    })
  })

  it('draws a peer who named no colour or width in the defaults', () => {
    // A peer on a build from before the laser was settable. Drawing nothing at all
    // would be the wrong answer: they are pointing, and we can see where.
    const mark = readLaser({ p: [0, 0, 10, 12], a: 1 })
    expect(mark?.color).toBe(0x0a84ff)
    expect(mark?.width).toBe(3.5)
  })

  it('refuses a colour that is not one', () => {
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, c: -1 })?.color).toBe(0x0a84ff)
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, c: 0x1ffffff })?.color).toBe(0x0a84ff)
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, c: 1.5 })?.color).toBe(0x0a84ff)
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, c: '#fff' })?.color).toBe(0x0a84ff)
  })

  it('caps a width that would paint the viewport red', () => {
    // A peer may ask everybody in the room to draw this, so the number is theirs and
    // the limit is ours.
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, w: 10000 })?.width).toBe(12)
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, w: 0 })?.width).toBe(3.5)
    expect(readLaser({ p: [0, 0, 10, 12], a: 1, w: Number.NaN })?.width).toBe(3.5)
  })

  it('keeps a mark that is part way through fading out', () => {
    expect(readLaser({ p: [0, 0, 10, 12], a: 0.4, c: 0x0a84ff, w: 3.5 })?.alpha).toBe(0.4)
  })

  it('refuses anything that is not a mark', () => {
    expect(readLaser(undefined)).toBeNull()
    expect(readLaser(null)).toBeNull()
    expect(readLaser('12,14')).toBeNull()
    expect(readLaser([0, 0, 10, 12])).toBeNull()
    expect(readLaser({ p: [0, 0, '10', 12], a: 1 })).toBeNull()
  })

  it('refuses a mark with no geometry in it', () => {
    expect(readLaser({ p: [], a: 1 })).toBeNull()
    expect(readLaser({ p: [4], a: 1 })).toBeNull()
  })

  it('treats a missing or spent alpha as a mark that is over', () => {
    // Nothing to draw, so it is not a mark. Letting it through would leave a peer's
    // trail sitting on the board at whatever alpha the renderer defaulted to.
    expect(readLaser({ p: [0, 0, 10, 12] })).toBeNull()
    expect(readLaser({ p: [0, 0, 10, 12], a: 0 })).toBeNull()
    expect(readLaser({ p: [0, 0, 10, 12], a: -1 })).toBeNull()
    expect(readLaser({ p: [0, 0, 10, 12], a: Number.NaN })).toBeNull()
  })

  it('clamps an alpha claiming to be brighter than lit', () => {
    expect(readLaser({ p: [0, 0, 10, 12], a: 7 })?.alpha).toBe(1)
  })

  it('refuses values that would poison the projection', () => {
    // NaN through a transform is a NaN vertex, and one of those takes the whole
    // Graphics with it rather than just its own segment.
    expect(readLaser({ p: [0, 0, Number.NaN, 12], a: 1 })).toBeNull()
    expect(readLaser({ p: [0, 0, Number.POSITIVE_INFINITY, 12], a: 1 })).toBeNull()
  })

  it('keeps the newest points when a mark is over the cap', () => {
    const long: number[] = []
    for (let index = 0; index < 400; index += 1) long.push(index, index)

    const mark = readLaser({ p: long, a: 1 })
    expect(mark).not.toBeNull()
    expect(mark?.points).toHaveLength(256)
    // The head, which is where the person is actually pointing, survives; the tail
    // that was already being trimmed away is what gets dropped.
    expect(mark?.points.slice(-2)).toEqual([399, 399])
  })

  it('drops the oldest value rather than misaligning an odd-length mark', () => {
    // An odd length means somebody's pairs are off by one. Reading it from the front
    // would pair every x with the previous y and draw a trail nobody made; reading
    // from the end keeps the head where it belongs.
    expect(readLaser({ p: [9, 0, 0, 10, 12], a: 1 })?.points).toEqual([0, 0, 10, 12])
  })
})
