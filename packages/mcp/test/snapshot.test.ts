import { exportGlade } from '../../../apps/web/src/doc/interchange'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { applyEdits, createDocSession } from '../../../apps/web/src/doc/mutations'
import { planCreate } from '../src/plan'
import { MAX_SNAPSHOT_WIDTH, rasterize, renderSnapshot } from '../src/snapshot'

const pngSize = (bytes: Uint8Array): { width: number; height: number } => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  expect(String.fromCharCode(...bytes.slice(1, 4))).toBe('PNG')
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

async function board(
  nodes: Parameters<typeof planCreate>[1],
  edges: Parameters<typeof planCreate>[2] = [],
) {
  const session = createDocSession(new Y.Doc(), 'owner')
  applyEdits(session, await planCreate(session, nodes, edges))
  return exportGlade(session, { title: 'Snap', kind: 'glade' }, { app: 'test' })
}

describe('renderSnapshot', () => {
  it('draws shapes, arrows and labels as plain SVG', async () => {
    const file = await board(
      [
        { ref: 'a', label: 'Start' },
        { ref: 'b', label: 'End', type: 'diamond' },
      ],
      [{ from: 'a', to: 'b', label: 'go' }],
    )
    const snap = renderSnapshot(file)
    expect(snap.drawn).toBe(3)
    expect(snap.svg).toContain('Start')
    expect(snap.svg).toContain('go')
    expect(snap.svg.startsWith('<svg')).toBe(true)
  })

  it('escapes labels and never references anything outside the image', async () => {
    const file = await board([
      { ref: 'a', label: '<script>alert(1)</script> & "quotes"' },
      { ref: 'b', label: '<image href="http://example.com/x.png"/>' },
    ])
    const { svg } = renderSnapshot(file)
    expect(svg).not.toContain('<script')
    expect(svg).not.toContain('<image')
    expect(svg).toContain('&lt;script&gt;')
    // Markup only: the label's own words are allowed to say "href", as escaped text.
    const markup = svg.replace(/>[^<]*</g, '><')
    expect(markup).not.toMatch(/href|url\(|xlink|<foreignObject|<style|@import/i)
    expect(svg).toContain('&lt;image')
    expect(svg).toContain('href=&quot;http')
  })

  it('crops to a region and to ids, and reports what it left out', async () => {
    const file = await board([
      { ref: 'near', label: 'Near', x: 0, y: 0 },
      { ref: 'far', label: 'Far', x: 5000, y: 5000 },
    ])
    const inRegion = renderSnapshot(file, { region: { x: -50, y: -50, w: 400, h: 300 } })
    expect(inRegion.drawn).toBe(1)
    expect(inRegion.svg).toContain('Near')
    expect(inRegion.svg).not.toContain('Far')

    const farId = file.objects.find((object) => object.x === 5000)!.id
    const byId = renderSnapshot(file, { ids: [farId] })
    expect(byId.svg).toContain('Far')
    expect(byId.svg).not.toContain('Near')
  })

  it('caps how many objects it draws', async () => {
    const nodes = Array.from({ length: 30 }, (_, i) => ({
      ref: `n${i}`,
      label: `N${i}`,
      x: i * 200,
      y: 0,
    }))
    const snap = renderSnapshot(await board(nodes), { maxObjects: 10 })
    expect(snap.drawn).toBe(10)
    expect(snap.skipped).toBe(20)
  })

  it('leaves out text too small to read, and keeps it when it is not', async () => {
    const nodes = Array.from({ length: 4 }, (_, i) => ({
      ref: `n${i}`,
      label: 'Readable',
      x: i * 20000,
      y: 0,
    }))
    const file = await board(nodes)
    expect(renderSnapshot(file, { maxWidth: 400 }).svg).not.toContain('Readable')
    expect(renderSnapshot(file, { ids: [file.objects[0].id] }).svg).toContain('Readable')
  })

  it('paints the theme it is asked for', async () => {
    const file = await board([{ ref: 'a', label: 'A' }])
    expect(renderSnapshot(file, { theme: 'light' }).svg).toContain('#fbf9f5')
    expect(renderSnapshot(file, { theme: 'dark' }).svg).toContain('#12161b')
  })
})

describe('rasterize', () => {
  it('makes a PNG no wider than asked, and never wider than the ceiling', async () => {
    const file = await board([{ ref: 'a', label: 'Wide', x: 0, y: 0, w: 6000, h: 100 }])
    const small = pngSize(await rasterize(renderSnapshot(file, { maxWidth: 800 })))
    expect(small.width).toBeLessThanOrEqual(800)
    const huge = pngSize(await rasterize(renderSnapshot(file, { maxWidth: 100000 })))
    expect(huge.width).toBeLessThanOrEqual(MAX_SNAPSHOT_WIDTH)
  })

  it('renders an empty glade as a small blank image rather than failing', async () => {
    const file = await board([])
    const size = pngSize(await rasterize(renderSnapshot(file)))
    expect(size.width).toBeGreaterThan(0)
  })
})
