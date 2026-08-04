/**
 * Standalone canvas harness. /canvas-dev.html
 *
 * Runs the real CanvasEngine against a local Y.Doc, with no server and no auth, so the
 * engine can be exercised and profiled on its own. The bench in src/bench measures the
 * renderer in isolation; this measures the whole loop, which is what the M2 exit
 * criterion is actually about: culling, the z-order walk, the overlay, and the Y.Doc
 * round-trip a drag goes through.
 *
 *   /canvas-dev.html?n=5000          seed 5,000 objects
 *   /canvas-dev.html?n=5000&stress   pan every frame and report sustained fps
 */

import * as Y from 'yjs'

import { CanvasEngine } from '../canvas/engine'
import type { ToolId } from '../canvas/tools/types'
import { DocEngineHost, observeDocument } from '../doc/engineHost'
import { addObjects, createDocSession, endGesture } from '../doc/mutations'

const params = new URLSearchParams(location.search)
const count = Number(params.get('n') ?? '2000')
const stress = params.has('stress')

const TYPES = ['rect', 'ellipse', 'diamond'] as const
const PALETTE = [0x9ec9b0, 0x6fcf97, 0x2f7d4f, 0xe8c468, 0xd88c5a, 0x7b8fd4, 0xc47ba0, 0x5aa7c4]

function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const doc = new Y.Doc()
const session = createDocSession(doc, 'owner')

const host = new DocEngineHost(() => session)
host.observe()

const host_element = document.getElementById('canvas') as HTMLElement
const readout = document.getElementById('readout') as HTMLElement
const engine = new CanvasEngine(host_element, host, {
  onToolChange: (tool: ToolId) => {
    for (const button of document.querySelectorAll('[data-tool]')) {
      button.classList.toggle('active', button.getAttribute('data-tool') === tool)
    }
  },
})

function seed(): void {
  const random = seeded(0x5eed)
  // Spread over a world area roughly four viewports wide, so culling has something to
  // cull and "fit" produces a sensible starting zoom.
  const spreadX = 3200
  const spreadY = 1800

  const inputs = Array.from({ length: count }, () => {
    const w = 40 + random() * 120
    const h = 30 + random() * 90
    return {
      type: TYPES[Math.floor(random() * TYPES.length)],
      x: random() * (spreadX - w),
      y: random() * (spreadY - h),
      w,
      h,
      rotation: random() < 0.25 ? random() * Math.PI * 2 : 0,
      props: {
        fill: PALETTE[Math.floor(random() * PALETTE.length)],
        strokeWidth: 1 + Math.floor(random() * 2),
        cornerRadius: random() < 0.4 ? 4 + random() * 8 : 0,
      },
    }
  })

  addObjects(session, inputs)
  endGesture(session)
}

for (const button of document.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => {
    engine.setTool(button.getAttribute('data-tool') as ToolId)
  })
}

void engine.init().then(() => {
  observeDocument(session, engine)
  seed()
  engine.resync()
  engine.zoomToFit()

  let frames = 0
  let since = performance.now()
  let fps = 0
  let direction = 1

  const tick = (): void => {
    if (stress) {
      // Force a redraw every frame. The engine is dirty-flagged, so a still camera
      // renders nothing and would report a meaningless fps.
      engine.camera.panByScreen(direction * 2, 0)
      if (Math.abs(engine.camera.x) > 900) direction = -direction
    }

    frames += 1
    const now = performance.now()
    if (now - since >= 500) {
      fps = (frames * 1000) / (now - since)
      frames = 0
      since = now
    }

    const stats = engine.stats
    readout.textContent =
      `${stats.total} objects | ${stats.visible} drawn | ` +
      `zoom ${stats.zoom.toFixed(2)} | render ${stats.renderMs.toFixed(2)} ms` +
      (stress ? ` | ${fps.toFixed(0)} fps` : '')

    requestAnimationFrame(tick)
  }

  requestAnimationFrame(tick)

  // Exposed so the headless perf and smoke checks read the same numbers the page
  // shows, rather than a parallel measurement that could disagree with it.
  window.__canvas = { engine, stats: () => ({ ...engine.stats, fps }) }
})

// Document introspection for the smoke test. Reads straight from the Y.Doc, so an
// assertion is about the synced state rather than about what the engine cached.
window.__doc = {
  read: (id: string) => {
    const map = session.objects.get(id)
    if (map === undefined) return null
    return {
      x: Number(map.get('x')),
      y: Number(map.get('y')),
      w: Number(map.get('w')),
      h: Number(map.get('h')),
      type: String(map.get('type')),
    }
  },
  orderLength: () => session.order.length,
  objectCount: () => session.objects.size,
}

declare global {
  interface Window {
    __canvas?: {
      engine: CanvasEngine
      stats(): { renderMs: number; visible: number; total: number; zoom: number; fps: number }
    }
    __doc?: {
      read(id: string): { x: number; y: number; w: number; h: number; type: string } | null
      orderLength(): number
      objectCount(): number
    }
  }
}
