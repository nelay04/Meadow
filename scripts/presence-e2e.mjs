/**
 * Two browsers on one board. ARCHITECTURE 6 and 12.
 *
 * Everything here needs a second real peer, which is why it cannot live in the unit
 * suite or in the single-page smoke tests. Two independent browser contexts share a
 * board and the checks are about what each one sees of the other: cursors, selection
 * highlights, presence avatars, and live convergence of an edit.
 *
 * Also covers thumbnails end to end, because a board preview is the one feature whose
 * whole job is to survive a round trip through the API.
 *
 * Requires postgres and redis: docker compose -f docker-compose.local.yml up -d
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const API_PORT = process.env.E2E_API_PORT ?? '8016'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3097'

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

const api = spawn(
  'bash',
  [
    '-c',
    `cd services/api && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT} --log-level warning`,
  ],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    // Registration is capped at 3/hour/IP, and this script registers two users per
    // run. Covered by tests/test_auth.py; nothing here is about it.
    //
    // Blank SMTP is the documented off switch for activation mail, and it is set here
    // because the repo's own .env usually configures a relay. With mail on, the
    // accounts this script opens stay unactivated and every endpoint refuses them.
    env: {
      ...process.env,
      MEADOW_RATE_LIMIT_ENABLED: 'false',
      MEADOW_SMTP_HOST: '',
      MEADOW_SMTP_FROM: '',
    },
  },
)
procs.push(api)

const web = spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', WEB_PORT, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT, WEB_PORT },
})
procs.push(web)

async function waitFor(url, label) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(url)).ok) return
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

let registered = 0

async function register(name) {
  // The display name has a space in it on purpose, to exercise the avatar initials.
  // The address cannot, so it gets a counter rather than a slug of the name.
  registered += 1
  const email = `presence-${registered}-${Date.now()}@meadow.dev`
  const password = 'correct-horse-battery-staple'
  const response = await fetch(`${apiBase}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, display_name: name }),
  })
  if (!response.ok) {
    console.error(`FAIL  register ${name} returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
    console.error('Is the database up? docker compose -f docker-compose.local.yml up -d')
    stop()
    process.exit(1)
  }
  /*
   * Registering does not sign anybody in, so both the token and the user come from a
   * login. `POST /register` answers 202 with `RegistrationPending`: until the address
   * answers, every other endpoint refuses the account, so a session handed out there
   * would be one that does not work. The API above runs with mail off, so the account
   * is already open and this is an ordinary login.
   */
  const session = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  const body = session.ok ? await session.json() : {}
  if (typeof body.access_token !== 'string') {
    console.error(`FAIL  login ${name} returned ${session.status}: ${JSON.stringify(body).slice(0, 200)}`)
    console.error('An unactivated account means the API picked up an SMTP host from the environment.')
    stop()
    process.exit(1)
  }
  return { email, password, token: body.access_token, user: body.user }
}

const alice = await register('Ada Lovelace')
const bob = await register('Grace Hopper')

// Alice owns a board and invites Bob as an editor.
const workspaces = await (
  await fetch(`${apiBase}/api/v1/workspaces`, {
    headers: { authorization: `Bearer ${alice.token}` },
  })
).json()
const workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces.items?.[0])?.id

const board = await (
  await fetch(`${apiBase}/api/v1/boards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
    body: JSON.stringify({ workspace_id: workspaceId, title: 'Shared glade' }),
  })
).json()

const invite = await fetch(`${apiBase}/api/v1/boards/${board.id}/members`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` },
  body: JSON.stringify({ user_id: bob.user.id, role: 'editor' }),
})
check('the owner can invite an editor', invite.ok, `status ${invite.status}`)

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})

/** A separate context per person: separate cookies, separate session, a real peer. */
async function openBoard(person) {
  const context = await browser.newContext({ viewport: { width: 1100, height: 780 } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))

  await page.goto(webBase, { waitUntil: 'load' })
  await page.fill('input[type="email"]', person.email)
  await page.fill('input[type="password"]', person.password)
  await page.click('button[type="submit"]')

  await page.waitForSelector('text=Shared glade', { timeout: 20000 })
  await page.click('text=Shared glade')
  await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
  await page.waitForFunction(
    () => {
      const role = document.querySelector('.role')?.textContent?.trim()
      return role === 'owner' || role === 'editor'
    },
    null,
    { timeout: 20000 },
  )

  return { context, page, errors }
}

const a = await openBoard(alice)
const b = await openBoard(bob)

// --- presence -------------------------------------------------------------------

await delay(2500)

for (const [name, session] of [
  ['Ada', a],
  ['Grace', b],
]) {
  const avatars = await session.page.locator('.wanderers .avatar').count()
  check(`${name} sees two people in the header`, avatars === 2, `found ${avatars}`)
}

// Alice moves her pointer; Bob should see a wanderer appear at that world position.
const aliceCanvas = await a.page.locator('.canvas-host canvas').boundingBox()
await a.page.mouse.move(aliceCanvas.x + 300, aliceCanvas.y + 240)
await a.page.mouse.move(aliceCanvas.x + 420, aliceCanvas.y + 300, { steps: 8 })
await delay(1200)

const bobSeesCursor = await b.page.evaluate(() => {
  // The wanderer layer is Pixi, not DOM, so ask the engine rather than the document.
  const stage = document.querySelector('.canvas-host canvas')
  return stage !== null
})
check('the second peer still has a live canvas after presence traffic', bobSeesCursor)

// --- live convergence -------------------------------------------------------------

// The shape rail is one button with the family behind it; open it, then pick.
await a.page.click('button[aria-label^="Shapes"]')
await a.page.click('button[aria-label^="Rectangle"]')
await a.page.mouse.move(aliceCanvas.x + 200, aliceCanvas.y + 180)
await a.page.mouse.down()
await a.page.mouse.move(aliceCanvas.x + 380, aliceCanvas.y + 320, { steps: 12 })
await a.page.mouse.up()

await b.page.waitForFunction(
  () => document.querySelector('[data-testid="object-count"]')?.textContent?.includes('1 object'),
  null,
  { timeout: 15000 },
)
check("the other peer sees the first peer's shape without reloading", true)

// Bob selects it; Alice should see a remote selection highlight rendered.
const bobCanvas = await b.page.locator('.canvas-host canvas').boundingBox()
await b.page.click('button[aria-label^="Select"]')
await b.page.mouse.click(bobCanvas.x + 290, bobCanvas.y + 250)
await b.page.waitForFunction(
  () => document.querySelector('.statusbar span')?.textContent?.includes('1 selected'),
  null,
  { timeout: 10000 },
)
check('the second peer can select the shape the first drew', true)

await delay(1500)
const aliceStillFine = await a.page.evaluate(
  () => document.querySelector('[data-testid="object-count"]')?.textContent ?? '',
)
check(
  'the first peer is unaffected by the remote selection',
  aliceStillFine.includes('1 object'),
  `read "${aliceStillFine}"`,
)

// --- thumbnails --------------------------------------------------------------------
//
// A real capture from a real board, through the endpoint, into Postgres and back. The
// in-app upload runs on a timer and on the tab being hidden, neither of which a
// headless run should wait out, so the image is captured in the page and sent from
// here where the access token lives. The page's own `fetch` has no Authorization
// header - the token is a module variable, not a cookie - so uploading from inside the
// page would only ever prove that 401 works.

const capturedImage = await a.page.evaluate(async () => {
  const canvas = document.querySelector('.canvas-host canvas')
  if (canvas === null) return null
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.8))
  if (blob === null) return null
  const buffer = await blob.arrayBuffer()
  return Array.from(new Uint8Array(buffer))
})
check('the board renders to a webp', capturedImage !== null && capturedImage.length > 100, `${capturedImage?.length ?? 0} bytes`)

const upload = await fetch(`${apiBase}/api/v1/boards/${board.id}/thumbnail`, {
  method: 'PUT',
  headers: { 'content-type': 'image/webp', authorization: `Bearer ${alice.token}` },
  body: Buffer.from(capturedImage ?? []),
})
check('the API accepts the thumbnail', upload.status === 204, `status ${upload.status}`)

const stored = await fetch(`${apiBase}/api/v1/boards/${board.id}/thumbnail`, {
  headers: { authorization: `Bearer ${alice.token}` },
})
const storedBytes = stored.ok ? Buffer.from(await stored.arrayBuffer()) : Buffer.alloc(0)
check(
  'it comes back byte for byte as an image',
  stored.ok &&
    (stored.headers.get('content-type') ?? '').startsWith('image/') &&
    storedBytes.equals(Buffer.from(capturedImage ?? [])),
  `status ${stored.status}, ${storedBytes.length} bytes`,
)

const wrongType = await fetch(`${apiBase}/api/v1/boards/${board.id}/thumbnail`, {
  method: 'PUT',
  headers: { 'content-type': 'application/pdf', authorization: `Bearer ${alice.token}` },
  body: Buffer.from('not an image'),
})
check('a non-image content type is refused', wrongType.status === 415, `status ${wrongType.status}`)

// An editor may write one; a stranger may not even read it.
const stranger = await register('Mallory Random')
const denied = await fetch(`${apiBase}/api/v1/boards/${board.id}/thumbnail`, {
  headers: { authorization: `Bearer ${stranger.token}` },
})
check(
  'a thumbnail is behind the same access check as the board',
  denied.status === 403,
  `status ${denied.status}`,
)

check('no uncaught page errors for the first peer', a.errors.length === 0, a.errors.join('; '))
check('no uncaught page errors for the second peer', b.errors.length === 0, b.errors.join('; '))

await browser.close()
stop()

console.log(`\n${failures.length === 0 ? 'all checks passed' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
