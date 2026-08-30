/**
 * End-to-end check of phonetic input, in a real browser, on a real lea.
 *
 * Bengali carries most of it because it is the one with an offline engine behind it and
 * the one the feature was built for; Hindi is checked too, through the script menu,
 * because the language being a setting rather than a constant is the part most likely
 * to be wired up wrong.
 *
 * The unit tests cover the offline transliterator and nothing else. Everything that can
 * actually go wrong with an input method is in the wiring: whether the candidate list
 * appears under the caret, whether Space commits the highlighted word instead of typing
 * a space, whether the roman is replaced rather than appended, and whether the Bengali
 * survives the trip through ProseMirror, the Y.Doc, the socket and Postgres.
 *
 * The candidate list itself comes from Google's input service, so this run wants the
 * network as well as the database. Being offline is not a failure of the feature - the
 * rule engine answers instead - so this asserts on Bengali reaching the page rather than
 * on which word came back first.
 *
 * Requires postgres and redis: docker compose -f docker-compose.local.yml up -d
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const API_PORT = process.env.E2E_API_PORT ?? '8015'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3095'

/** The Bengali block, for asserting that what came back is actually the script. */
const BENGALI = /[ঀ-৾]/

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
    // Same two switches as board-e2e.mjs, for the same reasons: the registration cap is
    // correct in production and makes a check script runnable three times a day, and a
    // configured relay would leave the account unactivated and every call refused.
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

const email = `bn-${Date.now()}@meadow.dev`
const password = 'correct-horse-battery-staple'

const register = await fetch(`${apiBase}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, display_name: 'Bengali E2E' }),
})
if (!register.ok) {
  console.error(
    `FAIL  register returned ${register.status}: ${(await register.text()).slice(0, 200)}\n` +
      'Is the database up? docker compose -f docker-compose.local.yml up -d',
  )
  stop()
  process.exit(1)
}

const login = await fetch(`${apiBase}/api/v1/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password }),
})
const auth = login.ok ? await login.json() : {}
const accessToken = auth.access_token ?? auth.accessToken
if (typeof accessToken !== 'string') {
  console.error(`FAIL  login returned ${login.status}: ${JSON.stringify(auth).slice(0, 200)}`)
  stop()
  process.exit(1)
}

const workspaces = await (
  await fetch(`${apiBase}/api/v1/workspaces`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
).json()
const workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces.items?.[0])?.id

const TITLE = 'Bengali lea'
const boardResponse = await fetch(`${apiBase}/api/v1/boards`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
  body: JSON.stringify({ workspace_id: workspaceId, title: TITLE, kind: 'lea' }),
})
check('create a lea', boardResponse.ok, `status ${boardResponse.status}`)

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
const pageErrors = []
page.on('pageerror', (error) => pageErrors.push(error.message))

await page.goto(webBase, { waitUntil: 'load' })
await page.fill('input[type="email"]', email)
await page.fill('input[type="password"]', password)
await page.click('button[type="submit"]')

await page.waitForSelector(`text=${TITLE}`, { timeout: 20000 })
await page.click(`text=${TITLE}`)
await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
await page.waitForFunction(
  () => document.querySelector('.role')?.textContent?.trim() === 'owner',
  null,
  { timeout: 20000 },
)
check('the lea opens with a writable role', true)

// A new lea puts the caret on its first rule by itself; wait for that rather than
// clicking, so this does not depend on where the paper happens to sit.
await page.waitForSelector('.meadow-overlay .ProseMirror', { timeout: 20000 })
check('the lea opens with an editor on its first line', true)

const toggle = page.locator('button.bengali-toggle')
check('the board bar offers the input toggle', (await toggle.count()) === 1)
await toggle.click()
check(
  'the toggle reports itself on',
  (await toggle.getAttribute('aria-pressed')) === 'true',
  `aria-pressed was ${await toggle.getAttribute('aria-pressed')}`,
)

await page.keyboard.type('amar')
const popup = page.locator('.ime-popup')
await popup.waitFor({ timeout: 10000 })
check('typing roman opens the candidate list', true)

const offered = await page.locator('.ime-option-text').allTextContents()
check(
  'the list is Bengali',
  offered.some((word) => BENGALI.test(word)),
  `list was ${JSON.stringify(offered)}`,
)
check(
  'the roman word is offered last, so latin can still be typed',
  offered.at(-1) === 'amar',
  `list was ${JSON.stringify(offered)}`,
)
console.log(
  (await page.locator('.ime-popup-offline').count()) === 0
    ? 'note  candidates came from the input service'
    : 'note  the service was unreachable; the local rules answered',
)

// The list, as the person actually sees it: E2E_SHOT=/tmp/bn.png writes
// /tmp/bn-popup.png alongside the final frame.
if (process.env.E2E_SHOT) {
  await page.screenshot({ path: process.env.E2E_SHOT.replace(/(\.png)?$/, '-popup.png') })
}

const first = offered[0]
await page.keyboard.press('Space')
await popup.waitFor({ state: 'detached', timeout: 5000 })
check('Space commits and closes the list', true)

const CONTENT_CLASS = 'meadow-rt'
const line = async () =>
  (await page.evaluate(
    (contentClass) =>
      [...document.querySelectorAll(`.meadow-overlay [data-object-id] .${contentClass}`)]
        .map((node) => node.textContent ?? '')
        .find((text) => text.trim() !== '') ?? '',
    CONTENT_CLASS,
  )) ?? ''

const afterCommit = await line()
check(
  'the chosen word replaced the roman rather than being appended',
  afterCommit.includes(first) && !afterCommit.includes('amar'),
  `line read "${afterCommit}"`,
)

// A second word, chosen by its number the way the input tools page does it.
await page.keyboard.type('bhalo')
await popup.waitFor({ timeout: 10000 })
const second = (await page.locator('.ime-option-text').allTextContents())[1]
await page.keyboard.press('2')
await popup.waitFor({ state: 'detached', timeout: 5000 })
const afterDigit = await line()
check(
  'a digit picks that candidate out of the list',
  second !== undefined && afterDigit.includes(second),
  `line read "${afterDigit}", expected to contain "${second}"`,
)

// Escape leaves what was typed alone. An input method that eats your letters when you
// change your mind is worse than no input method.
await page.keyboard.type('test')
await popup.waitFor({ timeout: 10000 })
await page.keyboard.press('Escape')
await popup.waitFor({ state: 'detached', timeout: 5000 })
const afterEscape = await line()
check(
  'Escape closes the list and keeps the roman',
  afterEscape.includes('test'),
  `line read "${afterEscape}"`,
)
check(
  'Escape closed the list and not the editor',
  (await page.locator('.meadow-overlay .ProseMirror').count()) > 0,
)

/*
 * A word with no end to it.
 *
 * Bengali writes long compounds, and the candidate for one is a single unbroken run of
 * glyphs. The global button rule this popup inherits from never wraps, so before it was
 * overridden a word like this walked straight out of the list and across the page.
 */
await page.keyboard.type('jotatojivjaklfpgkllspoikkflaljlmmoklkhhsjmv')
await popup.waitFor({ timeout: 10000 })
const spill = await page.evaluate(() => {
  const box = document.querySelector('.ime-popup')?.getBoundingClientRect()
  if (box === undefined) return null
  return {
    left: Math.round(box.left),
    right: Math.round(box.right),
    width: window.innerWidth,
    height: Math.round(box.height),
    viewport: window.innerHeight,
  }
})
check(
  'a very long word wraps inside the list instead of running off the page',
  spill !== null && spill.left >= 0 && spill.right <= spill.width,
  `list spanned ${spill?.left}..${spill?.right} of ${spill?.width}px`,
)
check(
  'and the list still fits on the screen',
  spill !== null && spill.height <= spill.viewport,
  `list was ${spill?.height}px tall in ${spill?.viewport}px`,
)
if (process.env.E2E_SHOT) {
  await page.screenshot({ path: process.env.E2E_SHOT.replace(/(\.png)?$/, '-long.png') })
}
await page.keyboard.press('Escape')

/*
 * A second script, chosen from the menu.
 *
 * Devanagari rather than another Bengali case: what is being checked is that the choice
 * reaches the editor, the request and the cache, and only a different alphabet on the
 * page can show that.
 */
await page.click('.input-language .caret')
await page.click('.menu-language [role="option"]:has-text("Hindi")')
await page.keyboard.type('namaste')
await popup.waitFor({ timeout: 10000 })
const hindi = await page.locator('.ime-option-text').allTextContents()
check(
  'choosing Hindi from the menu writes Devanagari',
  hindi.some((word) => /[\u0900-\u097F]/.test(word)),
  `list was ${JSON.stringify(hindi)}`,
)
check(
  'the popup names the script being typed',
  (await page.locator('.ime-popup-language').textContent()) === 'हिन्दी',
  `header read "${await page.locator('.ime-popup-language').textContent()}"`,
)
await page.keyboard.press('Enter')
await popup.waitFor({ state: 'detached', timeout: 5000 })
check(
  'Enter commits the Devanagari',
  (await line()).includes(hindi[0]),
  `line read "${await line()}"`,
)

// Back to Bengali, so the reload check below is about the word it committed earlier.
await page.click('.input-language .caret')
await page.click('.menu-language [role="option"]:has-text("Bengali")')

// And with the option off, roman is just roman.
await toggle.click()
await page.click('.meadow-overlay .ProseMirror')
await page.keyboard.type(' plain')
await delay(300)
check('turning the option off leaves typing alone', (await page.locator('.ime-popup').count()) === 0)

if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })

// The whole point of writing into the document rather than into a buffer: it goes down
// the same path as any other text.
await delay(2500)
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
await delay(2500)
const reloaded = await line()
check(
  'the Bengali survives a reload, so it reached Postgres',
  reloaded.includes(first),
  `line read "${reloaded}"`,
)

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '))

await browser.close()
stop()

console.log(`\n${failures.length === 0 ? 'all checks passed' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
