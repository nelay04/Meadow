/**
 * Which background tile sizes a browser repeats without changing them.
 *
 * The measurement `tileStep` in canvas/engine.ts is built on, kept because the answer
 * is a property of the browser rather than of this code and the next person to doubt
 * it should be able to re-run it rather than take the comment's word.
 *
 * A repeated background is one image drawn again and again. If its size is not a whole
 * number of pixels, each repetition starts at a different fraction of one, and the
 * same circle is rounded into a different set of pixels every few cells - which on the
 * dot paper reads as a lattice of dots in two or three weights. This walks the tile
 * size a device pixel at a time at each display scale and counts how many distinct dot
 * shapes come out of it. One shape is a lattice; anything more is the fault.
 *
 * The answer, at the time of writing and in Chromium: a tile is safe when it is a
 * whole number of device pixels *and*, on a fractional display scale, a whole number
 * of CSS pixels as well. So every fourth CSS pixel at 125% and 175%, every second at
 * 150%, and any whole device pixel at 100% and 200%.
 *
 *   node scripts/tile-probe.mjs
 */

import { chromium } from 'playwright'

/** The dot paper's own gradient, so the thing measured is the thing drawn. */
const PAGE = `<!doctype html><html><body style="margin:0;background:#12161c">
<div id="paper" style="position:absolute;inset:0;background-color:#12161c;background-image:
radial-gradient(circle at center, #8aa0b8 0, #8aa0b8 1.15px, transparent 1.85px)"></div></body></html>`

const RATIOS = [1, 1.25, 1.5, 1.75, 2]
/** The dot lattice's band, in device pixels, with room either side of it. */
const FROM = 22
const TO = 56

const browser = await chromium.launch({ channel: 'chromium' })

/** How many distinct dot shapes the tiled paper produced. */
async function shapeCount(page) {
  const shot = await page.screenshot()
  return page.evaluate(
    async ({ dataUrl }) => {
      const image = new Image()
      image.src = dataUrl
      await image.decode()
      const surface = document.createElement('canvas')
      surface.width = image.width
      surface.height = image.height
      const context = surface.getContext('2d')
      context.drawImage(image, 0, 0)
      const { data } = context.getImageData(0, 0, surface.width, surface.height)

      const ink = new Float64Array(surface.width * surface.height)
      for (let i = 0; i < ink.length; i += 1) {
        const at = i * 4
        ink[i] =
          Math.abs(data[at] - 0x12) + Math.abs(data[at + 1] - 0x16) + Math.abs(data[at + 2] - 0x1c)
      }

      // Flood fill every mark, counting the pixels each one covers. Marks touching the
      // edge of the shot are clipped rather than small, so they are not counted.
      const seen = new Uint8Array(ink.length)
      const shapes = new Set()
      for (let y = 3; y < surface.height - 3; y += 1) {
        for (let x = 3; x < surface.width - 3; x += 1) {
          const start = y * surface.width + x
          if (seen[start] === 1 || ink[start] < 4) continue
          let count = 0
          let clipped = false
          const stack = [start]
          seen[start] = 1
          while (stack.length > 0) {
            const at = stack.pop()
            const px = at % surface.width
            const py = (at - px) / surface.width
            if (px <= 2 || py <= 2 || px >= surface.width - 3 || py >= surface.height - 3) {
              clipped = true
            }
            count += 1
            for (const next of [at - 1, at + 1, at - surface.width, at + surface.width]) {
              if (next < 0 || next >= ink.length || seen[next] === 1 || ink[next] < 4) continue
              seen[next] = 1
              stack.push(next)
            }
          }
          if (!clipped) shapes.add(count)
        }
      }
      return shapes.size
    },
    { dataUrl: `data:image/png;base64,${shot.toString('base64')}` },
  )
}

for (const ratio of RATIOS) {
  const page = await browser.newPage({
    viewport: { width: 600, height: 400 },
    deviceScaleFactor: ratio,
  })
  await page.setContent(PAGE)

  const even = []
  for (let device = FROM; device <= TO; device += 1) {
    const cell = device / ratio
    await page.evaluate(async (size) => {
      const paper = document.querySelector('#paper')
      paper.style.backgroundSize = `${size}px ${size}px`
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    }, cell)
    if ((await shapeCount(page)) === 1) even.push(`${device}d/${cell}css`)
  }

  console.log(`scale ${ratio}: even at ${even.join(' ')}`)
  await page.close()
}

await browser.close()
