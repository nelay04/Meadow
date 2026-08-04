/**
 * The DOM overlay, checked against what the browser actually paints.
 *
 * ARCHITECTURE 5 calls layer drift the hard part of M3, and is specific about how it
 * shows up: text sitting one or two pixels off its own shape at a fractional zoom,
 * which reads as a broken app rather than a rounding bug. Arithmetic tests cannot
 * catch that, because the failure is precisely that the browser and the GPU round the
 * same number differently. So this measures pixels.
 *
 * The method: seed a board with one sticky note whose fill colour appears nowhere
 * else, screenshot the canvas host at each of the zoom levels ARCHITECTURE names, and
 * find that colour's bounding box in the image. That box is where WebGL put the shape.
 * The overlay element's own client rect is where the browser put the text. The two
 * have to agree, and both have to agree with the transform the engine says it drew
 * with.
 *
 * Also covers the parts of the text lifecycle that only exist in a real browser:
 * viewport-only mounting, the TipTap mount and unmount, and auto-height.
 *
 *   node scripts/overlay-smoke.mjs
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const PORT = process.env.SMOKE_PORT ?? '3096'

/** ARCHITECTURE 5: "test explicitly at 0.33 / 0.67 / 1.37 / 2.5, not just 1 and 2". */
const ZOOMS = [0.33, 0.67, 1, 1.37, 2, 2.5]

/** The seeded sticky's fill, chosen in the harness so nothing else on screen matches. */
const STICKY_FILL = { r: 0xf5, g: 0xe6, b: 0xa3 }

/**
 * One CSS pixel. Anything inside this is a rounding difference nobody can see;
 * anything beyond it is the drift ARCHITECTURE warns about.
 */
const TOLERANCE_PX = 1

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

/**
 * Find the sticky's rectangle in a screenshot.
 *
 * Decoding happens inside the page: handing the PNG back as a data URL and letting the
 * browser decode it costs one round trip and saves a PNG decoder dependency, and the
 * image it reads is the composited result of both layers, which is the thing under
 * test.
 */
async function measurePainted(page, shot) {
  return page.evaluate(
    async ({ dataUrl, fill }) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()

      const surface = document.createElement('canvas')
      surface.width = image.width
      surface.height = image.height
      const context = surface.getContext('2d')
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, surface.width, surface.height)

      let minX = Infinity
      let minY = Infinity
      let maxX = -Infinity
      let maxY = -Infinity
      let count = 0

      for (let y = 0; y < surface.height; y += 1) {
        for (let x = 0; x < surface.width; x += 1) {
          const at = (y * surface.width + x) * 4
          // Loose enough for antialiasing on the edge pixels, tight enough that the
          // page background and the text glyphs never match.
          if (
            Math.abs(data[at] - fill.r) > 14 ||
            Math.abs(data[at + 1] - fill.g) > 14 ||
            Math.abs(data[at + 2] - fill.b) > 14
          ) {
            continue
          }
          count += 1
          if (x < minX) minX = x
          if (y < minY) minY = y
          if (x > maxX) maxX = x
          if (y > maxY) maxY = y
        }
      }

      if (count === 0) return null

      // Back to CSS pixels, so the result is comparable with a client rect.
      const ratio = image.width / surface.width || 1
      const scale = window.devicePixelRatio * ratio
      return {
        count,
        x: minX / scale,
        y: minY / scale,
        w: (maxX - minX + 1) / scale,
        h: (maxY - minY + 1) / scale,
      }
    },
    { dataUrl: `data:image/png;base64,${shot.toString('base64')}`, fill: STICKY_FILL },
  )
}

const settle = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(undefined)))
      }),
  )

// --- drift, at every awkward zoom, at two device pixel ratios ------------------

for (const dpr of [1, 2]) {
  const page = await browser.newPage({
    viewport: { width: 1000, height: 700 },
    deviceScaleFactor: dpr,
  })
  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(error.message))

  await page.goto(`${base}/canvas-dev.html?n=0&text`, { waitUntil: 'load' })
  await page.waitForFunction(() => window.__canvas !== undefined, null, { timeout: 60000 })
  await page.waitForFunction(() => window.__canvas.overlayCount() > 0, null, { timeout: 20000 })

  if (dpr === 1) {
    const fontsReady = await page.evaluate(() => ({
      inter: document.fonts.check('16px Inter'),
      mono: document.fonts.check('16px "JetBrains Mono"'),
      comic: document.fonts.check('16px "Comic Neue"'),
    }))
    check(
      'the self-hosted faces are loaded before the canvas renders',
      fontsReady.inter && fontsReady.mono && fontsReady.comic,
      JSON.stringify(fontsReady),
    )
  }

  const stickyId = await page.evaluate(() => window.__doc.findByType('sticky'))
  const host = await page.locator('#canvas').boundingBox()

  for (const zoom of ZOOMS) {
    // Centre the note, so at 2.5x it still fits on screen: a shape clipped by the
    // viewport reports a painted height smaller than its real one, and the check
    // would fail on the screenshot rather than on any drift. The fractional offset
    // keeps the camera off whole world units so the snapping is actually exercised
    // rather than landing on an integer by luck.
    await page.evaluate(
      ({ z, cx, cy, w, h }) => {
        window.__canvas.setCamera({
          x: cx - w / 2 / z + 0.37 / z,
          y: cy - h / 2 / z - 0.21 / z,
          zoom: z,
        })
      },
      { z: zoom, cx: 210, cy: 210, w: host.width, h: host.height },
    )
    await settle(page)

    const [transform, overlay, sticky] = await page.evaluate(
      (id) => [
        window.__canvas.transform(),
        window.__canvas.overlayRect(id),
        window.__doc.read(id),
      ],
      stickyId,
    )

    const shot = await page.screenshot({
      clip: { x: host.x, y: host.y, width: host.width, height: host.height },
    })
    const painted = await measurePainted(page, shot)

    if (painted === null || overlay === null) {
      check(`zoom ${zoom} dpr ${dpr}: the sticky is on screen`, false, 'nothing painted')
      continue
    }

    const expectedX = sticky.x * transform.scale + transform.tx
    const expectedY = sticky.y * transform.scale + transform.ty

    check(
      `zoom ${zoom} dpr ${dpr}: WebGL drew the sticky where the shared transform says`,
      Math.abs(painted.x - expectedX) <= TOLERANCE_PX &&
        Math.abs(painted.y - expectedY) <= TOLERANCE_PX,
      `painted ${painted.x.toFixed(2)},${painted.y.toFixed(2)} expected ${expectedX.toFixed(2)},${expectedY.toFixed(2)}`,
    )

    check(
      `zoom ${zoom} dpr ${dpr}: the overlay element sits on the painted shape`,
      Math.abs(overlay.x - painted.x) <= TOLERANCE_PX &&
        Math.abs(overlay.y - painted.y) <= TOLERANCE_PX,
      `overlay ${overlay.x.toFixed(2)},${overlay.y.toFixed(2)} painted ${painted.x.toFixed(2)},${painted.y.toFixed(2)}`,
    )

    check(
      `zoom ${zoom} dpr ${dpr}: the two layers agree on size`,
      Math.abs(overlay.w - painted.w) <= TOLERANCE_PX + 1 &&
        Math.abs(overlay.h - painted.h) <= TOLERANCE_PX + 1,
      `overlay ${overlay.w.toFixed(2)}x${overlay.h.toFixed(2)} painted ${painted.w.toFixed(2)}x${painted.h.toFixed(2)}`,
    )
  }

  check(`dpr ${dpr}: no uncaught page errors`, pageErrors.length === 0, pageErrors.join('; '))
  await page.close()
}

// --- lifecycle ----------------------------------------------------------------

const page = await browser.newPage({ viewport: { width: 1000, height: 700 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

await page.goto(`${base}/canvas-dev.html?n=0&text`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__canvas !== undefined, null, { timeout: 60000 })
await page.waitForFunction(() => window.__canvas.overlayCount() > 0, null, { timeout: 20000 })

await page.evaluate(() => window.__canvas.setCamera({ x: 0, y: 0, zoom: 1 }))
await settle(page)

check('both text-bearing objects are mounted', (await page.evaluate(() => window.__canvas.overlayCount())) === 2)

// Viewport-only mounting. ARCHITECTURE 5: 500 text objects must not become 500 nodes.
await page.evaluate(() => window.__canvas.setCamera({ x: 40000, y: 40000, zoom: 1 }))
await settle(page)
check(
  'objects outside the viewport are unmounted',
  (await page.evaluate(() => window.__canvas.overlayCount())) === 0,
)

await page.evaluate(() => window.__canvas.setCamera({ x: 0, y: 0, zoom: 1 }))
await settle(page)
check(
  'they remount when scrolled back into view',
  (await page.evaluate(() => window.__canvas.overlayCount())) === 2,
)

// --- editing ------------------------------------------------------------------

const stickyId = await page.evaluate(() => window.__doc.findByType('sticky'))
const canvasBox = await page.locator('#canvas canvas').boundingBox()
const sticky = await page.evaluate((id) => window.__doc.read(id), stickyId)

await page.mouse.dblclick(
  canvasBox.x + sticky.x + sticky.w / 2,
  canvasBox.y + sticky.y + sticky.h / 2,
)
await page.waitForFunction(() => window.__canvas.editingId() !== null, null, { timeout: 10000 })
check('double-clicking a sticky enters text editing', true)

check(
  'a real ProseMirror instance is mounted',
  (await page.locator('.meadow-overlay .ProseMirror').count()) === 1,
)

await page.keyboard.press('End')
await page.keyboard.type(' edited')
await page.waitForFunction(
  (id) => window.__doc.text(id)?.includes('edited') === true,
  stickyId,
  { timeout: 10000 },
)
check('typing writes straight through to the Y.Doc', true)

await page.keyboard.press('Escape')
await page.waitForFunction(() => window.__canvas.editingId() === null, null, { timeout: 10000 })
check('escape leaves editing', true)

check(
  'the editor is torn down and static HTML is back',
  (await page.locator('.meadow-overlay .ProseMirror').count()) === 0,
)

const rendered = await page.evaluate(
  (id) => document.querySelector(`[data-object-id="${id}"]`)?.textContent ?? '',
  stickyId,
)
check(
  'the idle overlay shows what was typed',
  rendered.includes('edited'),
  `rendered "${rendered}"`,
)

// --- auto-height --------------------------------------------------------------

const textId = await page.evaluate(() => window.__doc.findByType('text'))
const before = await page.evaluate((id) => window.__doc.read(id).h, textId)

await page.evaluate((id) => {
  // Enough text to wrap several times at the object's width.
  window.__doc.setText(id, 'wrap '.repeat(60).trim())
}, textId)
await settle(page)
await settle(page)

const after = await page.evaluate((id) => window.__doc.read(id).h, textId)
check(
  'a text object grows to fit its content',
  after > before + 20,
  `height went ${before} -> ${after}`,
)

// It has to settle, not oscillate: a measurement that never equals the stored height
// would write a patch on every frame forever.
await settle(page)
const settled = await page.evaluate((id) => window.__doc.read(id).h, textId)
await settle(page)
const stillSettled = await page.evaluate((id) => window.__doc.read(id).h, textId)
check('the measured height settles instead of oscillating', settled === stillSettled, `${settled} then ${stillSettled}`)

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '))

await browser.close()
stop()

console.log(`\n${failures.length === 0 ? 'all checks passed' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
