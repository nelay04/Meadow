/**
 * Downscale the README screenshots for the repo.
 *
 * `readme-shots.mjs` captures at 2x so the text is crisp on a HiDPI screen, which puts
 * the diary page - a photographic paper texture over the whole frame - close to four
 * megabytes. A README image is displayed at a column width, so half of that resolution
 * is never seen and all of it is cloned by everybody forever.
 *
 * Scaled with the canvas rather than an image library, because there is no image
 * dependency in this repo and adding one to shrink six files is the wrong trade.
 *
 * Two rules keep it from making things worse, which the first cut of this did to five
 * files out of six:
 *
 * - **Keep whichever is smaller.** The browser's PNG encoder is not as good as the one
 *   the screenshot came out of, so a halved image can still encode larger. When it does,
 *   the original stands.
 * - **A file still over a megabyte as a PNG is a photograph**, and PNG is the wrong
 *   format for one. The diary's paper is a texture across the whole frame; everything
 *   else here is flat UI, where PNG wins and JPEG would fringe the text.
 */

import { readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { chromium } from 'playwright'

const DIR = process.argv[2] ?? 'docs/media'
/** CSS pixels of a wide README column, times two for HiDPI. */
const MAX_WIDTH = 1920
const ONE_MEGABYTE = 1024 * 1024

const browser = await chromium.launch({ channel: 'chromium' })
const page = await browser.newPage()

for (const name of (await readdir(DIR)).filter((file) => file.endsWith('.png')).sort()) {
  const file = path.join(DIR, name)
  const before = (await stat(file)).size
  const dataUrl = `data:image/png;base64,${(await readFile(file)).toString('base64')}`

  const encoded = await page.evaluate(
    async ({ source, maxWidth }) => {
      const image = new Image()
      image.src = source
      await image.decode()
      if (image.width <= maxWidth) return null

      const scale = maxWidth / image.width
      const canvas = document.createElement('canvas')
      canvas.width = maxWidth
      canvas.height = Math.round(image.height * scale)
      const context = canvas.getContext('2d')
      context.imageSmoothingQuality = 'high'
      context.drawImage(image, 0, 0, canvas.width, canvas.height)

      const encode = async (type, quality) => {
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, type, quality))
        const bytes = new Uint8Array(await blob.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
        return btoa(binary)
      }
      return { png: await encode('image/png'), jpeg: await encode('image/jpeg', 0.92) }
    },
    { source: dataUrl, maxWidth: MAX_WIDTH },
  )

  if (encoded === null) {
    console.log(`${name}: already narrower than ${MAX_WIDTH}px, left alone`)
    continue
  }

  const png = Buffer.from(encoded.png, 'base64')
  if (png.length > ONE_MEGABYTE) {
    const jpeg = Buffer.from(encoded.jpeg, 'base64')
    const target = file.replace(/\.png$/, '.jpg')
    await writeFile(target, jpeg)
    await rm(file)
    console.log(
      `${name}: ${(before / 1024).toFixed(0)}K -> ${(jpeg.length / 1024).toFixed(0)}K ` +
        `as ${path.basename(target)}, too big to stay a PNG`,
    )
    continue
  }

  if (png.length >= before) {
    console.log(`${name}: re-encoding would grow it, original kept`)
    continue
  }

  await writeFile(file, png)
  console.log(`${name}: ${(before / 1024).toFixed(0)}K -> ${(png.length / 1024).toFixed(0)}K`)
}

await browser.close()
