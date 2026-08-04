/** Screenshot a page from the dev server. node scripts/shot.mjs <path> <out.png> */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const target = process.argv[2] ?? '/shader-check.html'
const out = process.argv[3] ?? 'shot.png'
const PORT = '3097'

const vite = spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', PORT, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
process.on('exit', () => vite.kill('SIGTERM'))

for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}${target}`)).ok) break
  } catch {
    /* not up */
  }
  await delay(500)
}

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage({ viewport: { width: 620, height: 950 } })
page.on('pageerror', (error) => console.log('page error:', error.message))
page.on('console', (message) => {
  if (message.type() === 'error') console.log('console:', message.text())
})

await page.goto(`http://127.0.0.1:${PORT}${target}`, { waitUntil: 'load' })
await delay(3000)
await page.screenshot({ path: out, fullPage: true })
console.log(`wrote ${out}`)

await browser.close()
process.exit(0)
