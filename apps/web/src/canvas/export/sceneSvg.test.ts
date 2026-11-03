/**
 * Tests for the image export's vector writer.
 *
 * The browser half (text read back off the overlay, fonts settling inside an image) is
 * covered by `pnpm smoke:canvas`, which needs a real layout engine. These cover what can
 * be wrong without one: a number written as `NaN`, a label written as markup, an outline
 * that is not the one the shader draws, and a PNG size past what a browser allocates.
 */

import { type ObjectData } from '@meadow/schema'
import { describe, expect, it } from 'vitest'

import { resolveStyle, shapeKindFor } from '../style'
import { SHAPE_POLYGON, SHAPE_RECT, SHAPE_TRIANGLE } from '../renderers/shapeBatch'
import { MAX_PNG_PIXELS, MAX_PNG_SIDE, pngSize } from './exportScene'
import {
  arrowSvg,
  emptyBounds,
  escapeXml,
  idSource,
  num,
  shapeOutline,
  shapeSvg,
  svgDocument,
} from './sceneSvg'
import { familiesOf, parseUnicodeRange } from './textSvg'

function object(patch: Partial<ObjectData>): ObjectData {
  return {
    id: 'a',
    type: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 50,
    rotation: 0,
    parentId: null,
    opacity: 1,
    props: {},
    ...patch,
  } as ObjectData
}

describe('numbers and text in the markup', () => {
  it('never writes a non-finite number', () => {
    expect(num(Number.NaN)).toBe('0')
    expect(num(Number.POSITIVE_INFINITY)).toBe('0')
    expect(num(-0.0001)).toBe('0')
    expect(num(1.23456)).toBe('1.235')
  })

  it('escapes anything that could become markup, and drops control characters', () => {
    expect(escapeXml('<script>&"\'')).toBe('&lt;script&gt;&amp;&quot;&#39;')
    expect(escapeXml('a\u0000b\u0007c')).toBe('abc')
  })

  it('keeps a title out of the document structure', () => {
    const svg = svgDocument({
      view: { x: 0, y: 0, w: 10, h: 10 },
      background: null,
      defs: '',
      body: '',
      title: '</title><script>alert(1)</script>',
    })
    expect(svg).not.toContain('<script>')
    expect(svg).toContain('&lt;/title&gt;')
  })
})

describe('outlines match the shader', () => {
  it('clamps a corner radius to half the shorter side, as sdRoundBox does', () => {
    expect(shapeOutline(SHAPE_RECT, { x: 0, y: 0, w: 100, h: 20 }, 50)).toContain('rx="10"')
  })

  it('puts a triangle apex centred on the top edge and its base across the box', () => {
    expect(shapeOutline(SHAPE_TRIANGLE, { x: 0, y: 0, w: 100, h: 80 }, 0)).toContain(
      'points="50 0 100 80 0 80"',
    )
  })

  it('puts a polygon vertex at the top, on the bounding ellipse', () => {
    const outline = shapeOutline(SHAPE_POLYGON, { x: 0, y: 0, w: 100, h: 100 }, 6)
    expect(outline.startsWith('<polygon points="50 0 ')).toBe(true)
    expect(outline.match(/ /g)?.length).toBeGreaterThanOrEqual(12)
  })

  it('paints nothing for a bare text box', () => {
    const text = object({ type: 'text' })
    const kind = shapeKindFor('text')
    expect(kind).not.toBeNull()
    expect(shapeSvg(text, resolveStyle(text, kind!), idSource())).toBe('')
  })

  it('gives every gradient and clip on a page of stickies its own id', () => {
    const ids = idSource()
    const sticky = object({ type: 'sticky', w: 200, h: 200 })
    const style = resolveStyle(sticky, shapeKindFor('sticky')!)
    const svg = shapeSvg(sticky, style, ids) + shapeSvg(sticky, style, ids)
    const declared = [...svg.matchAll(/ id="([^"]+)"/g)].map((match) => match[1])
    expect(declared.length).toBeGreaterThan(0)
    expect(new Set(declared).size).toBe(declared.length)
  })
})

describe('arrows', () => {
  it('grows the bounds by the stroke so a fitted frame does not crop the line', () => {
    const bounds = emptyBounds()
    arrowSvg(
      {
        points: [0, 0, 100, 0],
        stroke: 0,
        strokeAlpha: 1,
        strokeWidth: 4,
        startHead: 'none',
        endHead: 'none',
        headSize: 12,
      },
      bounds,
    )
    expect(bounds.minY).toBeLessThanOrEqual(-2)
    expect(bounds.maxY).toBeGreaterThanOrEqual(2)
  })

  it('draws an invisible arrow as nothing', () => {
    expect(
      arrowSvg({
        points: [0, 0, 100, 0],
        stroke: 0,
        strokeAlpha: 0,
        strokeWidth: 2,
        startHead: 'none',
        endHead: 'triangle',
        headSize: 12,
      }),
    ).toBe('')
  })
})

describe('fonts', () => {
  it('reads unicode-range, wildcards included', () => {
    expect(parseUnicodeRange('U+0000-00FF, U+0131, U+4??')).toEqual([
      [0, 0xff],
      [0x131, 0x131],
      [0x400, 0x4ff],
    ])
    expect(parseUnicodeRange('')).toBeNull()
  })

  it('reads a font stack as plain family names', () => {
    expect(familiesOf(`"Comic Neue", 'Noto Sans Bengali', cursive`)).toEqual([
      'comic neue',
      'noto sans bengali',
      'cursive',
    ])
  })
})

describe('PNG size', () => {
  it('uses the density asked for when it fits', () => {
    expect(pngSize({ x: 0, y: 0, w: 1000, h: 500 }, 4)).toEqual({
      width: 4000,
      height: 2000,
      density: 4,
      capped: false,
    })
  })

  it('caps a large frame and says so, inside both limits', () => {
    const size = pngSize({ x: 0, y: 0, w: 20_000, h: 3_000 }, 8)
    expect(size.capped).toBe(true)
    expect(size.width).toBeLessThanOrEqual(MAX_PNG_SIDE)
    expect(size.height).toBeLessThanOrEqual(MAX_PNG_SIDE)
    expect(size.width * size.height).toBeLessThanOrEqual(MAX_PNG_PIXELS)
  })
})
