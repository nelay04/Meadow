/**
 * Visual and diagnostic check for the ShapeBatch shader.
 *
 * Open /shader-check.html to eyeball every primitive at several zoom levels, or
 * run scripts/debug-shader.mjs for the GLSL compile log. A shader that fails to
 * compile still renders "successfully" as an empty canvas, so a page that shows the
 * output is worth more than a passing render call.
 */

import { Application, Container } from 'pixi.js'

import { DEFAULT_POLYGON_SIDES, cylinderCap, parallelogramSlant, trapezoidInset } from '@meadow/schema'

import {
  SHAPE_CYLINDER,
  SHAPE_DIAMOND,
  SHAPE_ELLIPSE,
  SHAPE_PARALLELOGRAM,
  SHAPE_POLYGON,
  SHAPE_RECT,
  SHAPE_TRAPEZOID,
  SHAPE_TRIANGLE,
  ShapeBatch,
  type ShapeKind,
} from '../canvas/renderers/shapeBatch'

const SAMPLES: { kind: ShapeKind; label: string }[] = [
  { kind: SHAPE_RECT, label: 'rect' },
  { kind: SHAPE_ELLIPSE, label: 'ellipse' },
  { kind: SHAPE_DIAMOND, label: 'diamond' },
  { kind: SHAPE_PARALLELOGRAM, label: 'parallelogram' },
  { kind: SHAPE_TRIANGLE, label: 'triangle' },
  { kind: SHAPE_TRAPEZOID, label: 'trapezoid' },
  { kind: SHAPE_POLYGON, label: 'polygon' },
  { kind: SHAPE_CYLINDER, label: 'cylinder' },
]

/**
 * The radius slot, per kind. The same decision `canvas/style.ts` makes, written out
 * here rather than imported because the check is meant to exercise the shader on
 * numbers it is handed, not to trust the app's own path to them.
 */
function radiusFor(kind: ShapeKind, w: number, h: number, corner: number): number {
  switch (kind) {
    case SHAPE_PARALLELOGRAM:
      return parallelogramSlant(w, h)
    case SHAPE_TRAPEZOID:
      return trapezoidInset(w, h)
    case SHAPE_POLYGON:
      return DEFAULT_POLYGON_SIDES
    case SHAPE_CYLINDER:
      return cylinderCap(h)
    case SHAPE_RECT:
      return corner
    default:
      return 0
  }
}

// The awkward zoom levels from ARCHITECTURE 5, not just 1 and 2.
const ZOOMS = [0.33, 0.67, 1, 1.37, 2.5]

export async function mountShaderCheck(root: HTMLElement): Promise<void> {
  for (const zoom of ZOOMS) {
    const panel = document.createElement('div')
    panel.className = 'panel'
    const title = document.createElement('h2')
    title.textContent = `zoom ${zoom}`
    panel.appendChild(title)
    root.appendChild(panel)

    const app = new Application()
    await app.init({
      width: 1270,
      height: 150,
      background: 0xf7f7f5,
      antialias: false,
      preference: 'webgl',
      autoStart: false,
    })
    panel.appendChild(app.canvas)

    const world = new Container()
    const batch = new ShapeBatch(SAMPLES.length * 2)
    batch.begin()

    SAMPLES.forEach((sample, index) => {
      batch.push({
        x: 20 + index * 150,
        y: 20,
        w: 110,
        h: 70,
        rotation: 0,
        kind: sample.kind,
        fill: 0x9ec9b0,
        fillAlpha: 1,
        stroke: 0x1f2a24,
        strokeAlpha: 1,
        strokeWidth: 2,
        radius: radiusFor(sample.kind, 110, 70, 10),
      })
      // A rotated copy, to check the vertex-side rotation.
      batch.push({
        x: 20 + index * 150,
        y: 100,
        w: 60,
        h: 34,
        rotation: Math.PI / 7,
        kind: sample.kind,
        fill: 0xe8c468,
        fillAlpha: 1,
        stroke: 0x1f2a24,
        strokeAlpha: 1,
        strokeWidth: 1,
        radius: radiusFor(sample.kind, 60, 34, 4),
      })
    })

    batch.end()
    world.addChild(batch.view)
    world.scale.set(zoom)
    app.stage.addChild(world)
    app.render()
  }
}

/**
 * Render the benchmark's own scene at full size, so a discrepancy between "the shader
 * works" and "the benchmark says it drew nothing" can be seen rather than reasoned
 * about. /shader-check.html?n=5000
 */
export async function mountBenchScene(root: HTMLElement, count: number): Promise<void> {
  const { generateScene } = await import('./scene')
  const { instanced } = await import('./strategies/instanced')

  const app = new Application()
  await app.init({
    width: 1600,
    height: 900,
    background: 0xf7f7f5,
    antialias: false,
    preference: 'webgl',
    autoStart: false,
  })
  app.canvas.style.width = '100%'
  app.canvas.style.height = 'auto'
  root.appendChild(app.canvas)

  const strategy = instanced()
  const view = strategy.build(generateScene(count, { w: app.screen.width, h: app.screen.height }))
  app.stage.addChild(view)
  strategy.setCamera(0, 0, 1)
  app.render()

  const extracted = app.renderer.extract.pixels(app.stage)
  let drawn = 0
  for (let i = 3; i < extracted.pixels.length; i += 4 * 16) {
    if (extracted.pixels[i] > 8) drawn += 1
  }
  const note = document.createElement('p')
  note.textContent = `${count} objects, extract coverage ${(
    drawn /
    (extracted.pixels.length / (4 * 16))
  ).toFixed(3)}`
  root.appendChild(note)
}

const root = document.getElementById('root')
const requested = Number(new URLSearchParams(location.search).get('n') ?? '0')
if (root !== null) {
  void (requested > 0 ? mountBenchScene(root, requested) : mountShaderCheck(root))
}
