/**
 * Interaction smoke test for the canvas.
 *
 * Drives real pointer input at the harness page and asserts the document changed the
 * way it should. The unit tests cover the maths; this covers the wiring between a
 * pointer event, the tool state machine, the mutation layer, and the Y.Doc, which is
 * where a correct function called with the wrong arguments still passes every test.
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const PORT = process.env.SMOKE_PORT ?? '3095'
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
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } })
page.on('pageerror', (error) => {
  console.error('page error:', error.message)
  failures.push(`uncaught page error: ${error.message}`)
})

const failures = []
const checks = []

function check(name, condition, detail = '') {
  checks.push(name)
  if (condition) {
    console.log(`PASS  ${name}`)
  } else {
    console.log(`FAIL  ${name}${detail === '' ? '' : ` -- ${detail}`}`)
    failures.push(name)
  }
}

// Start empty so counts are unambiguous.
await page.goto(`${base}/canvas-dev.html?n=0`, { waitUntil: 'load' })
await page.waitForFunction(() => window.__canvas !== undefined, null, { timeout: 60000 })

const canvas = await page.locator('#canvas canvas')
const box = await canvas.boundingBox()
const at = (x, y) => ({ x: box.x + x, y: box.y + y })

const state = () =>
  page.evaluate(() => {
    const engine = window.__canvas.engine
    return {
      total: engine.stats.total,
      visible: engine.stats.visible,
      zoom: engine.stats.zoom,
      selection: engine.getSelection(),
      camera: { x: engine.camera.x, y: engine.camera.y },
    }
  })

const drag = async (from, to, steps = 12) => {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(to.x, to.y, { steps })
  await page.mouse.up()
  await delay(120)
}

// --- draw ---------------------------------------------------------------------

await page.click('[data-tool="rect"]')
await drag(at(150, 150), at(330, 270))
let now = await state()
check('drag with the rect tool creates one object', now.total === 1, `total=${now.total}`)
check('the new object is selected', now.selection.length === 1)

await page.click('[data-tool="ellipse"]')
await drag(at(420, 150), at(560, 260))
await page.click('[data-tool="diamond"]')
await drag(at(650, 150), at(790, 260))
now = await state()
check('each shape tool creates its own object', now.total === 3, `total=${now.total}`)

// --- select and move ----------------------------------------------------------

await page.click('[data-tool="select"]')

// Click empty space to clear, then click the first rect.
await page.mouse.click(at(900, 600).x, at(900, 600).y)
now = await state()
check('clicking empty space clears the selection', now.selection.length === 0)

await page.mouse.click(at(240, 210).x, at(240, 210).y)
now = await state()
check('clicking a shape selects it', now.selection.length === 1)

const before = await page.evaluate(() => {
  const engine = window.__canvas.engine
  const id = engine.getSelection()[0]
  return { id, ...window.__doc.read(id) }
})

await drag(at(240, 210), at(340, 310))
const after = await page.evaluate(
  (id) => window.__doc.read(id),
  before.id,
)
check(
  'dragging a selected shape moves it in the document',
  Math.abs(after.x - before.x - 100) < 12 && Math.abs(after.y - before.y - 100) < 12,
  `moved by ${(after.x - before.x).toFixed(1)}, ${(after.y - before.y).toFixed(1)}`,
)

// --- undo ---------------------------------------------------------------------

await page.keyboard.press('Control+z')
await delay(120)
const undone = await page.evaluate((id) => window.__doc.read(id), before.id)
check(
  'ctrl+z reverts the whole drag, not one frame of it',
  Math.abs(undone.x - before.x) < 0.5 && Math.abs(undone.y - before.y) < 0.5,
  `x=${undone.x.toFixed(1)} expected ${before.x.toFixed(1)}`,
)

await page.keyboard.press('Control+Shift+z')
await delay(120)
const redone = await page.evaluate((id) => window.__doc.read(id), before.id)
check('redo reapplies it', Math.abs(redone.x - after.x) < 0.5)

// --- marquee ------------------------------------------------------------------

await page.mouse.click(at(1000, 700).x, at(1000, 700).y)
await drag(at(380, 120), at(1000, 320))
now = await state()
check(
  'marquee selects the shapes it fully contains',
  now.selection.length === 2,
  `selected ${now.selection.length}`,
)

// --- delete -------------------------------------------------------------------

await page.keyboard.press('Delete')
await delay(150)
now = await state()
check('delete removes the selection', now.total === 1, `total=${now.total}`)
check('the selection is cleared after deleting', now.selection.length === 0)

const orderLength = await page.evaluate(() => window.__doc.orderLength())
check(
  'z-order stays in step with the object map',
  orderLength === now.total,
  `order=${orderLength} objects=${now.total}`,
)

// --- camera -------------------------------------------------------------------

const beforeCamera = (await state()).camera
await page.keyboard.down('Space')
await drag(at(600, 400), at(500, 350))
await page.keyboard.up('Space')
now = await state()
check(
  'space-drag pans the camera',
  Math.abs(now.camera.x - beforeCamera.x) > 50,
  `dx=${(now.camera.x - beforeCamera.x).toFixed(1)}`,
)

const zoomBefore = (await state()).zoom
await page.mouse.move(at(600, 400).x, at(600, 400).y)
await page.mouse.wheel(0, -240)
await delay(120)
now = await state()
check('ctrl-free wheel pans rather than zooming', Math.abs(now.zoom - zoomBefore) < 0.001)

await page.keyboard.down('Control')
await page.mouse.wheel(0, -240)
await page.keyboard.up('Control')
await delay(120)
now = await state()
check('ctrl+wheel zooms', now.zoom > zoomBefore, `zoom ${zoomBefore} -> ${now.zoom}`)

// --- arrows and bindings ------------------------------------------------------
//
// The unit tests cover the binding maths against plain snapshots. This covers the part
// they cannot: that a real drag with the arrow tool, landing on a real shape, produces
// a binding at all.

await page.evaluate(() => {
  window.__doc.clear()
  window.__canvas.setCamera({ x: 0, y: 0, zoom: 1 })
})
await delay(150)

await page.click('[data-tool="rect"]')
await drag(at(200, 400), at(320, 520))
await page.click('[data-tool="rect"]')
await drag(at(700, 400), at(820, 520))

const boxes = await page.evaluate(() => window.__canvas.engine.stats.total)
check('two boxes to connect', boxes === 2, `total=${boxes}`)

await page.click('[data-tool="arrow"]')
// Start and finish inside the two boxes, so both ends should attach.
await drag(at(260, 460), at(760, 460))
await delay(150)

let bindings = await page.evaluate(() => window.__doc.bindings())
check('dragging an arrow between two shapes binds both ends', bindings.length === 2, JSON.stringify(bindings))
check(
  'both bindings point at a real target',
  // The length matters: `[].every()` is true, and a vacuous pass next to a failing
  // count is exactly the sort of green tick that hides a bug.
  bindings.length === 2 && bindings.every((binding) => binding.targetId !== null),
  JSON.stringify(bindings),
)

const arrowId = await page.evaluate(() => window.__doc.findByType('arrow'))
const drawn = await page.evaluate((id) => window.__doc.points(id), arrowId)
check(
  'the endpoints are solved onto the shape edges, not left where the pointer was',
  Math.abs(drawn[0] - 320) < 8 && Math.abs(drawn[2] - 700) < 8,
  `points ${drawn.map((value) => value.toFixed(1)).join(', ')}`,
)

// Move the right-hand box and check the arrow comes with it.
await page.click('[data-tool="select"]')
await page.mouse.click(at(760, 460).x, at(760, 460).y)
await drag(at(760, 460), at(760, 620))
await delay(150)

const followed = await page.evaluate((id) => window.__doc.points(id), arrowId)
check(
  'the arrow follows its target when the target moves',
  followed[3] > drawn[3] + 80,
  `end y ${drawn[3].toFixed(1)} -> ${followed[3].toFixed(1)}`,
)

// Delete that box. ARCHITECTURE 4: the arrow survives with a loose end.
await page.keyboard.press('Delete')
await delay(150)

const survivors = await page.evaluate(() => ({
  total: window.__canvas.engine.stats.total,
  bindings: window.__doc.bindings(),
  points: window.__doc.points(window.__doc.findByType('arrow')),
}))
check(
  'deleting a target leaves the arrow alive',
  survivors.total === 2 && survivors.points !== null,
  `total=${survivors.total}`,
)
check(
  'the binding to the deleted shape goes free rather than vanishing',
  survivors.bindings.length === 2 &&
    survivors.bindings.filter((binding) => binding.targetId === null).length === 1,
  JSON.stringify(survivors.bindings),
)
check(
  'the loose end stays where the shape was',
  survivors.points !== null && Math.abs(survivors.points[3] - followed[3]) < 1,
  survivors.points === null
    ? 'the arrow is gone'
    : `${followed[3].toFixed(1)} -> ${survivors.points[3].toFixed(1)}`,
)

await browser.close()
stop()

console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
process.exit(0)
