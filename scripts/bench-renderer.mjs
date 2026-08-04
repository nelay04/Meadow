/**
 * Headless renderer benchmark.
 *
 *   node scripts/bench-renderer.mjs [counts]     e.g. 5000,20000
 *
 * Starts vite, drives bench.html in Chromium, prints the table.
 *
 * Read the draw-call column, not the frame times. Headless Chromium usually falls
 * back to SwiftShader (software GL), so its absolute milliseconds say nothing about a
 * real GPU. Draw calls per frame depend only on how the scene is built, which is the
 * property ARCHITECTURE 5 is actually about.
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const counts = (process.argv[2] ?? '5000,20000').split(',').map(Number)
const PORT = process.env.BENCH_PORT ?? '3099'

const vite = spawn(
  'pnpm',
  ['--filter', 'web', 'exec', 'vite', '--port', PORT, '--strictPort'],
  { stdio: ['ignore', 'pipe', 'pipe'] },
)

let stopped = false
const stop = () => {
  if (stopped) return
  stopped = true
  vite.kill('SIGTERM')
}
process.on('exit', stop)
process.on('SIGINT', () => {
  stop()
  process.exit(130)
})

async function waitForServer(url, attempts = 60) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      // not up yet
    }
    await delay(500)
  }
  throw new Error(`vite did not start on ${url}`)
}

const base = `http://127.0.0.1:${PORT}`
await waitForServer(`${base}/bench.html`)

const browser = await chromium.launch({
  // The default headless build is the "shell", which ships no WebGL at all - Pixi
  // silently falls back to its canvas renderer and every number becomes meaningless.
  // channel: 'chromium' selects the full browser, which has SwiftShader.
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl'],
})

const page = await browser.newPage({ viewport: { width: 1700, height: 1000 } })
page.on('pageerror', (error) => console.error('page error:', error.message))
page.on('console', (message) => {
  if (message.type() === 'error') console.error('console:', message.text())
})

await page.goto(`${base}/bench.html?manual`, { waitUntil: 'load' })

const renderer = await page.evaluate(() => {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  if (gl === null) return 'no webgl'
  const info = gl.getExtension('WEBGL_debug_renderer_info')
  return info === null ? gl.getParameter(gl.VERSION) : gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
})

console.log(`GL renderer: ${renderer}\n`)
if (renderer === 'no webgl') {
  console.error('FAIL: no WebGL context, so Pixi would fall back to canvas rendering')
  await browser.close()
  stop()
  process.exit(1)
}

// One page load per measurement. A strategy that exhausts the driver loses the WebGL
// context, and everything measured afterwards in that page is nonsense - it shows up
// as "could not initialize shader" against the *next* strategy in the list.
const strategies = await page.evaluate(() => window.__bench.strategies)
const table = []

for (const count of counts) {
  for (const strategy of strategies) {
    await page.reload({ waitUntil: 'load' })
    const row = await page.evaluate(
      ([name, n]) => window.__bench.runSingle(name, n),
      [strategy, count],
    )
    const lost = await page.evaluate(() => {
      const canvas = document.querySelector('#stage canvas')
      const gl = canvas?.getContext('webgl2')
      return gl === null || gl === undefined ? 'gone' : gl.isContextLost()
    })
    console.log(
      `  ${String(count).padStart(6)}  ${strategy.padEnd(20)} ` +
        `${String(row.drawCallsPerFrame).padStart(6)} draws  ` +
        `${row.medianFrameMs.toFixed(2).padStart(8)} ms  drawn ${row.drawnRatio}` +
        (lost === true ? '  [context lost]' : ''),
    )
    table.push(row)
  }
}

const results = {
  table,
  text: await page.evaluate((rows) => window.__bench.format(rows), table),
}

console.log()
console.log(results.text)
console.log()

for (const row of results.table.slice(0, strategies.length)) {
  console.log(`${row.strategy.padEnd(20)} ${row.note}`)
}

await browser.close()
stop()

// Non-zero if the chosen strategy is not clearly the batched one, so this stays a
// gate rather than a report nobody reads.
const broken = results.table.filter((r) => r.drawnRatio < 0.001)
if (broken.length > 0) {
  console.error(
    `\nFAIL: drew nothing: ${broken.map((r) => `${r.strategy}@${r.objects}`).join(', ')}`,
  )
  process.exit(1)
}

const worst = Math.max(...results.table.map((r) => r.drawCallsPerFrame))
const best = Math.min(...results.table.map((r) => r.drawCallsPerFrame))
if (best > 16) {
  console.error(`\nFAIL: best strategy still issues ${best} draw calls per frame`)
  process.exit(1)
}
console.log(`\nbest ${best} draw calls/frame, worst ${worst}`)
process.exit(0)
