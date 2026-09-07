/** README screenshots, driven through the real app. */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const API_PORT = process.env.SHOT_API_PORT ?? '8018'
const WEB_PORT = process.env.SHOT_WEB_PORT ?? '3098'
const OUT = process.env.SHOT_OUT ?? 'docs/media'
mkdirSync(OUT, { recursive: true })

const procs = []
const stop = () => { for (const p of procs) p.kill('SIGTERM'); procs.length = 0 }
process.on('exit', stop)

const api = spawn('bash', ['-c',
  `cd services/api && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT} --log-level warning`], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, MEADOW_RATE_LIMIT_ENABLED: 'false', MEADOW_SMTP_HOST: '', MEADOW_SMTP_FROM: '' },
})
procs.push(api)
api.stderr.on('data', (d) => { const s = String(d); if (/error|Traceback/i.test(s)) console.log('api:', s.trim().slice(0, 300)) })

const web = spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', WEB_PORT, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT, WEB_PORT },
})
procs.push(web)

async function waitFor(url, label) {
  for (let i = 0; i < 90; i += 1) {
    try { if ((await fetch(url)).ok) return } catch { /* not up */ }
    await delay(500)
  }
  throw new Error(`${label} did not start at ${url}`)
}

const apiBase = `http://127.0.0.1:${API_PORT}`
const webBase = `http://127.0.0.1:${WEB_PORT}`
await waitFor(`${apiBase}/healthz`, 'api')
await waitFor(webBase, 'web')
console.log('servers up')

const stamp = Date.now()
const password = 'correct-horse-battery-staple'
async function account(name, email) {
  await fetch(`${apiBase}/api/v1/auth/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: name }),
  })
  const login = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const auth = await login.json()
  const token = auth.access_token ?? auth.accessToken
  if (typeof token !== 'string') throw new Error(`login failed: ${JSON.stringify(auth).slice(0, 300)}`)
  const me = await (await fetch(`${apiBase}/api/v1/auth/me`, {
    headers: { authorization: `Bearer ${token}` },
  })).json()
  return { email, token, id: me.id }
}

const owner = await account('Snowy', `shots-${stamp}@meadow.dev`)
const guest = await account('Ana Okonkwo', `shots2-${stamp}@meadow.dev`)
console.log('accounts made')

const authed = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` })
const workspaces = await (await fetch(`${apiBase}/api/v1/workspaces`, { headers: authed(owner.token) })).json()
const workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces.items?.[0])?.id

async function board(title, kind) {
  const r = await fetch(`${apiBase}/api/v1/boards`, {
    method: 'POST', headers: authed(owner.token),
    body: JSON.stringify({ workspace_id: workspaceId, title, kind }),
  })
  if (!r.ok) throw new Error(`create ${title}: ${r.status} ${(await r.text()).slice(0, 200)}`)
  return r.json()
}


const glade = await board('Realtime sync', 'glade')
const lea = await board('Field diary', 'lea')
const retro = await board('Retro board', 'glade')
await board('Reading notes', 'lea')
const plan = await board('Release plan', 'glade')
console.log('boards made')

// The second account sees the glade too, so presence has somebody to show.
await fetch(`${apiBase}/api/v1/boards/${glade.id}/members`, {
  method: 'POST', headers: authed(owner.token),
  body: JSON.stringify({ user_id: guest.id, role: 'editor' }),
}).then(async (r) => { if (!r.ok) console.log('member add:', r.status, (await r.text()).slice(0, 200)) })

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

async function session(who, theme, capture = null) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 880 },
    deviceScaleFactor: 2,
    colorScheme: theme === 'dark' ? 'dark' : 'light',
  })
  await context.addInitScript((t) => {
    try {
      localStorage.setItem('meadow.theme', t)
      // ui/paper.ts. Vintage is the default stock; the dark one is the app's own
      // surface, which is what a diary should be printed on beside a dark canvas.
      localStorage.setItem('meadow.lea.paper', 'dark')
    } catch { /* ignore */ }
  }, theme)
  const page = await context.newPage()
  page.on('pageerror', (e) => console.log('page error:', e.message))
  await page.goto(webBase, { waitUntil: 'load' })
  await page.waitForSelector('input[type="email"]', { timeout: 30000 })
  if (capture !== null) {
    await delay(2500)
    await page.screenshot({ path: `${OUT}/${capture}.png` })
    console.log(`wrote ${OUT}/${capture}.png`)
  }
  await page.fill('input[type="email"]', who.email)
  await page.fill('input[type="password"]', password)
  await page.click('button[type="submit"]')
  await page.waitForSelector('.board-card, .boards-page, main', { timeout: 30000 })
  await delay(1500)
  const skip = page.locator('.splash-skip')
  if (await skip.count()) { await skip.click(); await delay(900) }
  return page
}

/**
 * Force the board preview to be recaptured.
 *
 * `BoardPage` captures 4s after mount, on a two-minute timer, and whenever the tab is
 * hidden. Everything drawn here lands after the first of those and long before the
 * second, so without this the list shows a board as it was before it was drawn on.
 */
const recapture = async (p) => {
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await delay(3000)
  await p.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await delay(500)
}

const shot = async (p, name) => {
  await delay(1000)
  await p.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`wrote ${OUT}/${name}.png`)
}

async function openBoard(p, id, kind = 'glade') {
  // Out to the list first. A board-to-board hash change routes but leaves the canvas
  // holding the objects of the board it was already showing; passing through the list
  // unmounts it. Reloading would do it too, but a reload here loses the session.
  await p.goto(`${webBase}/#/`)
  await p.waitForSelector('.board-card', { timeout: 30000 })
  await delay(800)
  await p.goto(`${webBase}/#/${kind}/${id}`)
  try {
    await p.waitForSelector('.canvas-host canvas', { timeout: 30000 })
  } catch (error) {
    await p.screenshot({ path: `${OUT}/debug-${kind}.png` })
    console.log('url:', p.url())
    console.log('body:', (await p.locator('body').innerText()).slice(0, 600))
    throw error
  }
  await p.waitForFunction(() => {
    const r = document.querySelector('.role')?.textContent?.trim()
    return r === 'owner' || r === 'editor'
  }, null, { timeout: 30000 })
  await delay(2000)
  return p.locator('.canvas-host canvas').boundingBox()
}

const page = await session(owner, 'dark', 'sign-in')

/* ---------- the glade: a diagram, drawn with the real tools ---------- */
let box = await openBoard(page, glade.id)
const at = (x, y) => ({ x: box.x + x, y: box.y + y })

async function drag(p, from, to, steps = 18) {
  await p.mouse.move(from.x, from.y)
  await p.mouse.down()
  await p.mouse.move(to.x, to.y, { steps })
  await p.mouse.up()
  await delay(400)
}

async function shape(key, a, b) {
  await page.keyboard.press(key)
  await delay(250)
  await drag(page, at(a[0], a[1]), at(b[0], b[1]))
}

async function type(text) {
  await page.waitForSelector('.meadow-overlay .ProseMirror', { timeout: 10000 })
  await delay(700)
  await page.keyboard.type(text, { delay: 25 })
  await delay(300)
  await page.keyboard.press('Escape')
  await delay(400)
}

async function label(centre, text) {
  await page.mouse.dblclick(box.x + centre[0], box.y + centre[1])
  await type(text)
}

// Meadow's own architecture, drawn in Meadow: the path one edit takes.
await shape('r', [140, 380], [300, 450])
await label([220, 415], 'Tools')

await shape('o', [360, 370], [560, 460])
await label([460, 415], 'Y.Doc')

await shape('r', [360, 190], [560, 260])
await label([460, 225], 'PixiJS layer')

await shape('r', [360, 570], [560, 640])
await label([460, 605], 'DOM overlay')

await shape('d', [640, 355], [880, 475])
await label([760, 415], 'Handshake')

await shape('r', [950, 380], [1130, 450])
await label([1040, 415], 'YRoom')

await shape('y', [950, 570], [1130, 670])
await label([1040, 620], 'Postgres')

await shape('y', [950, 180], [1130, 275])
await label([1040, 227], 'Redis')

async function arrow(a, b) {
  await page.keyboard.press('a')
  await delay(250)
  await drag(page, at(a[0], a[1]), at(b[0], b[1]), 22)
}

await arrow([305, 415], [355, 415])
await arrow([460, 365], [460, 265])
await arrow([460, 465], [460, 565])
await arrow([565, 415], [635, 415])
await arrow([885, 415], [945, 415])
await arrow([1040, 455], [1040, 565])
await arrow([870, 380], [1000, 285])

await page.keyboard.press('s')
await delay(250)
await page.mouse.click(box.x + 1290, box.y + 560)
await type('A local drag and a peer’s edit take the same path.')

await page.keyboard.press('v')
await page.keyboard.press('Escape')
await delay(600)
await recapture(page)

/* ---------- presence: a second person on the same glade ---------- */
const other = await session(guest, 'dark')
const otherBox = await openBoard(other, glade.id)
await other.mouse.move(otherBox.x + 700, otherBox.y + 430, { steps: 10 })
await other.mouse.move(otherBox.x + 663, otherBox.y + 447, { steps: 12 })
await delay(1500)

await page.bringToFront()
await delay(1200)
await shot(page, 'glade')

/* ---------- the lea: a ruled diary page ---------- */
box = await openBoard(page, lea.id, 'lea')

// The subject line and the date are the page's printed header, not objects on it.
const subject = page.locator('[aria-label="Subject of this page"]')
if (await subject.count()) {
  await subject.click()
  await page.keyboard.type('Sunday, and the teardown race', { delay: 25 })
  await page.keyboard.press('Tab')
  await delay(400)
}

const LINES = [
  'Sunday evening. Nothing to ship, and nobody',
  'waiting on it.',
  '',
  'Spent the afternoon on the teardown race.',
  'Last client leaves, the room stops, and the',
  'write it was still holding dies with it.',
  'Type, close the tab, gone.',
  '',
  'Shielded the transaction. It holds now.',
  'Nobody will ever see the bug that is not',
  'there any more.',
]

await page.mouse.click(box.x + box.width / 2, box.y + 330)
await delay(900)
if (await page.locator('.meadow-overlay .ProseMirror').count()) {
  for (const line of LINES) {
    if (line !== '') await page.keyboard.type(line, { delay: 22 })
    await page.keyboard.press('Enter')
    await delay(300)
  }
  await page.keyboard.press('Escape')
} else {
  console.log('lea: clicking a rule did not open an editor')
}
await delay(900)
await shot(page, 'lea')

/* ---------- a couple of other boards, so the list is not a grid of blanks ---------- */
box = await openBoard(page, retro.id)
const STICKIES = [
  [280, 260, 'Ink is an object, not a layer.'],
  [560, 300, 'One draw call at five thousand shapes.'],
  [840, 250, 'Undo can resurrect what a peer deleted.'],
  [420, 520, 'The socket is the security boundary.'],
  [720, 560, 'Offline first, then merge. Never the reverse.'],
]
for (const [x, y, text] of STICKIES) {
  await page.keyboard.press('s')
  await delay(250)
  await page.mouse.click(box.x + x, box.y + y)
  await type(text)
}
await recapture(page)

box = await openBoard(page, plan.id)
await shape('r', [260, 240], [460, 320])
await label([360, 280], 'M6 deploy')
await shape('o', [620, 240], [820, 320])
await label([720, 280], 'Licence')
await shape('d', [420, 440], [660, 560])
await label([540, 500], 'v1')
await arrow([465, 280], [615, 280])
await arrow([360, 325], [500, 435])
await arrow([720, 325], [590, 435])
await recapture(page)

/* ---------- the share dialog ---------- */
box = await openBoard(page, glade.id)
await page.click('button[aria-label^="More"]')
await delay(500)
await page.click('text=Share…')
await page.waitForSelector('.share-modal', { timeout: 10000 })
await delay(1800)
await shot(page, 'share')
await page.keyboard.press('Escape')
await delay(500)

/* ---------- the profile page ---------- */
await page.goto(`${webBase}/#/`)
await page.waitForSelector('.board-card', { timeout: 20000 })
await page.goto(`${webBase}/#/profile`)
await delay(3500)
// The sessions log is the part worth showing, and it sits below the fold.
await page.evaluate(() => {
  const heading = [...document.querySelectorAll('h2, h3')].find(
    (node) => /session/i.test(node.textContent ?? ''),
  )
  if (heading !== undefined) {
    heading.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -56)
  } else window.scrollTo(0, document.body.scrollHeight)
})
await delay(1500)
await shot(page, 'profile')

/* ---------- the share dialog ---------- */
box = await openBoard(page, glade.id)
await page.click('button[aria-label^="More"]')
await delay(500)
await page.click('text=Share…')
await page.waitForSelector('.share-modal', { timeout: 10000 })
await delay(1800)
await shot(page, 'share')
await page.keyboard.press('Escape')
await delay(500)

/* ---------- the profile page ---------- */
await page.goto(`${webBase}/#/`)
await page.waitForSelector('.board-card', { timeout: 20000 })
await page.goto(`${webBase}/#/profile`)
await delay(3500)
// The sessions log is the part worth showing, and it sits below the fold.
await page.evaluate(() => {
  const heading = [...document.querySelectorAll('h2, h3')].find(
    (node) => /session/i.test(node.textContent ?? ''),
  )
  if (heading !== undefined) {
    heading.scrollIntoView({ block: 'start' })
    window.scrollBy(0, -56)
  } else window.scrollTo(0, document.body.scrollHeight)
})
await delay(1500)
await shot(page, 'profile')

/* ---------- the glade list ---------- */
await page.goto(`${webBase}/#/`)
await page.waitForSelector('.board-card', { timeout: 20000 })
await page.mouse.move(8, 8)
await delay(4000)
await shot(page, 'glades')

await browser.close()
stop()
process.exit(0)
