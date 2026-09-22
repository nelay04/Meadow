/**
 * The paper, checked against what the browser actually paints.
 *
 * The dot lattice and the graph ruling are CSS backgrounds: one tile, repeated. That
 * makes them cheap and it makes them vulnerable to a fault nothing else on the canvas
 * has - a tile that is not a whole number of pixels is rounded differently in each
 * repetition, and the paper comes out with dots of two or three different weights in
 * it. It is worst at the display scales and zooms people actually sit at, and it is
 * invisible to every unit test, because the numbers written into the style are all
 * perfectly correct. Only the pixels show it.
 *
 * So this screenshots the paper across the display scales Windows and macOS hand out
 * and the zooms a person lands on, finds every dot, and asserts they are all the same
 * shape. See `tileStep` in canvas/engine.ts for what makes that true, and
 * `scripts/tile-probe.mjs` for the measurement it came from.
 *
 *   node scripts/grid-smoke.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const PORT = process.env.SMOKE_PORT ?? '3097'
const base = `http://127.0.0.1:${PORT}`

/** Every display scale a mainstream desktop hands out, and the two that are worst. */
const RATIOS = [1, 1.25, 1.5, 2]
/** Round zooms, awkward ones, and the two the zoom buttons step through. */
const ZOOMS = [1, 1.25, 1.29, 1.37, 1.5, 1.75, 2]

/**
 * Longer than `GRID_SNAP_DELAY_MS` in the engine. The paper is snapped to the pixel
 * grid once the zoom has been still for a moment, and the point of this test is the
 * still picture people look at, not the frame mid-gesture.
 */
const SETTLE_MS = 300

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}${detail === '' ? '' : ` -- ${detail}`}`)
    failures.push(name)
  }
}

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

/*
 * The harness does not load styles.css, so the paper's own rules are injected here,
 * copied from it. What is under test is the size, the position and the fade the engine
 * writes onto the host, not the stylesheet, and taking the gradients from the same
 * place keeps the shape of the mark honest.
 */
const PAPER_CSS = `
  body { background: #12161c; }
  #canvas.grid-dots {
    --grid-dot: #8aa0b8;
    --dot-fade: 0;
    --grid-dot-fading: color-mix(in srgb, var(--grid-dot) calc(var(--dot-fade) * 100%), transparent);
    background-color: #12161c;
    background-image:
      radial-gradient(circle at center, var(--grid-dot) 0, var(--grid-dot) 1.15px, transparent 1.85px),
      radial-gradient(circle at center, var(--grid-dot-fading) 0, var(--grid-dot-fading) 1.15px, transparent 1.85px),
      radial-gradient(circle at center, var(--grid-dot-fading) 0, var(--grid-dot-fading) 1.15px, transparent 1.85px),
      radial-gradient(circle at center, var(--grid-dot-fading) 0, var(--grid-dot-fading) 1.15px, transparent 1.85px);
  }`

/**
 * Every mark in the shot, as the pixels it covers and the ink in it.
 *
 * The paper it is measured against is the modal colour of the image rather than a
 * corner pixel, because a corner can itself be a dot, and then every pixel reads as
 * ink and the whole field floods into one blob.
 */
async function marks(page, shot) {
  return page.evaluate(
    async ({ dataUrl }) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const surface = document.createElement('canvas')
      surface.width = image.width
      surface.height = image.height
      const context = surface.getContext('2d')
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, surface.width, surface.height)

      const counts = new Map()
      for (let i = 0; i < data.length; i += 4) {
        const key = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2]
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      let paper = 0
      let most = -1
      for (const [key, count] of counts) {
        if (count > most) {
          most = count
          paper = key
        }
      }
      const bg = [(paper >> 16) & 255, (paper >> 8) & 255, paper & 255]

      const ink = new Float64Array(surface.width * surface.height)
      for (let i = 0; i < ink.length; i += 1) {
        const at = i * 4
        ink[i] =
          Math.abs(data[at] - bg[0]) + Math.abs(data[at + 1] - bg[1]) + Math.abs(data[at + 2] - bg[2])
      }

      const seen = new Uint8Array(ink.length)
      const found = []
      for (let y = 3; y < surface.height - 3; y += 1) {
        for (let x = 3; x < surface.width - 3; x += 1) {
          const start = y * surface.width + x
          if (seen[start] === 1 || ink[start] < 4) continue
          let weight = 0
          let count = 0
          let clipped = false
          const stack = [start]
          seen[start] = 1
          while (stack.length > 0) {
            const at = stack.pop()
            const px = at % surface.width
            const py = (at - px) / surface.width
            if (px <= 2 || py <= 2 || px >= surface.width - 3 || py >= surface.height - 3) {
              clipped = true
            }
            weight += ink[at]
            count += 1
            for (const next of [at - 1, at + 1, at - surface.width, at + surface.width]) {
              if (next < 0 || next >= ink.length || seen[next] === 1 || ink[next] < 4) continue
              seen[next] = 1
              stack.push(next)
            }
          }
          // A clipped mark is not a small one, and anything this large is not a dot.
          if (!clipped && count <= 200) found.push({ weight, count })
        }
      }
      return found
    },
    { dataUrl: `data:image/png;base64,${shot.toString('base64')}` },
  )
}

for (const ratio of RATIOS) {
  const page = await browser.newPage({
    viewport: { width: 900, height: 600 },
    deviceScaleFactor: ratio,
  })
  await page.goto(`${base}/canvas-dev.html?n=0`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__canvas !== undefined, null, { timeout: 60000 })
  await page.evaluate((css) => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    document.querySelector('#canvas').classList.add('grid-dots')
    window.__canvas.engine.setGridPattern('dots')
  }, PAPER_CSS)

  for (const zoom of ZOOMS) {
    // A camera on no round number, so the lattice is not accidentally in phase with
    // the viewport and the test is measuring the tiling rather than a lucky offset.
    await page.evaluate((z) => window.__canvas.setCamera({ x: 13.3, y: 7.7, zoom: z }), zoom)
    await delay(SETTLE_MS)

    const found = await marks(page, await page.locator('#canvas').screenshot())
    const name = `scale ${ratio}, zoom ${zoom}: one dot, repeated`
    if (found.length < 100) {
      check(name, false, `only ${found.length} dots found - the paper did not render`)
      continue
    }

    /*
     * The field holds two lattices by design: the full-strength one and the in-between
     * dots part way through the fade that bridges a step in the cell. So the spread is
     * taken inside the heavy half, whose dots are all meant to be identical.
     */
    const weights = found.map((mark) => mark.weight).sort((a, b) => a - b)
    const midpoint = (weights[0] + weights[weights.length - 1]) / 2
    const heavy = found.filter((mark) => mark.weight >= midpoint)
    const shapes = new Set(heavy.map((mark) => mark.count))

    check(name, shapes.size === 1, `${shapes.size} different dot shapes: ${[...shapes].sort((a, b) => a - b).join(', ')}px`)
  }

  await page.close()
}

await browser.close()
stop()

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('all checks passed')
