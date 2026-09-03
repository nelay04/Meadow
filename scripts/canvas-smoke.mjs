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

// The other redo. Windows has meant Ctrl+Y by it for thirty years, and somebody who
// reaches for that one and gets nothing concludes there is nothing to redo.
await page.keyboard.press('Control+z')
await delay(120)
await page.keyboard.press('Control+y')
await delay(120)
const redoneAgain = await page.evaluate((id) => window.__doc.read(id), before.id)
check('ctrl+y redoes too', Math.abs(redoneAgain.x - after.x) < 0.5, `x=${redoneAgain.x.toFixed(1)}`)

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

// --- connector handles --------------------------------------------------------
//
// Dragging an arrow out of a shape's own edge dot, which is the gesture that replaced
// "switch to the arrow tool first". The dot sits *outside* the outline, so this also
// covers the thing that broke first: by the time you press one, the pointer is over
// empty canvas, and a tool that recomputes the host from the press position finds
// nothing and starts a marquee instead.

await page.evaluate(() => window.__doc.clear())
await delay(150)

await page.click('[data-tool="rect"]')
await drag(at(150, 150), at(330, 270))
await page.click('[data-tool="ellipse"]')
await drag(at(600, 380), at(780, 500))
await page.click('[data-tool="select"]')
await page.mouse.click(at(950, 620).x, at(950, 620).y)
await delay(150)

// Hover the rectangle so its dots appear, then drag from the east one to the ellipse.
await page.mouse.move(at(240, 210).x, at(240, 210).y)
await delay(200)
await drag(at(340, 210), at(690, 440), 16)

const connected = await page.evaluate(() => {
  const arrow = window.__doc.findByType('arrow')
  return {
    total: window.__doc.objectCount(),
    arrow,
    // Only this arrow's. `__doc.clear()` drops the objects and leaves the binding map
    // alone, so the earlier section's bindings are still in there.
    bindings: window.__doc.bindings().filter((binding) => binding.arrowId === arrow),
  }
})

check(
  'dragging from a connector dot creates an arrow',
  connected.total === 3 && typeof connected.arrow === 'string',
  `total=${connected.total} arrow=${connected.arrow}`,
)
check(
  'both of its ends are bound',
  connected.bindings.length === 2,
  JSON.stringify(connected.bindings),
)
check(
  'one end is the shape it was dragged from, the other is the shape it was dropped on',
  connected.bindings.every((binding) => binding.targetId !== null) &&
    connected.bindings
      .map((binding) => binding.end)
      .sort()
      .join(',') === 'end,start',
  JSON.stringify(connected.bindings.map((binding) => binding.end)),
)

// A press on a dot that goes nowhere must not leave a zero-length arrow behind.
await page.mouse.click(at(950, 620).x, at(950, 620).y)
await delay(150)
await page.mouse.move(at(240, 210).x, at(240, 210).y)
await delay(200)
await page.mouse.move(at(340, 210).x, at(340, 210).y)
await page.mouse.down()
await page.mouse.up()
await delay(200)

const afterTap = await page.evaluate(() => window.__doc.objectCount())
check('a click on a dot that never travels creates nothing', afterTap === 3, `total=${afterTap}`)

// --- arrow handles ------------------------------------------------------------
//
// A selected arrow gets three handles and no bounding box. These checks are about the
// two that were missing entirely: dragging an end to re-attach it, and dragging the
// middle to bend it. Both are hit-tested against geometry the engine derives rather
// than against anything stored, so a wrong derivation shows up as a gesture that does
// nothing at all.

await page.evaluate(() => window.__doc.clear())
await delay(150)

await page.click('[data-tool="rect"]')
await drag(at(150, 150), at(330, 270))
await page.click('[data-tool="ellipse"]')
await drag(at(620, 150), at(800, 270))
await page.click('[data-tool="diamond"]')
await drag(at(620, 420), at(800, 560))
await page.click('[data-tool="select"]')
await page.mouse.click(at(1000, 650).x, at(1000, 650).y)
await delay(150)

// Rectangle to ellipse, from the rectangle's east dot.
await page.mouse.move(at(240, 210).x, at(240, 210).y)
await delay(200)
await drag(at(340, 210), at(700, 210), 16)

const handleArrowId = await page.evaluate(() => window.__doc.findByType('arrow'))
const bindingsFor = () =>
  page.evaluate(
    (id) => window.__doc.bindings().filter((binding) => binding.arrowId === id),
    handleArrowId,
  )

const boundBoth = await bindingsFor()
check('the arrow starts bound at both ends', boundBoth.length === 2, JSON.stringify(boundBoth))

// Select it, then drag its head off the ellipse and onto the diamond.
await page.mouse.click(at(1000, 650).x, at(1000, 650).y)
await delay(150)
await page.evaluate((id) => window.__canvas.engine.setSelection([id]), handleArrowId)
await delay(200)

const head = await page.evaluate((id) => {
  const points = window.__doc.points(id)
  const { tx, ty, scale } = window.__canvas.transform()
  const last = points.length - 2
  return { x: points[last] * scale + tx, y: points[last + 1] * scale + ty }
}, handleArrowId)

await drag(at(head.x, head.y), at(710, 490), 14)

const rebound = await bindingsFor()
const endBinding = rebound.find((binding) => binding.end === 'end')
const diamondId = await page.evaluate(() => window.__doc.findByType('diamond'))
check(
  'dragging the head off one shape and onto another re-attaches it',
  endBinding !== undefined && endBinding.targetId === diamondId,
  JSON.stringify(rebound),
)
check(
  'the tail is left alone by a drag on the head',
  rebound.filter((binding) => binding.end === 'start').length === 1,
  JSON.stringify(rebound),
)

// Drop the head on empty canvas. The binding has to be cleared, not merely ignored,
// or the arrow springs back onto the shape the next time anything reflows it.
const head2 = await page.evaluate((id) => {
  const points = window.__doc.points(id)
  const { tx, ty, scale } = window.__canvas.transform()
  const last = points.length - 2
  return { x: points[last] * scale + tx, y: points[last + 1] * scale + ty }
}, handleArrowId)
await drag(at(head2.x, head2.y), at(1000, 620), 14)

const loose = await bindingsFor()
const looseEnd = loose.find((binding) => binding.end === 'end')
check(
  'dropping an end on empty canvas detaches it',
  looseEnd !== undefined && looseEnd.targetId === null,
  JSON.stringify(loose),
)

// --- bending ------------------------------------------------------------------

const straight = await page.evaluate((id) => window.__doc.routing(id), handleArrowId)
check(
  'an arrow is straight until somebody bends it',
  straight.routing === 'straight',
  JSON.stringify(straight),
)

const middle = await page.evaluate((id) => {
  const points = window.__doc.points(id)
  const { tx, ty, scale } = window.__canvas.transform()
  const last = points.length - 2
  return {
    x: ((points[0] + points[last]) / 2) * scale + tx,
    y: ((points[1] + points[last + 1]) / 2) * scale + ty,
  }
}, handleArrowId)

await drag(at(middle.x, middle.y), at(middle.x, middle.y - 120), 14)

const bent = await page.evaluate((id) => window.__doc.routing(id), handleArrowId)
check(
  'dragging the middle handle bends the arrow',
  bent.routing === 'curved' && Math.abs(bent.curvature) > 0.05,
  JSON.stringify(bent),
)

// The bow leaves the box its two endpoints span, so the bounds have to cover the
// drawn path. If they do not, the arrow is culled while visible and unclickable where
// it is painted.
const bowed = await page.evaluate((id) => {
  const box = window.__doc.read(id)
  const points = window.__doc.points(id)
  const last = points.length - 2
  return { box, endsTop: Math.min(points[1], points[last + 1]) }
}, handleArrowId)
check(
  'a bent arrow is bounded by its curve, not by its endpoints',
  bowed.box.y < bowed.endsTop - 5,
  `box.y=${bowed.box.y} ends=${bowed.endsTop}`,
)

// Clicking the bow itself selects it. Read off the same derivation the renderer uses,
// because the point of the check is that hit-testing and drawing agree.
const screenAt = async (t) =>
  page.evaluate(
    ([id, at]) => {
      const point = window.__doc.pathPoint(id, at)
      const { tx, ty, scale } = window.__canvas.transform()
      return { x: point.x * scale + tx, y: point.y * scale + ty }
    },
    [handleArrowId, t],
  )

await page.mouse.click(at(1080, 690).x, at(1080, 690).y)
await delay(150)
const onBow = await screenAt(0.5)
await page.mouse.click(at(onBow.x, onBow.y).x, at(onBow.x, onBow.y).y)
await delay(200)
const selected = await page.evaluate(() => window.__canvas.engine.getSelection())
check(
  'clicking the bow of a curved arrow selects it',
  selected.length === 1 && selected[0] === handleArrowId,
  JSON.stringify(selected),
)

// --- S curves ------------------------------------------------------------------
//
// The reason the curve is a cubic with two bows rather than a quadratic with one. A
// single bow can only lean the whole arrow one way; two can lean opposite ways, and
// that is the only shape that inflects.

const firstBend = await screenAt(1 / 3)
await drag(at(firstBend.x, firstBend.y), at(firstBend.x, firstBend.y - 110), 14)
const secondBend = await screenAt(2 / 3)
await drag(at(secondBend.x, secondBend.y), at(secondBend.x, secondBend.y + 110), 14)

const sCurve = await page.evaluate((id) => window.__doc.routing(id), handleArrowId)
check(
  'the two halves of a curve can lean opposite ways',
  sCurve.curvature * sCurve.curvatureEnd < 0,
  JSON.stringify(sCurve),
)

// And the drawn path actually crosses its own chord, which is what an S *is*. Signed
// distance from the chord, sampled along the curve: an arc keeps one sign throughout.
const inflects = await page.evaluate((id) => {
  const points = window.__doc.points(id)
  const last = points.length - 2
  const ax = points[0]
  const ay = points[1]
  const dx = points[last] - ax
  const dy = points[last + 1] - ay
  let positive = false
  let negative = false
  for (let step = 1; step < 12; step += 1) {
    const point = window.__doc.pathPoint(id, step / 12)
    const side = (point.x - ax) * dy - (point.y - ay) * dx
    if (side > 1) positive = true
    if (side < -1) negative = true
  }
  return positive && negative
}, handleArrowId)
check('an S curve crosses the line between its own endpoints', inflects)

// --- routing changes -----------------------------------------------------------
//
// The picker writes a routing; the points have to follow. An elbow's waypoints are
// stored rather than derived, so switching to it has to generate them and switching
// away has to drop them, and neither happens on its own.

await page.evaluate((id) => window.__canvas.engine.setArrowRouting(id, 'orthogonal'), handleArrowId)
await delay(250)
const elbow = await page.evaluate((id) => ({
  routing: window.__doc.routing(id).routing,
  points: window.__doc.points(id),
}), handleArrowId)
check(
  'switching to elbow actually generates the right-angled route',
  elbow.routing === 'orthogonal' && elbow.points.length > 4,
  JSON.stringify(elbow),
)

await page.evaluate((id) => window.__canvas.engine.setArrowRouting(id, 'straight'), handleArrowId)
await delay(250)
const flat = await page.evaluate((id) => ({
  routing: window.__doc.routing(id).routing,
  points: window.__doc.points(id),
}), handleArrowId)
check(
  'switching back to straight drops the waypoints rather than keeping the dogleg',
  flat.routing === 'straight' && flat.points.length === 4,
  JSON.stringify(flat),
)

// An elbow's handle slides its dogleg. It must not bend it into a curve, and it must
// not fall through to the arrow itself: dragging the body of an arrow with one end
// pinned to a shape stretches it, which is what made reaching for the corner send the
// connector across the board.
await page.evaluate((id) => window.__canvas.engine.setArrowRouting(id, 'orthogonal'), handleArrowId)
await delay(250)
const elbowHandles = await page.evaluate((id) => window.__doc.handles(id), handleArrowId)
check(
  'an elbow has exactly one handle, on its dogleg',
  elbowHandles.bends.length === 1 && elbowHandles.bends[0].id === 'elbow',
  JSON.stringify(elbowHandles.bends),
)

const beforeSlide = await page.evaluate((id) => window.__doc.points(id), handleArrowId)
const doglegAt = await page.evaluate((id) => {
  const bend = window.__doc.handles(id).bends[0]
  const { tx, ty, scale } = window.__canvas.transform()
  return { x: bend.x * scale + tx, y: bend.y * scale + ty }
}, handleArrowId)
await drag(at(doglegAt.x, doglegAt.y), at(doglegAt.x + 70, doglegAt.y + 40), 12)

const slid = await page.evaluate((id) => ({
  routing: window.__doc.routing(id).routing,
  elbow: window.__doc.routing(id).elbow,
  points: window.__doc.points(id),
}), handleArrowId)
check(
  'dragging the dogleg keeps it an elbow',
  slid.routing === 'orthogonal' && slid.points.length === 8,
  JSON.stringify(slid),
)
check(
  'the dogleg actually moved',
  Math.abs(slid.points[2] - beforeSlide[2]) > 10 || Math.abs(slid.points[3] - beforeSlide[3]) > 10,
  `${JSON.stringify(beforeSlide)} -> ${JSON.stringify(slid.points)}`,
)
check(
  'and the two ends stayed exactly where they were',
  Math.abs(slid.points[0] - beforeSlide[0]) < 0.5 &&
    Math.abs(slid.points[1] - beforeSlide[1]) < 0.5 &&
    Math.abs(slid.points[6] - beforeSlide[6]) < 0.5 &&
    Math.abs(slid.points[7] - beforeSlide[7]) < 0.5,
  `${JSON.stringify(beforeSlide)} -> ${JSON.stringify(slid.points)}`,
)

// --- the tool drops back to select -------------------------------------------

await page.click('[data-tool="rect"]')
await drag(at(140, 640), at(260, 720))
await delay(200)
const toolAfterDraw = await page.evaluate(() => window.__canvas.engine.activeTool)
check(
  'drawing a shape hands the pointer back to select',
  toolAfterDraw === 'select',
  String(toolAfterDraw),
)

// --- empty text objects --------------------------------------------------------

const countBefore = await page.evaluate(() => window.__doc.objectCount())
await page.click('[data-tool="text"]')
await page.mouse.click(at(200, 620).x, at(200, 620).y)
await delay(400)
await page.keyboard.press('Escape')
await delay(300)
const countAfter = await page.evaluate(() => window.__doc.objectCount())
check(
  'a text object nobody typed into is discarded rather than left as a ghost',
  countAfter === countBefore,
  `before=${countBefore} after=${countAfter}`,
)

await page.click('[data-tool="text"]')
await page.mouse.click(at(320, 620).x, at(320, 620).y)
await delay(400)
await page.keyboard.type('kept')
await delay(200)
await page.keyboard.press('Escape')
await delay(300)
const countTyped = await page.evaluate(() => window.__doc.objectCount())
check(
  'one that was typed into survives',
  countTyped === countBefore + 1,
  `before=${countBefore} after=${countTyped}`,
)

// --- freehand ink -------------------------------------------------------------
//
// The unit tests cover the nib maths against plain arrays. This covers what they
// cannot: that a real drag produces a stroke at all, that it lands in the document as
// one object and one undo step, and that what was drawn is what can be clicked.

await page.evaluate(() => {
  window.__doc.clear()
  window.__canvas.setCamera({ x: 0, y: 0, zoom: 1 })
})
await delay(150)

/** Drag through a run of points, which is what a stroke is and a two-point drag is not. */
const stroke = async (points, steps = 6) => {
  await page.mouse.move(points[0].x, points[0].y)
  await page.mouse.down()
  for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps })
  await page.mouse.up()
  await delay(150)
}

await page.click('[data-tool="pen"]')
// An L, so there is a large area inside the stroke's own box with no ink in it.
await stroke([at(200, 200), at(200, 400), at(400, 400)])

let inkId = await page.evaluate(() => window.__doc.findByType('freedraw'))
let inked = await page.evaluate((id) => window.__doc.ink(id), inkId)
check(
  'a drag with the pen writes one stroke to the document',
  (await page.evaluate(() => window.__doc.objectCount())) === 1 && inked !== null,
  `id=${inkId}`,
)
check(
  'the stroke keeps the shape of the drag rather than its two ends',
  inked !== null && inked.samples > 4,
  `samples=${inked === null ? 'none' : inked.samples}`,
)
check(
  'the box holds the ink, nib included',
  inked !== null &&
    inked.box.x < 200 &&
    inked.box.y < 200 &&
    inked.box.x + inked.box.w > 400 &&
    inked.box.y + inked.box.h > 400,
  inked === null ? 'no stroke' : JSON.stringify(inked.box),
)

const toolAfterStroke = await page.evaluate(() => window.__canvas.engine.activeTool)
check(
  'the pen stays in hand after a stroke, unlike every other creation tool',
  toolAfterStroke === 'pen',
  String(toolAfterStroke),
)

await stroke([at(600, 200), at(700, 300), at(800, 200)])
check(
  'a second drag is a second stroke, not an extension of the first',
  (await page.evaluate(() => window.__doc.objectCount())) === 2,
)

// One stroke, one undo step. Undoing a sketch a sample at a time is the failure this
// guards, and it is what streaming the stroke into the document would have produced.
await page.keyboard.press('Control+z')
await delay(200)
check(
  'ctrl+z takes back one whole stroke',
  (await page.evaluate(() => window.__doc.objectCount())) === 1,
)

// --- ink is clickable where it is drawn ---------------------------------------

await page.click('[data-tool="select"]')
await page.mouse.click(at(1000, 650).x, at(1000, 650).y)
await delay(150)
await page.mouse.click(at(200, 300).x, at(200, 300).y)
await delay(150)
check(
  'clicking on the stroke selects it',
  (await state()).selection.length === 1,
)

await page.mouse.click(at(1000, 650).x, at(1000, 650).y)
await delay(150)
// Inside the L's bounding box, nowhere near either leg. A box test would select here,
// and on a page of handwriting that is every stroke claiming the whole page.
await page.mouse.click(at(380, 230).x, at(380, 230).y)
await delay(150)
check(
  'clicking the empty space inside its box does not',
  (await state()).selection.length === 0,
)

// --- the nibs -----------------------------------------------------------------

for (const nib of ['round', 'felt', 'chisel', 'brush', 'highlighter']) {
  await page.evaluate(() => window.__doc.clear())
  await delay(120)
  await page.click(`[data-nib="${nib}"]`)
  await page.click('[data-tool="pen"]')
  await stroke([at(250, 300), at(400, 340), at(550, 300)])

  inkId = await page.evaluate(() => window.__doc.findByType('freedraw'))
  inked = await page.evaluate((id) => window.__doc.ink(id), inkId)
  check(
    `the ${nib} nib draws, and records itself on the stroke`,
    inked !== null && inked.tip === nib,
    inked === null ? 'no stroke' : inked.tip,
  )
  check(
    // The bug this catches is specific and silent: a bladed nib whose angle lies along
    // the stroke sweeps no area, so a highlighter drawn left to right is invisible.
    `the ${nib} nib leaves a mark with area`,
    inked !== null && inked.box.w > 10 && inked.box.h > 2,
    inked === null ? 'no stroke' : JSON.stringify(inked.box),
  )
}

// --- the pen assist -----------------------------------------------------------
//
// The unit tests fit shapes to arrays of numbers. What they cannot reach is the part
// that matters here: that a real drag, through the streamlining and the sampling and
// the tool state machine, still arrives at the recogniser as the shape somebody drew,
// that what comes out is a real object in the document rather than ink, and that the
// two modes differ by exactly one thing, which is what the object looks like.

await page.evaluate(() => window.__doc.clear())
await page.click('[data-nib="round"]')
await page.click('[data-assist="shapes"]')
await page.click('[data-tool="pen"]')
await delay(120)

// Densely sampled, because a hand is. Six moves along a two hundred pixel edge is a
// stroke made of six points, which is not what any pen produces.
const sketch = (points) => stroke(points, 20)

await sketch([at(200, 200), at(460, 200), at(460, 380), at(200, 380), at(202, 202)])
let assisted = await page.evaluate(() => window.__doc.findByType('rect'))
let shape = await page.evaluate((id) => (id === null ? null : window.__doc.read(id)), assisted)
check(
  'a box drawn with the pen becomes a rectangle',
  shape !== null && shape.type === 'rect',
  shape === null ? 'still ink' : shape.type,
)
check(
  'and it is the size it was drawn, not a default',
  shape !== null && Math.abs(shape.w - 260) < 30 && Math.abs(shape.h - 180) < 30,
  shape === null ? 'no shape' : `${Math.round(shape.w)}x${Math.round(shape.h)}`,
)
check(
  'the ink it replaced is not left behind under it',
  (await page.evaluate(() => window.__doc.objectCount())) === 1,
)

// Snapping to shapes promises the board's own shape, and the board's own shape carries
// no style of its own: that is what lets it follow the surface in both themes. A
// rectangle from here with a colour written on it would merely resemble one from the
// rail, and would stop resembling it the moment somebody switched theme.
let styled = await page.evaluate((id) => window.__doc.styleOf(id), assisted)
check(
  'a snapped shape is styled like one drawn with the shape tool, which is to say not at all',
  styled !== null &&
    styled.fillAlpha === null &&
    styled.stroke === null &&
    styled.strokeWidth === null,
  JSON.stringify(styled),
)

// --- the same stroke, tidied instead ------------------------------------------

await page.evaluate(() => window.__doc.clear())
await page.click('[data-assist="tidy"]')
await page.click('[data-tool="pen"]')
await delay(120)
await sketch([at(200, 200), at(460, 200), at(460, 380), at(200, 380), at(202, 202)])

assisted = await page.evaluate(() => window.__doc.findByType('rect'))
check(
  'tidying up makes the same rectangle, because it asks the same question',
  assisted !== null,
  assisted === null ? 'still ink' : 'rect',
)
styled = await page.evaluate((id) => (id === null ? null : window.__doc.styleOf(id)), assisted)
check(
  'but it keeps the pen: an outline at the nib width rather than a filled card',
  styled !== null && styled.fillAlpha === 0 && styled.strokeWidth > 0,
  JSON.stringify(styled),
)

// --- connectors ----------------------------------------------------------------

await page.evaluate(() => window.__doc.clear())
await page.click('[data-assist="shapes"]')
await page.click('[data-tool="pen"]')
await delay(120)
await sketch([at(200, 300), at(340, 302), at(480, 298), at(620, 300)])
assisted = await page.evaluate(() => window.__doc.findByType('line'))
check(
  'a straight stroke with no head becomes a line rather than an arrow',
  assisted !== null,
  assisted === null ? String(await page.evaluate(() => window.__doc.objectCount())) : 'line',
)

await page.evaluate(() => window.__doc.clear())
await delay(120)
// Along, up, over: an elbow, and each leg long enough that the corner is a corner
// rather than the end of the stroke.
await sketch([at(200, 200), at(440, 200), at(440, 420)])
assisted = await page.evaluate(() => window.__doc.findByType('line'))
let routed = await page.evaluate((id) => (id === null ? null : window.__doc.routing(id)), assisted)
check(
  'a right-angled stroke becomes an elbow rather than a diagonal',
  routed !== null && routed.routing === 'orthogonal',
  routed === null ? 'not a connector' : routed.routing,
)

// --- a recognised connector attaches, like any other -------------------------

await page.evaluate(() => window.__doc.clear())
await delay(120)
await page.click('[data-tool="rect"]')
await stroke([at(160, 200), at(300, 300)])
await page.click('[data-tool="rect"]')
await stroke([at(560, 200), at(700, 300)])
await page.click('[data-assist="shapes"]')
await page.click('[data-tool="pen"]')
await delay(120)
// From inside the left box to inside the right one, with a head drawn on the end.
await sketch([
  at(280, 250),
  at(400, 250),
  at(580, 250),
  at(548, 232),
  at(580, 250),
  at(548, 268),
])

// By arrow id, because `clear` empties the objects and leaves earlier bindings behind
// it: this is asking what the arrow just drawn is attached to, not what the document
// has ever held.
const penArrowId = await page.evaluate(() => window.__doc.findByType('arrow'))
const attached = await page.evaluate(
  (id) => window.__doc.bindings().filter((binding) => binding.arrowId === id),
  penArrowId,
)
check(
  'an arrow drawn with the pen between two shapes binds to both of them',
  attached.length === 2 && attached.every((binding) => binding.targetId !== null),
  JSON.stringify(attached.map((binding) => binding.end)),
)
check(
  'and it is an arrow, because a head was drawn on it',
  penArrowId !== null,
)

// --- what it refuses ----------------------------------------------------------

await page.evaluate(() => window.__doc.clear())
await delay(120)
await page.click('[data-tool="pen"]')
await sketch([
  at(200, 300),
  at(260, 240),
  at(320, 360),
  at(380, 240),
  at(440, 360),
  at(500, 240),
  at(560, 300),
])
check(
  'a scribble is left as ink rather than forced into a shape',
  (await page.evaluate(() => window.__doc.findByType('freedraw'))) !== null,
)

// A calligraphy nib is broad one way and a hairline the other, and nobody picks one up
// to draw a rectangle with. The setting outlives the session, so the tool has to
// withhold the assist on those nibs rather than trusting the rail to hide the row.
await page.evaluate(() => window.__doc.clear())
await page.click('[data-nib="chisel"]')
await page.click('[data-tool="pen"]')
await delay(120)
await sketch([at(200, 200), at(460, 200), at(460, 380), at(200, 380), at(202, 202)])
check(
  'a nib that does not take the assist draws ink, whatever the setting says',
  (await page.evaluate(() => window.__doc.findByType('freedraw'))) !== null &&
    (await page.evaluate(() => window.__doc.findByType('rect'))) === null,
)

// Put it back, so anything added after this runs against the default pen.
await page.click('[data-nib="round"]')
await page.click('[data-assist="off"]')

// --- clipboard ----------------------------------------------------------------
//
// Copy rides the browser's own copy/cut/paste events, which is the half no unit test
// can reach: the snapshot and the insert are covered in doc/clipboard.test.ts, and
// what is left is whether a real Ctrl+C on a real page reaches the engine at all,
// whether a custom clipboard type survives a round trip through the system clipboard,
// and whether the paste lands where the pointer is.

// Put the rail away and the camera back first. The pen sections above left a flyout
// open over the left of the canvas and the camera a long way from the origin, and
// every check below reads a world coordinate off a screen position.
await page.click('[data-tool="select"]')
await page.mouse.click(at(1000, 700).x, at(1000, 700).y)
await page.evaluate(() => {
  window.__doc.clear()
  window.__canvas.setCamera({ x: 0, y: 0, zoom: 1 })
})
await delay(200)

// And the canvas box, which is not where it was when `at` was defined: the host moved
// with the flyout. Every position in this section goes through `over` instead.
const clipboardBox = await canvas.boundingBox()
const over = (x, y) => ({ x: clipboardBox.x + x, y: clipboardBox.y + y })

await page.click('[data-tool="rect"]')
await drag(over(200, 200), over(360, 320))
await page.click('[data-tool="select"]')

const copied = await page.evaluate(() => {
  const id = window.__canvas.engine.getSelection()[0]
  window.__doc.setText(id, 'copy me')
  return id
})

await page.mouse.click(over(280, 260).x, over(280, 260).y)
await page.keyboard.press('Control+c')
await delay(120)

// Somewhere empty and a long way off, so "landed under the pointer" is unambiguous.
await page.mouse.move(over(800, 560).x, over(800, 560).y)
await page.keyboard.press('Control+v')
await delay(200)

const pasted = await page.evaluate((originalId) => {
  const engine = window.__canvas.engine
  const selection = engine.getSelection()
  return {
    total: window.__doc.objectCount(),
    selection,
    original: window.__doc.read(originalId),
    copy: selection.length === 1 ? window.__doc.read(selection[0]) : null,
    text: selection.length === 1 ? window.__doc.text(selection[0]) : null,
    isNew: selection.length === 1 && selection[0] !== originalId,
    transform: window.__canvas.transform(),
  }
}, copied)

check(
  'ctrl+c then ctrl+v pastes a second object',
  pasted.total === 2 && pasted.isNew,
  `total=${pasted.total} selection=${JSON.stringify(pasted.selection)}`,
)
check('the paste is left selected', pasted.selection.length === 1)
check(
  'the text comes with it',
  pasted.text === 'copy me',
  `text=${JSON.stringify(pasted.text)}`,
)
check(
  'the paste lands under the pointer, not on top of the original',
  pasted.copy !== null &&
    Math.abs(
      (pasted.copy.x + pasted.copy.w / 2) * pasted.transform.scale +
        pasted.transform.tx -
        800,
    ) < 12,
  pasted.copy === null ? 'nothing pasted' : `centre x ${pasted.copy.x + pasted.copy.w / 2}`,
)
check(
  'the original is left where it was',
  pasted.original !== null && Math.abs(pasted.original.x - 200) < 12,
  JSON.stringify(pasted.original),
)

// Ctrl+D, which has no clipboard event behind it and must not disturb the clipboard.
await page.keyboard.press('Control+d')
await delay(200)
const duplicated = await page.evaluate(() => ({
  total: window.__doc.objectCount(),
  selection: window.__canvas.engine.getSelection(),
}))
check(
  'ctrl+d duplicates the selection',
  duplicated.total === 3 && duplicated.selection.length === 1,
  `total=${duplicated.total}`,
)

// Cut, then paste it back: the object leaves the board and the clipboard still has it.
await page.keyboard.press('Control+x')
await delay(200)
const cut = await page.evaluate(() => ({
  total: window.__doc.objectCount(),
  selection: window.__canvas.engine.getSelection(),
}))
check(
  'ctrl+x takes the selection off the board',
  cut.total === 2 && cut.selection.length === 0,
  `total=${cut.total}`,
)

await page.mouse.move(over(500, 620).x, over(500, 620).y)
await page.keyboard.press('Control+v')
await delay(200)
const restored = await page.evaluate(() => window.__doc.objectCount())
check('what was cut can be pasted back', restored === 3, `total=${restored}`)

await browser.close()
stop()

console.log(`\n${checks.length - failures.length}/${checks.length} checks passed`)
if (failures.length > 0) {
  console.error(`FAILED: ${failures.join(', ')}`)
  process.exit(1)
}
process.exit(0)
