/**
 * Renderer benchmark. ARCHITECTURE 5: "Prototype the renderer against 5k objects on
 * day one of M2. Discovering this at the milestone exit means rewriting the renderer."
 *
 * Open /bench.html, or run scripts/bench-renderer.mjs for a headless run.
 *
 * Two numbers per strategy. Draw calls per frame is the architectural one: it depends
 * only on how the scene is structured, so the ranking holds on any machine. Frame time
 * is a sanity check from whatever GPU happens to be present, and is worth little on
 * software rasterisation.
 */

import { Application } from 'pixi.js'

import { installDrawCallCounter, readDrawCalls, resetDrawCalls } from './glCounter'
import { generateScene } from './scene'
import { graphicsPerObject } from './strategies/graphicsPerObject'
import { instanced } from './strategies/instanced'
import { sharedContext } from './strategies/sharedContext'
import type { Strategy } from './strategies/types'

const FRAMES = 120
const WARMUP = 20

/**
 * Give up on a strategy once it is definitively too slow.
 *
 * Under software rasterisation a strategy issuing thousands of draw calls per frame
 * takes minutes to finish 140 of them, and every extra frame only refines a number
 * that is already an order of magnitude past the budget. The draw-call count is
 * settled after the first frame anyway, and that is the number the decision rests on.
 */
const ABORT_AFTER_MS = 4000
const MIN_SAMPLES = 8

export type BenchResult = {
  strategy: string
  note: string
  objects: number
  drawCallsPerFrame: number
  medianFrameMs: number
  p95FrameMs: number
  buildMs: number
  estimatedFps: number
  frames: number
  /** True when the strategy was cut short for being far past any usable budget. */
  aborted: boolean
  /** Fraction of sampled pixels that are not background. Near zero means broken. */
  drawnRatio: number
}

const FACTORIES: Record<string, () => Strategy> = {
  'graphics-per-object': graphicsPerObject,
  'shared-context': sharedContext,
  'instanced-sdf': instanced,
}

export const STRATEGY_NAMES = Object.keys(FACTORIES)

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p))
  return sorted[index]
}

/**
 * Fraction of the canvas that is not background.
 *
 * A renderer that draws nothing is extremely fast, and its draw-call count looks like
 * a triumph. This caught exactly that: a shader that failed to compile reported one
 * draw call per frame and an empty canvas. Any strategy claiming a win has to prove
 * it put pixels on screen first.
 */
function coverage(app: Application): number {
  const extracted = app.renderer.extract.pixels(app.stage)
  const data = extracted.pixels
  let drawn = 0
  // Every 16th pixel: this is a smoke test, not a measurement.
  for (let i = 3; i < data.length; i += 4 * 16) {
    if (data[i] > 8) drawn += 1
  }
  return drawn / (data.length / (4 * 16))
}

async function runOne(app: Application, factory: () => Strategy, count: number): Promise<BenchResult> {
  const objects = generateScene(count, { w: app.screen.width, h: app.screen.height })
  const strategy = factory()

  const buildStart = performance.now()
  const view = strategy.build(objects)
  app.stage.addChild(view)
  const buildMs = performance.now() - buildStart

  strategy.setCamera(0, 0, 1)
  app.render()
  const drawnRatio = coverage(app)

  const samples: number[] = []
  let drawCallTotal = 0
  let measuredFrames = 0
  let aborted = false
  const deadline = performance.now() + ABORT_AFTER_MS

  for (let frame = 0; frame < FRAMES + WARMUP; frame += 1) {
    if (samples.length >= MIN_SAMPLES && performance.now() > deadline) {
      aborted = true
      break
    }

    // Nudge the camera every frame so nothing can be cached as a static scene, and
    // so the transform upload cost is part of the measurement.
    const t = frame / 60
    strategy.setCamera(Math.sin(t) * 40, Math.cos(t) * 40, 1)

    resetDrawCalls()
    const start = performance.now()
    app.render()
    const elapsed = performance.now() - start

    if (frame >= WARMUP) {
      samples.push(elapsed)
      drawCallTotal += readDrawCalls()
      measuredFrames += 1
    }

    // Yield so the tab stays responsive and the GPU queue can drain.
    if (frame % 10 === 0) await new Promise((resolve) => setTimeout(resolve, 0))
  }

  app.stage.removeChild(view)
  strategy.destroy()

  samples.sort((a, b) => a - b)
  const median = percentile(samples, 0.5)

  return {
    strategy: strategy.name,
    note: strategy.note,
    objects: count,
    drawCallsPerFrame: Math.round(drawCallTotal / Math.max(measuredFrames, 1)),
    medianFrameMs: Number(median.toFixed(2)),
    p95FrameMs: Number(percentile(samples, 0.95).toFixed(2)),
    buildMs: Number(buildMs.toFixed(1)),
    // Clamped: a median of 0.00 ms only means "below the timer's resolution", and
    // dividing by it produces a seven-figure fps that reads as a measurement.
    estimatedFps: Math.min(9999, Math.round(1000 / Math.max(median, 0.1))),
    frames: measuredFrames,
    aborted,
    drawnRatio: Number(drawnRatio.toFixed(3)),
  }
}

async function createApp(): Promise<Application> {
  const app = new Application()
  await app.init({
    width: 1600,
    height: 900,
    background: 0xf7f7f5,
    antialias: false,
    // WebGL for now: the SDF shader is written once in GLSL, and a WGSL twin is only
    // worth maintaining after the approach is settled.
    preference: 'webgl',
    autoStart: false,
  })
  document.getElementById('stage')?.appendChild(app.canvas)
  return app
}

/**
 * One strategy, one object count, one fresh WebGL context.
 *
 * The isolation is not tidiness. Running every strategy against a single context made
 * the naive ones exhaust the driver and lose it, and the next strategy then failed to
 * compile its shader - which reads exactly like a bug in that shader rather than
 * collateral damage from the run before it.
 */
export async function runSingle(strategyName: string, count: number): Promise<BenchResult> {
  installDrawCallCounter()
  const factory = FACTORIES[strategyName]
  if (factory === undefined) throw new Error(`unknown strategy: ${strategyName}`)

  const app = await createApp()
  try {
    return await runOne(app, factory, count)
  } finally {
    app.destroy(true, { children: true })
  }
}

export async function runBenchmark(counts: number[] = [5000, 20000]): Promise<BenchResult[]> {
  const results: BenchResult[] = []
  for (const count of counts) {
    for (const name of STRATEGY_NAMES) {
      results.push(await runSingle(name, count))
    }
  }
  return results
}

export function formatResults(results: BenchResult[]): string {
  const header = [
    'objects',
    'strategy',
    'draws/frame',
    'median ms',
    'p95 ms',
    'build ms',
    'fps',
    'frames',
    'drawn',
  ]
  const rows = results.map((r) => [
    String(r.objects),
    r.strategy,
    String(r.drawCallsPerFrame),
    r.medianFrameMs.toFixed(2),
    r.p95FrameMs.toFixed(2),
    r.buildMs.toFixed(1),
    String(r.estimatedFps),
    r.aborted ? `${r.frames} (cut)` : String(r.frames),
    r.drawnRatio < 0.001 ? `${r.drawnRatio} BROKEN` : String(r.drawnRatio),
  ])

  const widths = header.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => row[i].length)),
  )
  const line = (cells: string[]): string =>
    cells.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()

  return [line(header), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n')
}

declare global {
  interface Window {
    __bench?: {
      run: typeof runBenchmark
      runSingle: typeof runSingle
      format: typeof formatResults
      strategies: string[]
    }
    __benchResults?: BenchResult[]
  }
}

window.__bench = {
  run: runBenchmark,
  runSingle,
  format: formatResults,
  strategies: STRATEGY_NAMES,
}

// Auto-run when opened directly in a browser; the headless script drives it manually.
if (!location.search.includes('manual')) {
  void runBenchmark().then((results) => {
    window.__benchResults = results
    const output = document.getElementById('output')
    if (output !== null) output.textContent = formatResults(results)
    console.log(formatResults(results))
  })
}

