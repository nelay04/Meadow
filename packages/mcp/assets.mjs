// The files a snapshot needs at runtime, gathered into `assets/`: the SVG rasterizer's
// WebAssembly and the fonts the canvas draws with.
//
// The web app self-hosts its fonts as woff2, which a browser reads and resvg does not, so
// they are decompressed to TrueType here rather than kept twice in the repository. Run
// by `build` (which copies the result beside the bundle) and by `test`.
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const fonts = resolve(here, '../../apps/web/public/fonts')
const out = resolve(here, 'assets')

/** Output file, from the web app's woff2. Latin only: the canvas's own default subset. */
export const FONT_FILES = {
  'comic-neue-400.ttf': 'comic-neue-400-latin.woff2',
  'comic-neue-700.ttf': 'comic-neue-700-latin.woff2',
  'inter.ttf': 'inter-100-900-latin.woff2',
  'jetbrains-mono.ttf': 'jetbrains-mono-100-800-latin.woff2',
}

const newer = async (target, source) => {
  try {
    return (await stat(target)).mtimeMs >= (await stat(source)).mtimeMs
  } catch {
    return false
  }
}

export async function gatherAssets(into = out) {
  await mkdir(resolve(into, 'fonts'), { recursive: true })
  const { decompress } = require('wawoff2')
  for (const [ttf, woff2] of Object.entries(FONT_FILES)) {
    const source = resolve(fonts, woff2)
    const target = resolve(into, 'fonts', ttf)
    if (await newer(target, source)) continue
    await writeFile(target, await decompress(await readFile(source)))
  }
  const wasm = require.resolve('@resvg/resvg-wasm/index_bg.wasm')
  const target = resolve(into, 'resvg.wasm')
  if (!(await newer(target, wasm))) await copyFile(wasm, target)
  return into
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await gatherAssets(process.argv[2] === undefined ? out : resolve(process.argv[2]))
}
