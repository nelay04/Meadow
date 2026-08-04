/** Print the real GLSL compile and link logs for the ShapeBatch shader. */

import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const PORT = '3098'
const vite = spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', PORT, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
process.on('exit', () => vite.kill('SIGTERM'))

for (let i = 0; i < 60; i += 1) {
  try {
    if ((await fetch(`http://127.0.0.1:${PORT}/bench.html`)).ok) break
  } catch {
    /* not up */
  }
  await delay(500)
}

const window_errors = []

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
})
const page = await browser.newPage()

await page.addInitScript(() => {
  const shaderSources = new Map()
  for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
    const source = proto.shaderSource
    proto.shaderSource = function (shader, src) {
      shaderSources.set(shader, src)
      return source.call(this, shader, src)
    }
    const compile = proto.compileShader
    proto.compileShader = function (shader) {
      compile.call(this, shader)
      if (!this.getShaderParameter(shader, this.COMPILE_STATUS)) {
        window.__shaderErrors ??= []
        window.__shaderErrors.push({
          log: this.getShaderInfoLog(shader),
          source: shaderSources.get(shader),
        })
      }
    }
    const link = proto.linkProgram
    proto.linkProgram = function (program) {
      link.call(this, program)
      if (!this.getProgramParameter(program, this.LINK_STATUS)) {
        window.__shaderErrors ??= []
        window.__shaderErrors.push({ log: `LINK: ${this.getProgramInfoLog(program)}` })
      }
    }
  }
})

page.on('pageerror', (error) => {
  window_errors.push(error.message)
})

await page.goto(`http://127.0.0.1:${PORT}/shader-check.html`, { waitUntil: 'load' })
await delay(2500)

const errors = await page.evaluate(() => ({
  shader: window.__shaderErrors ?? [],
  render: null,
}))

if (errors.shader.length === 0) {
  console.log('shader compiled and linked cleanly')
} else {
  for (const entry of errors.shader) {
    console.log('=== GLSL error ===')
    console.log(entry.log)
    if (entry.source) {
      console.log('--- source ---')
      console.log(
        entry.source
          .split('\n')
          .map((line, i) => `${String(i + 1).padStart(3)}| ${line}`)
          .join('\n'),
      )
    }
  }
}
for (const message of window_errors) console.log('page error:', message)

await browser.close()
process.exit(0)
