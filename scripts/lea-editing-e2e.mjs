/**
 * End-to-end check of the line editing keys on a lea, in a real browser.
 *
 * A lea is ruled paper made of one text object per rule, so Enter, Backspace and paste
 * are not the editor's own business: a row that gains or loses a line has to move every
 * row under it by the same amount, the way a line added in a notepad pushes the rest of
 * the file down. None of that can be seen without layout, which is why this is a
 * browser run and not a unit test.
 *
 * Requires postgres and redis: docker compose -f docker-compose.local.yml up -d
 */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const API_PORT = process.env.E2E_API_PORT ?? '8016'
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
    // Same switches as board-e2e.mjs: no registration cap, no mail relay.
    env: {
      ...process.env,
      MEADOW_RATE_LIMIT_ENABLED: 'false',
      MEADOW_SMTP_HOST: '',
      MEADOW_SMTP_FROM: '',
      MEADOW_MAIL_PROVIDER: 'none',
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
  // Two minutes: a cold Vite start re-optimises dependencies before it answers.
  for (let i = 0; i < 240; i += 1) {
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

const email = `lea-${Date.now()}@meadow.dev`
const password = 'correct-horse-battery-staple'

const register = await fetch(`${apiBase}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, display_name: 'Lea E2E' }),
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

const TITLE = 'Editing lea'
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

await page.goto(`${webBase}/app`, { waitUntil: 'load' })
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
await page
  // Generous: on a cold start Vite is still compiling the editor when the page opens.
  .waitForSelector('.meadow-overlay .ProseMirror', { timeout: 60000 })
  .catch(async (error) => {
    if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })
    throw error
  })
check('the lea opens with an editor on its first line', true)

/** Two frames and a little: long enough for a height to be measured and flushed. */
const settle = () => delay(250)

/** Press a key and give the page a frame to follow, for keys that move the caret between rows. */
const step = async (key) => {
  await page.keyboard.press(key)
  await settle()
}

/**
 * The page as a notepad would show it: one entry per rule, from the first line written
 * to the last, blank rules as ''. Read off the laid-out paragraphs, so it is what is on
 * the screen and not what the document claims.
 */
const lines = () =>
  page.evaluate(() => {
    // Text blocks only: the live editor nests its own root inside the content node.
    const selector = '.meadow-overlay [data-object-id] :is(p, h1, h2, h3)'
    const blocks = [...document.querySelectorAll(selector)]
    const first = blocks.find((node) => node.textContent !== '')
    if (first === undefined) return []
    const pitch = first.getBoundingClientRect().height
    const placed = blocks
      .map((node) => ({
        top: node.getBoundingClientRect().top,
        text: node.textContent ?? '',
      }))
      .sort((a, b) => a.top - b.top)
    const base = placed[0].top
    const out = []
    for (const { top, text } of placed) {
      const rule = Math.round((top - base) / pitch)
      while (out.length <= rule) out.push('')
      out[rule] = out[rule] === '' ? text : `${out[rule]}|${text}`
    }
    while (out.length > 0 && out.at(-1) === '') out.pop()
    return out
  })

const expectLines = async (name, expected) => {
  await settle()
  const actual = await lines()
  check(name, JSON.stringify(actual) === JSON.stringify(expected), `page read ${JSON.stringify(actual)}`)
}

// Three rows, one object each, the way a page fills when the caret walks down it.
await page.keyboard.type('One')
// A step after each move: the next row's editor mounts a frame later, and a key
// pressed before then has nowhere to go.
await step('ArrowDown')
await page.keyboard.type('Two')
await step('ArrowDown')
await page.keyboard.type('Three')
await expectLines('three rows on three rules', ['One', 'Two', 'Three'])

// 1. Enter at the end of a line opens exactly one blank line and pushes the rest down.
await step('ArrowUp')
await step('ArrowUp')
await step('End')
await step('Enter')
await expectLines('Enter opens one line and pushes the rest down', ['One', '', 'Two', 'Three'])

// 2. Backspace on that blank line closes it and pulls the rest back up.
await step('Backspace')
await expectLines('Backspace on a blank line pulls the rest up', ['One', 'Two', 'Three'])

// Backspace at the start of a row joins it onto the row above.
await step('ArrowDown')
await step('Home')
await step('Backspace')
await expectLines('Backspace at the start of a row joins it and pulls the rest up', [
  'OneTwo',
  'Three',
])

// Enter at the seam splits the line again and pushes the rest down.
await step('Enter')
await expectLines('Enter mid-line splits it and pushes the rest down', ['One', 'Two', 'Three'])

// Rows further down, with a blank rule between Three and Four: the empty row the caret
// passes through on rule 3 is discarded when it leaves. The caret starts on Two.
await step('ArrowDown')
await step('ArrowDown')
await step('ArrowDown')
await page.keyboard.type('Four')
await step('ArrowDown')
await page.keyboard.type('Five')
await expectLines('rows written under a blank rule', ['One', 'Two', 'Three', '', 'Four', 'Five'])

// 2, as reported: click the blank rule, press Backspace, and everything under it comes up.
const threeBox = await page.evaluate(() => {
  const node = [...document.querySelectorAll('.meadow-overlay [data-object-id] p')].find(
    (p) => p.textContent === 'Three',
  )
  const rect = node?.getBoundingClientRect()
  return rect === undefined ? null : { x: rect.left, y: rect.top, h: rect.height }
})
await page.mouse.click(threeBox.x + 20, threeBox.y + threeBox.h * 1.5)
await settle()
await step('Backspace')
await expectLines('Backspace on a clicked blank rule pulls the rest up', [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
])

// A row with an empty rule above it moves up onto it, and takes the rows under it along.
// The caret starts on Three; rule 5 is passed through and left blank.
await step('ArrowDown')
await step('ArrowDown')
await step('ArrowDown')
await step('ArrowDown')
await page.keyboard.type('Seven')
await step('ArrowDown')
await page.keyboard.type('Eight')
await step('ArrowUp')
await step('Home')
await step('Backspace')
await expectLines('a row closes the blank rule above it and the rest follow', [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Seven',
  'Eight',
])

// 3. A single line pasted from outside lands as a single line.
const paste = async (data) => {
  await page.evaluate((entries) => {
    const target = document.activeElement
    const transfer = new DataTransfer()
    for (const [type, value] of Object.entries(entries)) transfer.setData(type, value)
    target?.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
  }, data)
  await settle()
}

await step('ArrowUp')
await step('End')
await step('Enter')
await paste({
  'text/plain': 'Pasted\n',
  'text/html':
    '<meta charset="utf-8"><div><p style="margin:0">Pasted</p><p><br></p></div><br>',
})
await expectLines('a one-line paste from a web page takes one line', [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Pasted',
  'Seven',
  'Eight',
])

await step('Enter')
await paste({ 'text/plain': 'Plain\n\n' })
await expectLines('a plain one-line paste takes one line', [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Pasted',
  'Plain',
  'Seven',
  'Eight',
])

await step('Enter')
await paste({ 'text/plain': 'A\nB' })
await expectLines('a two-line paste takes two lines', [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Pasted',
  'Plain',
  'A',
  'B',
  'Seven',
  'Eight',
])

// Undo walks the last paste back, and the rows under it come back up with it - once.
await page.keyboard.press('Control+z')
await delay(600)
await expectLines('undo of a paste moves the rows back up once', [
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Pasted',
  'Plain',
  'Seven',
  'Eight',
])

// 4. The arrows cross between lines the same way whether two lines share an object or
// not. Five, Pasted and Plain are one object now; Seven and Eight are one each.

/** Click at the start or the end of the line reading `text`. */
const clickLine = async (text, where) => {
  const rect = await page.evaluate((wanted) => {
    const node = [...document.querySelectorAll('.meadow-overlay [data-object-id] p')].find(
      (p) => p.textContent === wanted,
    )
    if (node === undefined) return null
    // The text's own extent, not the block's, so "end" is just past the last letter.
    const range = document.createRange()
    range.selectNodeContents(node)
    const box = range.getBoundingClientRect()
    return { left: box.left, right: box.right, y: box.top + box.height / 2 }
  }, text)
  if (rect === null) throw new Error(`no line reads "${text}"`)
  await page.mouse.click(where === 'start' ? rect.left + 1 : rect.right + 2, rect.y)
  await settle()
}

/** The line the caret is on and how far along it, in characters. */
const caret = () =>
  page.evaluate(() => {
    const selection = window.getSelection()
    if (selection === null || selection.rangeCount === 0) return null
    const range = selection.getRangeAt(0)
    const line = range.startContainer.parentElement?.closest('p')
    if (line === null || line === undefined) return null
    const before = document.createRange()
    before.setStart(line, 0)
    before.setEnd(range.startContainer, range.startOffset)
    return `${line.textContent}@${before.toString().length}`
  })

const expectCaret = async (name, expected) => {
  await settle()
  const actual = await caret()
  const ok = typeof expected === 'function' ? expected(actual) : actual === expected
  check(name, ok, `caret at ${actual}`)
}

await clickLine('Seven', 'start')
await step('ArrowLeft')
await expectCaret('Left from the start of a row lands at the end of the line above', 'Plain@5')

await clickLine('Plain', 'start')
await step('ArrowLeft')
await expectCaret('Left inside a shared row does the same', 'Pasted@6')

await clickLine('Eight', 'start')
await step('ArrowLeft')
await expectCaret('Left between two separate rows does the same', 'Seven@5')

await clickLine('Seven', 'start')
await step('ArrowUp')
await expectCaret('Up from the start of a row keeps the column', 'Plain@0')

await clickLine('Seven', 'end')
await step('ArrowRight')
await expectCaret('Right from the end of a row lands at the start of the line below', 'Eight@0')

await clickLine('Four', 'end')
await step('ArrowUp')
await expectCaret(
  'Up from the end of a short line lands under it, not at the end of the longer one',
  (at) => at === 'Three@3' || at === 'Three@4',
)

await clickLine('Four', 'start')
await step('ArrowDown')
await expectCaret('Down from the start of a row keeps the column', 'Five@0')

await clickLine('Seven', 'start')
await expectCaret('a click on another line puts the caret where it was clicked', 'Seven@0')
await clickLine('Seven', 'end')
await expectCaret('a click on the line being written moves the caret there', 'Seven@5')

// 5. Ctrl+A takes the whole page on the first press, from any line.
for (const text of ['Seven', 'Plain']) {
  await clickLine(text, 'end')
  await page.keyboard.press('Control+a')
  await settle()
  // The page selection is painted on the canvas, so read it back the way a person
  // would: copy it, and see what was taken.
  const copied = await page.evaluate(() => {
    const transfer = new DataTransfer()
    document.body.dispatchEvent(
      new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
    )
    return transfer.getData('text/plain')
  })
  check(
    `one Ctrl+A on "${text}" selects the whole page`,
    copied.startsWith('One') && copied.trimEnd().endsWith('Eight'),
    `copied ${JSON.stringify(copied)}`,
  )
  await step('Escape')
}

if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })

check('no uncaught page errors', pageErrors.length === 0, pageErrors.join('; '))

await browser.close()
stop()

console.log(`\n${failures.length === 0 ? 'all checks passed' : `FAILED: ${failures.join(', ')}`}`)
process.exit(failures.length === 0 ? 0 : 1)
