/**
 * End-to-end check of the real board view.
 *
 * Registers a user over REST, creates a glade, opens it in the browser, draws on it,
 * and asserts the object reached Postgres through the websocket. The canvas smoke test
 * drives the engine against a local Y.Doc; this is the only check that covers auth,
 * the handshake, the provider, and persistence together.
 *
 * Requires postgres and redis: docker compose -f docker-compose.local.yml up -d
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const API_PORT = process.env.E2E_API_PORT ?? '8014'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3094'

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}${detail === '' ? '' : ` -- ${detail}`}`)
    failures.push(name)
  }
}

const procs = []
const stop = () => {
  for (const proc of procs) proc.kill('SIGTERM')
  procs.length = 0
}
process.on('exit', stop)

// `exec` so the child is the server itself; without it the kill hits the wrapper and
// leaves the port held. Same trap the M0 gate script fell into.
const api = spawn(
  'bash',
  [
    '-c',
    `cd services/api && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT} --log-level warning`,
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Registration is capped at 3 per hour per IP, which is correct in production and
    // makes this script runnable three times a day. The limiter itself is covered by
    // tests/test_auth.py::test_login_is_rate_limited; nothing here is about it, and
    // every request comes from 127.0.0.1 so the cap is hit by the check suite rather
    // than by anything under test.
    env: {
      ...process.env,
      MEADOW_RATE_LIMIT_ENABLED: 'false',
      // Blank SMTP is the documented off switch for activation mail, and it has to be
      // set explicitly because the repo's own .env usually configures a relay. With
      // mail enabled the account this script registers stays unactivated, every
      // endpoint refuses it, and the run dies at the board list with a timeout that
      // says nothing about why. See `_start_activation` in app/api/v1/auth.py: with no
      // relay the account is opened immediately instead.
      MEADOW_SMTP_HOST: '',
      MEADOW_SMTP_FROM: '',
    },
  },
)
procs.push(api)

const web = spawn(
  'pnpm',
  ['--filter', 'web', 'exec', 'vite', '--port', WEB_PORT, '--strictPort'],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    // The dev server proxies /api and /ws to API_PORT so the browser stays
    // same-origin and the httpOnly refresh cookie works without CORS. Point that
    // proxy at this run's API rather than the one in the repo .env.
    env: { ...process.env, API_PORT, WEB_PORT },
  },
)
procs.push(web)

async function waitFor(url, label) {
  for (let i = 0; i < 80; i += 1) {
    try {
      const response = await fetch(url)
      if (response.ok) return
    } catch {
      /* not up yet */
    }
    await delay(500)
  }
  throw new Error(`${label} did not start at ${url}`)
}

const apiBase = `http://127.0.0.1:${API_PORT}`
const webBase = `http://127.0.0.1:${WEB_PORT}`
await waitFor(`${apiBase}/healthz`, 'api')
await waitFor(webBase, 'web')

const email = `e2e-${Date.now()}@meadow.dev`
const password = 'correct-horse-battery-staple'

const register = await fetch(`${apiBase}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, display_name: 'E2E' }),
})
if (!register.ok) {
  // Almost always the database being down, and a JSON parse error on an HTML 500 page
  // hides that completely.
  console.error(
    `FAIL  register returned ${register.status}: ${(await register.text()).slice(0, 200)}\n` +
      'Is the database up? docker compose -f docker-compose.local.yml up -d',
  )
  stop()
  process.exit(1)
}
check('register opens an account', register.status === 202, `status ${register.status}`)

/*
 * Registering does not sign anybody in, so the token comes from a login.
 *
 * `POST /register` answers 202 with `RegistrationPending` and no session on purpose:
 * until the address answers, every other endpoint refuses the account, so a session
 * handed out here would be one that does not work. This script used to read
 * `access_token` off that response, which was correct until activation shipped in M6
 * and has been `undefined` since: the workspace call then 401'd, no board was ever
 * created, and the failure surfaced 20 seconds later as the board list not containing
 * a board, which points at the browser rather than at the setup.
 *
 * The API above runs with mail off, so the account is already activated and this is an
 * ordinary login.
 */
const login = await fetch(`${apiBase}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const auth = login.ok ? await login.json() : {}
const accessToken = auth.access_token ?? auth.accessToken
if (typeof accessToken !== 'string') {
  console.error(
    `FAIL  login returned ${login.status}: ${JSON.stringify(auth).slice(0, 200)}\n` +
      'An unactivated account means the API picked up an SMTP host from the environment.',
  )
  stop()
  process.exit(1)
}
check('logging in returns a session', true)

const workspaces = await (
  await fetch(`${apiBase}/api/v1/workspaces`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
).json()
const workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces.items?.[0])?.id
check('a personal workspace exists after registering', workspaceId !== undefined)

const boardResponse = await fetch(`${apiBase}/api/v1/boards`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ workspace_id: workspaceId, title: 'E2E glade' }),
})
check('create a glade', boardResponse.ok, `status ${boardResponse.status}`)
const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

await page.goto(webBase, { waitUntil: 'load' })

// Log in through the UI, so the auth wiring is exercised rather than bypassed.
await page.fill('input[type="email"]', email)
await page.fill('input[type="password"]', password)
await page.click('button[type="submit"]')

await page.waitForSelector('text=E2E glade', { timeout: 20000 })
check('the new glade appears in the list', true)

await page.click('text=E2E glade')
await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
check('the board view mounts a canvas', true)

// Wait for the handshake to resolve a writable role.
await page.waitForFunction(
  () => document.querySelector('.role')?.textContent?.trim() === 'owner',
  null,
  { timeout: 20000 },
)
check('the handshake resolves the owner role', true)

await page.click('button[aria-label^="Rectangle"]')
const box = await page.locator('.canvas-host canvas').boundingBox()
await page.mouse.move(box.x + 200, box.y + 180)
await page.mouse.down()
await page.mouse.move(box.x + 420, box.y + 330, { steps: 14 })
await page.mouse.up()

await page.waitForFunction(
  () => document.querySelector('.statusbar span')?.textContent?.includes('1 selected'),
  null,
  { timeout: 10000 },
)
check('drawing on the real board selects the new object', true)

const drawnCount = await page.textContent('[data-testid="object-count"]')
check('the object is in the document', drawnCount?.trim() === '1 object', `read "${drawnCount?.trim()}"`)

// Text objects, over the same socket. The canvas smoke test drives TipTap against a
// local Y.Doc; this is the only check that a Y.XmlFragment written by ProseMirror
// survives the provider and pycrdt on the way to Postgres and back.
await page.click('button[aria-label^="Sticky"]')
await page.mouse.click(box.x + 700, box.y + 300)
await page.waitForSelector('.meadow-overlay .ProseMirror', { timeout: 20000 })
check('placing a sticky opens an editor on it straight away', true)

const TYPED = 'meadow sticky'
/** The class the overlay puts on an object's rich-text node, from canvas/text/textStyle.ts. */
const CONTENT_CLASS = 'meadow-rt'
await page.keyboard.type(TYPED)
await page.keyboard.press('Escape')
// Any mounted object's rich-text node, not the first overlay node and not the whole
// box. Both of those used to be the same thing and are not any more: shapes are text
// bearing now, so the rectangle drawn above also mounts a node and sorts first, and a
// sticky's box also holds the author byline, so its textContent is the caption plus a
// name.
await page.waitForFunction(
  ({ text, contentClass }) =>
    [...document.querySelectorAll(`.meadow-overlay [data-object-id] .${contentClass}`)].some(
      (node) => node.textContent === text,
    ),
  { text: TYPED, contentClass: CONTENT_CLASS },
  { timeout: 10000 },
)
check('the typed text renders as static HTML once editing ends', true)

// Opt-in, so a normal run leaves no artefact behind: E2E_SHOT=/tmp/board.png
if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })

// Let the update reach the server, then confirm it survives a reload, which can only
// come from Postgres by way of the room.
await delay(2500)
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
await delay(2500)

const countText = await page.textContent('[data-testid="object-count"]')
check(
  'the drawn objects survive a reload',
  countText?.trim() === '2 objects',
  `status bar read "${countText?.trim()}"`,
)

const reloadedTexts = await page.evaluate(
  (contentClass) =>
    [...document.querySelectorAll(`.meadow-overlay [data-object-id] .${contentClass}`)].map(
      (node) => node.textContent,
    ),
  CONTENT_CLASS,
)
check(
  'the typed text survives a reload, so the fragment reached Postgres',
  reloadedTexts.includes(TYPED),
  `overlay read ${JSON.stringify(reloadedTexts)}`,
)

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '))

await browser.close()
stop()

console.log(`\n${failures.length === 0 ? 'all checks passed' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
