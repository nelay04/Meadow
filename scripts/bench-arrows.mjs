/**
 * The one measurement that could overturn the arrow rendering decision.
 *
 *   node scripts/bench-arrows.mjs [arrowCount] [shapeCount]
 *
 * Arrows are drawn by a single `Graphics` that is cleared and re-recorded every frame,
 * rather than by the instanced batch. The claim is that re-recording a few hundred
 * short paths is cheap enough that per-arrow Graphics objects, dirty-rect rebuilding
 * and geometry caching are all unnecessary complexity.
 *
 * The case that would disprove it is one arrow moving among many static ones, because
 * a single moved endpoint invalidates the whole pass. So that is what this runs: an
 * identical scene with and without the arrows, both with one object moving every
 * frame, and the difference between them is what the arrow pass costs.
 *
 * Running the two configurations rather than one absolute number matters. Under
 * SwiftShader an absolute frame time says very little, but a difference between two
 * runs on the same rasteriser is a real signal about CPU work.
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

/**
 * Measured at a high count on purpose.
 *
 * A software rasteriser drifts by a couple of milliseconds between runs, and 200
 * arrows cost less than that, so measuring the design point directly returns noise -
 * the first attempt at this reported a *negative* cost twice. Measuring where the
 * signal is large and dividing gives a per-arrow figure that survives the drift, and
 * the pass is linear in arrow count, so dividing is legitimate.
 */
const arrowCount = Number(process.argv[2] ?? '2000')
const shapeCount = Number(process.argv[3] ?? '2000')
const PORT = process.env.BENCH_PORT ?? '3099'

/**
 * The count the decision is actually about. A busy board, four times the ten to fifty
 * arrows a normal one carries.
 */
const DESIGN_POINT = 200

/** What the arrow pass may take of a 16.7ms frame at the design point. */
const BUDGET_MS = 4

const vite = spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', PORT, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  vite.kill('SIGTERM')
}
process.on('exit', stop)

const base = `http://127.0.0.1:${PORT}`
for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`${base}/canvas-dev.html`)).ok) break
  } catch {
    /* not up yet */
  }
  await delay(500)
}

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

function summarise(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.floor(sorted.length * 0.95)],
    worst: sorted[sorted.length - 1],
  }
}

/**
 * One configuration, in its own page.
 *
 * A fresh page per run, for the reason the renderer bench found the hard way: several
 * heavy scenes in one context exhaust SwiftShader and the later run measures a
 * degraded rasteriser rather than its own code.
 */
async function run(arrows) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(
    `${base}/canvas-dev.html?n=${shapeCount}&arrows=${arrows}&arrowdrag`,
    { waitUntil: 'load' },
  )
  await page.waitForFunction(() => window.__canvas !== undefined, null, { timeout: 60000 })
  // Let the scene build and the shader compile before sampling.
  await delay(4000)

  const samples = []
  for (let i = 0; i < 90; i += 1) {
    const stats = await page.evaluate(() => window.__canvas.stats())
    if (stats.renderMs > 0) samples.push(stats.renderMs)
    await delay(30)
  }

  const drawn = await page.evaluate(() => window.__canvas.stats().visible)
  const total = await page.evaluate(() => window.__doc.objectCount())
  await page.close()

  if (errors.length > 0) throw new Error(`page errors: ${errors.join('; ')}`)
  return { ...summarise(samples), drawn, total }
}

/**
 * Alternate the two configurations rather than running each once.
 *
 * The first attempt at this ran A then B and reported that 200 arrows cost *minus*
 * 1.4ms, which is nonsense with a clear cause: two fresh pages on a software
 * rasteriser differ by more than the thing being measured. Interleaving and taking a
 * median of medians makes the comparison survive that drift. A result that still comes
 * out negative means the effect is genuinely below the noise floor, and the bench says
 * so rather than dressing it up.
 */
const REPEATS = 3
const withRuns = []
const withoutRuns = []

for (let repeat = 0; repeat < REPEATS; repeat += 1) {
  withRuns.push(await run(arrowCount))
  withoutRuns.push(await run(0))
}

await browser.close()
stop()

const medianOf = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const withArrows = {
  median: medianOf(withRuns.map((r) => r.median)),
  p95: medianOf(withRuns.map((r) => r.p95)),
  drawn: withRuns[0].drawn,
  total: withRuns[0].total,
  spread: Math.max(...withRuns.map((r) => r.median)) - Math.min(...withRuns.map((r) => r.median)),
}
const withoutArrows = {
  median: medianOf(withoutRuns.map((r) => r.median)),
  p95: medianOf(withoutRuns.map((r) => r.p95)),
  drawn: withoutRuns[0].drawn,
  total: withoutRuns[0].total,
  spread:
    Math.max(...withoutRuns.map((r) => r.median)) - Math.min(...withoutRuns.map((r) => r.median)),
}

const cost = withArrows.median - withoutArrows.median
const noise = Math.max(withArrows.spread, withoutArrows.spread)

console.log()
console.log(`scene:          ${shapeCount} shapes, one object moving every frame`)
console.log(`repeats:        ${REPEATS} of each, alternated`)
console.log(`with ${String(arrowCount).padEnd(4)} arrows: median ${withArrows.median.toFixed(2)} ms, p95 ${withArrows.p95.toFixed(2)} ms  (${withArrows.drawn} drawn of ${withArrows.total})`)
console.log(`with    0 arrows: median ${withoutArrows.median.toFixed(2)} ms, p95 ${withoutArrows.p95.toFixed(2)} ms  (${withoutArrows.drawn} drawn of ${withoutArrows.total})`)
console.log(`run-to-run spread: ${noise.toFixed(2)} ms`)
console.log()
const perArrowUs = (cost / arrowCount) * 1000
const atDesignPoint = (perArrowUs * DESIGN_POINT) / 1000
/** Where the arrow pass alone would eat a whole frame. */
const ceiling = Math.round(16.7 / (perArrowUs / 1000))

console.log(`arrow pass cost:  ${cost.toFixed(2)} ms per frame for ${arrowCount} arrows`)
console.log(`per arrow:        ${perArrowUs.toFixed(2)} us`)
console.log()
console.log(`at ${DESIGN_POINT} arrows:   ${atDesignPoint.toFixed(2)} ms of a 16.7 ms frame  (budget ${BUDGET_MS.toFixed(2)} ms)`)
console.log(`whole frame at:   ~${ceiling} arrows`)
console.log()

if (cost < noise) {
  console.log('INCONCLUSIVE: the measured cost is below the run-to-run spread. Re-run with')
  console.log('a larger arrow count so the signal clears the noise floor.')
  process.exit(1)
}

if (atDesignPoint <= BUDGET_MS) {
  console.log('PASS: rebuilding the whole arrow pass every frame is cheap enough at the')
  console.log('counts real boards carry. One shared Graphics, no dirty-rect tracking, no')
  console.log('per-arrow objects.')
  console.log()
  console.log(`Known ceiling: this is linear, so a board past roughly ${Math.round(ceiling / 4)} arrows would want`)
  console.log('dirty-rect rebuilding. That is a change to when the pass is rebuilt, not to')
  console.log('the layer or batching decisions in renderers/arrowPass.ts.')
  process.exit(0)
}

console.log('FAIL: the arrow pass is too expensive to rebuild whole at the design point.')
console.log('The fix is dirty-rect rebuilding, not per-arrow Graphics objects -- the')
console.log('layer and batching decisions in renderers/arrowPass.ts still hold.')
process.exit(1)
