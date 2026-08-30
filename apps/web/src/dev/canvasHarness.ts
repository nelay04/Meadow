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

import {
  type FreedrawTip,
  type PenAssist,
  TIP_PROFILES,
  absoluteInk,
  absolutePoints,
  arrowGeometry,
  readBinding,
  arrowPolyline,
  pointAlongPath,
  pointOnCurve,
  resolveArrowProps,
  resolveFreedrawProps,
} from '@meadow/schema'
import * as Y from 'yjs'

import { arrowHandles } from '../canvas/arrowHandles'
import { CanvasEngine } from '../canvas/engine'
import type { ToolId } from '../canvas/tools/types'
import { DocEngineHost, observeDocument } from '../doc/engineHost'
import {
  addObjects,
  clearObjects,
  createDocSession,
  endGesture,
  objectFragment,
  readObjectById,
  setObjectText,
  updateObject,
} from '../doc/mutations'
import { fragmentToPlainText } from '../doc/richText'
import { createTextEditor } from '../overlay/textEditor'

const params = new URLSearchParams(location.search)
const count = Number(params.get('n') ?? '2000')
const stress = params.has('stress')
// Off by default. The interaction smoke test starts from ?n=0 and asserts exact
// counts, so seeded content has to be opted into rather than assumed.
const withText = params.has('text')
// Arrows are seeded separately from shapes because the question they answer is
// different: the batch scales with shape count, the arrow pass is re-recorded whole on
// any change. `arrowdrag` moves one of them per frame through the real mutation path,
// which is the case worth measuring.
const arrowCount = Number(params.get('arrows') ?? '0')
const arrowDrag = params.has('arrowdrag')

const TYPES = [
  'rect',
  'ellipse',
  'diamond',
  'parallelogram',
  'triangle',
  'trapezoid',
  'polygon',
  'cylinder',
] as const
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
let arrowIds: string[] = []

// The harness gets the real editor. A smoke test that drove a stub would prove the
// wiring and nothing about ProseMirror binding to the fragment.
const host = new DocEngineHost(() => session, { createEditor: createTextEditor })
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

  if (arrowCount > 0) {
    arrowIds = addObjects(
      session,
      Array.from({ length: arrowCount }, () => {
        const x = random() * spreadX
        const y = random() * spreadY
        const dx = (random() - 0.5) * 400
        const dy = (random() - 0.5) * 300
        const geometry = arrowGeometry([x, y, x + dx, y + dy])
        return {
          type: 'arrow' as const,
          x: geometry.x,
          y: geometry.y,
          w: geometry.w,
          h: geometry.h,
          props: {
            points: geometry.points,
            // Quantised, like the shapes above and like a real document. A continuous
            // width would give every arrow its own style and defeat grouping, which
            // would make the benchmark measure a board nobody has.
            stroke: PALETTE[Math.floor(random() * PALETTE.length)],
            strokeWidth: 1 + Math.floor(random() * 3),
          },
        }
      }),
    )
    endGesture(session)
  }

  if (!withText) return

  // One sticky and one text object at fixed coordinates, so the overlay has something
  // mounted and a test knows where to click without hunting for it.
  const [stickyId, textId] = addObjects(session, [
    // No stroke and no corner radius: the drift check finds this note by its fill
    // colour, and a dark outline or a rounded corner blurs the edge it measures.
    {
      type: 'sticky',
      x: 120,
      y: 120,
      w: 180,
      h: 180,
      props: { fill: 0xf5e6a3, strokeWidth: 0, cornerRadius: 0 },
    },
    { type: 'text', x: 380, y: 140, w: 260, h: 40 },
  ])
  setObjectText(session, stickyId, 'sticky note')
  setObjectText(session, textId, 'A text object on the canvas.')
  endGesture(session)
}

for (const button of document.querySelectorAll('[data-tool]')) {
  button.addEventListener('click', () => {
    engine.setTool(button.getAttribute('data-tool') as ToolId)
  })
}

// The nib picker, which the rail in the real app also drives through `setPen`. The
// angle comes with the tip for the reason BoardPage gives: a highlighter held at a
// calligraphy pen's angle draws nothing.
for (const button of document.querySelectorAll('[data-nib]')) {
  button.addEventListener('click', () => {
    const tip = button.getAttribute('data-nib') as FreedrawTip
    engine.setPen({ tip, angle: TIP_PROFILES[tip].angle })
    for (const other of document.querySelectorAll('[data-nib]')) {
      other.classList.toggle('active', other === button)
    }
  })
}

// The assist picker, driven the same way. `setPen` is one call for the whole pen, so
// there is nothing here the rail does not also do.
for (const button of document.querySelectorAll('[data-assist]')) {
  button.addEventListener('click', () => {
    engine.setPen({ assist: button.getAttribute('data-assist') as PenAssist })
    for (const other of document.querySelectorAll('[data-assist]')) {
      other.classList.toggle('active', other === button)
    }
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
  let dragPhase = 0

  const tick = (): void => {
    if (stress) {
      // Force a redraw every frame. The engine is dirty-flagged, so a still camera
      // renders nothing and would report a meaningless fps.
      engine.camera.panByScreen(direction * 2, 0)
      if (Math.abs(engine.camera.x) > 900) direction = -direction
    }

    if (arrowDrag && arrowIds.length > 0) {
      // One arrow moves; the rest are static. Through updateObject rather than by
      // poking the cache, so the measurement includes the transaction, the observer
      // and the cache update a real drag pays for.
      const id = arrowIds[0]
      const object = host.object(id)
      if (object !== undefined) {
        dragPhase += 0.08
        updateObject(session, id, { x: object.x + Math.sin(dragPhase) * 4 })
      }
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
  window.__canvas = {
    engine,
    stats: () => ({ ...engine.stats, fps }),
    // Place the camera exactly, rather than through a gesture. The overlay drift
    // check has to compare the two layers at specific awkward zoom levels, and a
    // wheel event cannot land on 1.37 reliably.
    setCamera: (next) => {
      engine.camera.x = next.x
      engine.camera.y = next.y
      engine.camera.zoom = next.zoom
      engine.camera.version += 1
      engine.requestRender()
    },
    transform: () => ({ ...engine.renderTransform }),
    overlayRect: (id) => {
      const element = engine.overlayElement(id)
      if (element === null) return null
      const canvas = document.querySelector('#canvas canvas')
      if (canvas === null) return null
      const box = element.getBoundingClientRect()
      const origin = canvas.getBoundingClientRect()
      return { x: box.x - origin.x, y: box.y - origin.y, w: box.width, h: box.height }
    },
    overlayCount: () => document.querySelectorAll('.meadow-overlay [data-object-id]').length,
    editingId: () => engine.editingId,
  }
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
  setText: (id: string, value: string) => {
    setObjectText(session, id, value)
    endGesture(session)
  },
  text: (id: string) => {
    const fragment = objectFragment(session, id)
    return fragment === null ? null : fragmentToPlainText(fragment)
  },
  clear: () => {
    clearObjects(session)
    endGesture(session)
  },
  points: (id: string) => {
    const arrow = readObjectById(session, id)
    return arrow === undefined ? null : absolutePoints(arrow, resolveArrowProps(arrow))
  },
  ink: (id: string) => {
    const object = readObjectById(session, id)
    if (object === undefined || object.type !== 'freedraw') return null
    const props = resolveFreedrawProps(object)
    return {
      tip: props.tip,
      size: props.size,
      angle: props.angle,
      // Samples rather than array length: a stride of three is an implementation
      // detail and a test asserting on it would break when it changed.
      samples: props.points.length / 3,
      // Whether the document names a colour, which is not the same as what it is
      // painted in: a stroke without one follows the surface's ink.
      colored: typeof object.props.stroke === 'number',
      box: { x: object.x, y: object.y, w: object.w, h: object.h },
      points: absoluteInk(object, props.points),
    }
  },
  // What style was actually written to an object, rather than what it resolves to.
  // The two assist modes differ by which props they write at all, and a resolved
  // colour would hide exactly the difference this is here to show.
  styleOf: (id: string) => {
    const object = readObjectById(session, id)
    if (object === undefined) return null
    const number = (key: string): number | null =>
      typeof object.props[key] === 'number' ? (object.props[key] as number) : null
    return {
      fillAlpha: number('fillAlpha'),
      stroke: number('stroke'),
      strokeWidth: number('strokeWidth'),
    }
  },
  // How an arrow is routed, for the checks about bending and the type picker.
  routing: (id: string) => {
    const arrow = readObjectById(session, id)
    if (arrow === undefined) return null
    const props = resolveArrowProps(arrow)
    return {
      routing: props.routing,
      curvature: props.curvature,
      curvatureEnd: props.curvatureEnd,
    }
  },
  // A world point on the *drawn* path. The only honest way for a test to click a
  // curve: computing where the bow ought to be from the outside would be a second
  // implementation of the curve, and it would agree with the first one right up until
  // one of them was wrong.
  pathPoint: (id: string, t: number) => {
    const arrow = readObjectById(session, id)
    if (arrow === undefined) return null
    const props = resolveArrowProps(arrow)
    if (props.routing !== 'curved') {
      const path = arrowPolyline(props.points, props.routing, props.curvature, props.curvatureEnd)
      const along = pointAlongPath(path, t)
      return { x: along.x + arrow.x, y: along.y + arrow.y }
    }
    const point = pointOnCurve(props.points, props.curvature, props.curvatureEnd, t)
    return { x: point.x + arrow.x, y: point.y + arrow.y }
  },
  // Where the tool thinks an arrow's handles are, in world units. Read from the same
  // module the select tool hit-tests against, so a test that grabs a handle grabs the
  // handle rather than a place a test computed it ought to be.
  handles: (id: string) => {
    const arrow = readObjectById(session, id)
    if (arrow === undefined) return null
    const handles = arrowHandles(arrow)
    return {
      start: handles.start,
      end: handles.end,
      bends: handles.bends.map((bend) => ({ id: bend.id, x: bend.at.x, y: bend.at.y })),
    }
  },
  bindings: () =>
    Array.from(session.bindings.values(), (map) => {
      const binding = readBinding(map)
      return { arrowId: binding.arrowId, end: binding.end, targetId: binding.targetId }
    }),
  // Ids are generated, so a test needs a way to ask for one by type.
  findByType: (type: string) => {
    for (const id of session.order.toArray()) {
      if (String(session.objects.get(id)?.get('type')) === type) return id
    }
    return null
  },
}

declare global {
  interface Window {
    __canvas?: {
      engine: CanvasEngine
      stats(): { renderMs: number; visible: number; total: number; zoom: number; fps: number }
      setCamera(next: { x: number; y: number; zoom: number }): void
      transform(): { tx: number; ty: number; scale: number }
      overlayRect(id: string): { x: number; y: number; w: number; h: number } | null
      overlayCount(): number
      editingId(): string | null
    }
    __doc?: {
      read(id: string): { x: number; y: number; w: number; h: number; type: string } | null
      orderLength(): number
      objectCount(): number
      setText(id: string, value: string): void
      clear(): void
      points(id: string): number[] | null
      ink(id: string): {
        tip: string
        size: number
        angle: number
        samples: number
        colored: boolean
        box: { x: number; y: number; w: number; h: number }
        points: number[]
      } | null
      styleOf(id: string): {
        fillAlpha: number | null
        stroke: number | null
        strokeWidth: number | null
      } | null
      routing(id: string): {
        routing: string
        curvature: number
        curvatureEnd: number
      } | null
      pathPoint(id: string, t: number): { x: number; y: number } | null
      handles(id: string): {
        start: { x: number; y: number }
        end: { x: number; y: number }
        bends: { id: string; x: number; y: number }[]
      } | null
      bindings(): { arrowId: string; end: string; targetId: string | null }[]
      text(id: string): string | null
      findByType(type: string): string | null
    }
  }
}
