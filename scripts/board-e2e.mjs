/**
 * End-to-end check of the real board view.
 *
 * Registers a user over REST, creates a field, opens it in the browser, draws on it,
 * and asserts the object reached Postgres through the websocket. The canvas smoke test
 * drives the engine against a local Y.Doc; this is the only check that covers auth,
 * the handshake, the provider, and persistence together.
 *
 * Requires postgres and redis: docker compose up -d
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
  { stdio: ['ignore', 'pipe', 'pipe'] },
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
      'Is the database up? docker compose up -d',
  )
  stop()
  process.exit(1)
}
check('register returns a session', true)
const auth = await register.json()
const accessToken = auth.access_token ?? auth.accessToken

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
  body: JSON.stringify({ workspace_id: workspaceId, title: 'E2E field' }),
})
check('create a field', boardResponse.ok, `status ${boardResponse.status}`)
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

await page.waitForSelector('text=E2E field', { timeout: 20000 })
check('the new field appears in the list', true)

await page.click('text=E2E field')
await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
check('the board view mounts a canvas', true)

// Wait for the handshake to resolve a writable role.
await page.waitForFunction(
  () => document.querySelector('.role')?.textContent?.trim() === 'owner',
  null,
  { timeout: 20000 },
)
check('the handshake resolves the owner role', true)

await page.click('button[title^="Rectangle"]')
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
  'the drawn object survives a reload',
  countText?.trim() === '1 object',
  `status bar read "${countText?.trim()}"`,
)
check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '))

await browser.close()
stop()

console.log(`\n${failures.length === 0 ? 'all checks passed' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
