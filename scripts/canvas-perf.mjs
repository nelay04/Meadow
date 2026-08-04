/**
 * Sustained frame cost for the whole canvas engine, not just the renderer.
 *
 *   node scripts/canvas-perf.mjs [objectCount]
 *
 * Drives /canvas-dev.html in stress mode, which pans the camera every frame so the
 * dirty flag never lets it idle, then reads the engine's own counters.
 *
 * Caveat that matters: headless Chromium rasterises in software (SwiftShader). The
 * CPU-side work this measures is real and portable - culling, the z-order walk, the
 * instance buffer fill, the overlay rebuild - but the GPU-side cost is not. Treat a
 * pass here as "the engine is not doing anything quadratic", and confirm the 60fps
 * target by opening the page on real hardware.
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const count = Number(process.argv[2] ?? '5000')
const PORT = process.env.PERF_PORT ?? '3096'
/** Frame budget at 60fps. */
const BUDGET_MS = 16.7

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
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } })
page.on('pageerror', (error) => console.error('page error:', error.message))

await page.goto(`${base}/canvas-dev.html?n=${count}&stress`, { waitUntil: 'load' })

// Let the scene build and the shader compile before sampling.
await page.waitForFunction(() => window.__canvas !== undefined, null, { timeout: 60000 })
await delay(4000)

const samples = []
for (let i = 0; i < 6; i += 1) {
  samples.push(await page.evaluate(() => window.__canvas.stats()))
  await delay(500)
}

const renderTimes = samples.map((s) => s.renderMs).sort((a, b) => a - b)
const median = renderTimes[Math.floor(renderTimes.length / 2)]
const worst = renderTimes[renderTimes.length - 1]
const fps = samples[samples.length - 1].fps
const last = samples[samples.length - 1]

const renderer = await page.evaluate(() => {
  const canvas = document.createElement('canvas')
  const gl = canvas.getContext('webgl2')
  const info = gl?.getExtension('WEBGL_debug_renderer_info')
  return info == null ? 'unknown' : gl.getParameter(info.UNMASKED_RENDERER_WEBGL)
})

const software = /swiftshader|llvmpipe|software/i.test(String(renderer))

console.log(`GL renderer:   ${renderer}`)
console.log(`objects:       ${last.total}`)
console.log(`drawn:         ${last.visible}`)
console.log(`zoom:          ${last.zoom.toFixed(2)}`)
console.log(`cpu per frame: median ${median.toFixed(2)} ms, worst ${worst.toFixed(2)} ms`)
console.log(`observed fps:  ${fps.toFixed(0)}${software ? '  (software rasteriser, not a verdict)' : ''}`)

await browser.close()
stop()

if (last.visible < count * 0.9) {
  console.error(`\nFAIL: only ${last.visible} of ${count} objects were drawn`)
  process.exit(1)
}
if (median > BUDGET_MS) {
  console.error(`\nFAIL: CPU frame cost ${median.toFixed(2)} ms exceeds the ${BUDGET_MS} ms budget`)
  process.exit(1)
}

console.log(`\nPASS: CPU-side frame cost for ${last.visible} objects is within budget.`)

if (software) {
  // Being explicit rather than letting a green tick imply more than it proved.
  // `app.render()` returns once the commands are queued; SwiftShader rasterises after
  // that, so the CPU timing above genuinely excludes the GPU cost. The observed fps is
  // the cost of software-rasterising a full-viewport fragment-bound scene and says
  // nothing about real hardware, in either direction.
  console.log(
    'NOT VERIFIED: the 60fps target. This run rasterised in software, which measures\n' +
      'CPU work only. Confirm on real hardware by opening\n' +
      `  /canvas-dev.html?n=${count}&stress\n` +
      'in a browser with GPU acceleration and reading the fps in the header.',
  )
  process.exit(0)
}

if (fps < 55) {
  console.error(`\nFAIL: ${fps.toFixed(0)} fps on hardware acceleration, below the 60fps target`)
  process.exit(1)
}
console.log(`VERIFIED: ${fps.toFixed(0)} fps with hardware acceleration.`)
process.exit(0)
