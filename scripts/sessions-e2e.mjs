/**
 * The sessions log, live. Three real browsers on one account.
 *
 * Everything here is asynchronous across processes, which is why none of it can live
 * in the API suite: Starlette's TestClient runs a request to completion before handing
 * back a response, so a stream that is never meant to finish hangs it. What is checked
 * is the pair of promises the sessions card makes and neither of which a single
 * request can demonstrate:
 *
 *   1. a sign-in or a sign-out anywhere shows up in an open list, with no reload;
 *   2. terminating a session ends it in that browser at once - no activity, no reload -
 *      and its access token stops working in the same instant.
 *
 * Requires postgres and redis: docker compose -f docker-compose.local.yml up -d
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const API_PORT = process.env.E2E_API_PORT ?? '8017'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3096'

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
    // Same reasons as presence-e2e.mjs: this script logs in four times in a few
    // seconds, and a configured SMTP relay would leave the account unactivated.
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

const email = `sessions-${Date.now()}@meadow.dev`
const password = 'correct-horse-battery-staple'

const registered = await fetch(`${apiBase}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, display_name: 'Ada Lovelace' }),
})
if (!registered.ok) {
  console.error(`FAIL  register returned ${registered.status}`)
  console.error('Is the database up? docker compose -f docker-compose.local.yml up -d')
  stop()
  process.exit(1)
}

/** A signed-in browser that is not a browser: a bare login, for the list to have rows. */
async function signIn(userAgent) {
  const response = await fetch(`${apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ email, password }),
  })
  const body = await response.json()
  // Just the pair, not the attributes: a Set-Cookie line carries Path and HttpOnly,
  // and a Cookie header carrying those back is not a cookie the server will read.
  const cookie = response.headers
    .getSetCookie()
    .map((line) => line.split(';', 1)[0])
    .join('; ')
  return { token: body.access_token, cookie, userAgent }
}

const authed = (session) => ({
  authorization: `Bearer ${session.token}`,
  cookie: session.cookie,
})

const browser = await chromium.launch()

/** Sign a real page in through the form, so it holds the same cookie a person would. */
async function openBrowser() {
  const context = await browser.newContext()
  const page = await context.newPage()
  await page.goto(`${webBase}/#/`, { waitUntil: 'load' })
  await page.fill('input[type=email]', email)
  await page.fill('input[type=password]', password)
  await page.click('button[type=submit]')
  await page.waitForSelector('.sidebar', { timeout: 20000 })
  return { context, page }
}

const watcher = await openBrowser()
const doomed = await openBrowser()
doomed.page.on('console', (message) => {
  if (message.type() === 'error') console.log(`  doomed console: ${message.text()}`)
})

// --- 1. the list updates with no reload -------------------------------------------

await watcher.page.goto(`${webBase}/#/profile`, { waitUntil: 'load' })
await watcher.page.waitForSelector('.session-list .session', { timeout: 20000 })

const rows = () => watcher.page.locator('.session-list .session').count()
const before = await rows()
check('two browsers are listed', before === 2, `saw ${before}`)

// A third signs in, and nothing touches the page that is watching.
await signIn('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Firefox/129.0')
await watcher.page.waitForFunction(
  (was) => document.querySelectorAll('.session-list .session').length > was,
  before,
  { timeout: 10000 },
).catch(() => undefined)
const after = await rows()
check('a sign-in elsewhere appears without a reload', after === before + 1, `saw ${after}`)
check(
  'the new row names the browser that signed in',
  (await watcher.page.locator('.session-list .session').allInnerTexts()).some((text) =>
    text.includes('Firefox on macOS'),
  ),
)

// --- 2. terminating a session ends it in that browser, at once ---------------------

// The doomed browser is left sitting on its board list, doing nothing at all. That is
// the case this whole mechanism exists for: no activity means nothing would otherwise
// ask the server a question, so without the feed it would look signed in indefinitely.
// By name and not by position. The list is ordered by activity under the reader's own
// row, so "the first one that is not me" is whichever session most recently refreshed
// - here the bare Firefox login above, not the browser this check is about.
const doomedRow = watcher.page
  .locator('.session-list .session')
  .filter({ hasNot: watcher.page.locator('.session-badge') })
  .filter({ hasText: 'Chrome on Linux' })
  .first()
await doomedRow.locator('button', { hasText: 'Terminate' }).click()
await watcher.page.locator('dialog.modal .modal-actions button.primary').click()

let kicked = true
try {
  await doomed.page.waitForSelector('input[type=password]', { timeout: 15000 })
} catch {
  kicked = false
}
check('a terminated browser drops to the login screen on its own', kicked)

// The login form on its own is not an explanation. A tab that was untouched and is
// suddenly asking for a password reads as the app having crashed, so it has to say
// what happened, and say it in the colour the app uses for things that went wrong.
let told = ''
try {
  const toast = doomed.page.locator('.toast-error').first()
  await toast.waitFor({ timeout: 10000 })
  told = await toast.innerText()
} catch {
  /* left empty, and the check below says so */
}
check(
  'it is told why, in a red toast',
  told.includes('terminated from another device'),
  told === '' ? 'no error toast appeared' : told.replace(/\s+/g, ' '),
)

// --- 3. the access token stops working, not just the refresh token ----------------

// A polite client throws its token away when the feed tells it to. This is the check
// that a client which does not - a stolen token, a script, a tab with no feed - is
// refused anyway. Two bare sessions: one terminates the other and then tries to use it.
const killer = await signIn('Mozilla/5.0 (X11; Linux x86_64) Chrome/128.0.0.0')
const victim = await signIn('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/127.0.0.0')

const worked = await fetch(`${apiBase}/api/v1/auth/me`, { headers: authed(victim) })
check('the victim token works before it is terminated', worked.status === 200)

const listed = await (await fetch(`${apiBase}/api/v1/auth/sessions`, { headers: authed(killer) })).json()
const target = listed.find((row) => row.user_agent === victim.userAgent)
const ended = await fetch(`${apiBase}/api/v1/auth/sessions/${target.id}`, {
  method: 'DELETE',
  headers: authed(killer),
})
check('terminating the victim session answers 204', ended.status === 204, `status ${ended.status}`)

const refused = await fetch(`${apiBase}/api/v1/auth/me`, { headers: authed(victim) })
check(
  'a terminated access token is refused at once',
  refused.status === 401,
  `status ${refused.status}`,
)
const survivor = await fetch(`${apiBase}/api/v1/auth/me`, { headers: authed(killer) })
check('the browser that did it is untouched', survivor.status === 200, `status ${survivor.status}`)

await browser.close()
stop()

console.log('')
if (failures.length > 0) {
  console.log(`${failures.length} failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log('sessions e2e passed')
process.exit(0)
