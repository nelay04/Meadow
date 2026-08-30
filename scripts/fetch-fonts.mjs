/**
 * Download the project fonts as woff2 into apps/web/public/fonts.
 *
 * ARCHITECTURE 1: fonts are self-hosted, no CDN. Two reasons, and the second is the
 * one that matters here. Privacy and offline are the obvious ones. The real one is
 * that text metrics feed CRDT bounds: a text object's height is measured from the
 * rendered glyphs and written into the document. If a font arrives late, or not at
 * all, every client measures a different height for the same text and the board
 * disagrees with itself. A local file that is either present or a build failure is
 * far easier to reason about than a network race.
 *
 * The generated CSS is committed alongside the files, so a normal checkout needs no
 * network. Re-run this only to bump a font version.
 *
 *   node scripts/fetch-fonts.mjs
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = resolve(root, 'apps/web/public/fonts')

// Google's css2 endpoint serves woff2 only to a browser-shaped user agent. Anything
// else gets ttf, which is roughly twice the size for no benefit.
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Latin by default. The other subsets Google emits (cyrillic, greek, vietnamese) are a
 * further ~120KB per family for glyphs v1 does not promise. A family that needs a
 * different one says so.
 */
const SUBSETS = ['latin', 'latin-ext']

/*
 * `instances` is how a family asks for the weights it is served at rather than the
 * weights it was authored at. A collapsed range - "330 330" - pins a variable font to
 * one instance, so a request for regular renders there; two such faces give a regular
 * and a bold that are both lighter than the numbers on the file would suggest. Only
 * Bengali needs it, and the reason is in the note that ships in the generated CSS.
 */
const FAMILIES = [
  { query: 'Inter:wght@100..900', slug: 'inter' },
  { query: 'JetBrains+Mono:wght@100..800', slug: 'jetbrains-mono' },
  { query: 'Comic+Neue:wght@400;700', slug: 'comic-neue' },
  {
    query: 'Noto+Sans+Bengali:wght@100..900',
    slug: 'noto-sans-bengali',
    subsets: ['bengali'],
    instances: ['260 260', '400 400'],
    sizeAdjust: '108%',
    note: [
      '/*',
      ' * Bengali, appended to every stack in styles.css and canvas/text/textStyle.ts.',
      ' *',
      ' * Restricted to the Bengali block by unicode-range, so it is downloaded only by',
      ' * someone who actually types Bengali and never touches a latin glyph: fallback is',
      ' * per character, so one line of mixed script keeps Comic Neue on the English and',
      ' * this on the Bengali with no markup deciding which is which.',
      ' *',
      ' * Self-hosted for the same reason as the rest, and one more: without it a Windows',
      ' * machine fell back to Nirmala UI and a Linux one to whatever fontconfig chose, so',
      ' * the same lea was a different shape per person - and the metrics that set the CRDT',
      ' * bounds were measured from a font nobody else had.',
      ' *',
      ' * The two faces are pinned to 260 and 400 rather than 400 and 700. Noto at 400 is',
      ' * markedly darker on the page than Comic Neue at 400 beside it, because the matra',
      ' * puts a continuous horizontal stroke on every word that latin has no equivalent',
      ' * of, and the bold half of that matters more than it looks: the app sets 600 on a',
      ' * lot of small chrome - a page title in the list, a menu row - and at 600 an',
      ' * unpinned Noto is a black slab beside the same string in latin. size-adjust goes',
      ' * the other way, up: the eye matches a word against the height of a capital next to',
      ' * it, and Noto sits a shade under Comic Neue caps. styles.css turns weight',
      ' * synthesis off, which is the other half of this: without it a request for 700',
      ' * picks the 480 face and then Chrome smears it bolder itself, which is what made',
      ' * a Bengali page title in the list read as a black slab.',
      ' */',
    ].join('\n'),
  },

  // One face per script the input can write, each restricted to its own block by
  // unicode-range so nothing is downloaded until somebody types it. Devanagari covers
  // four of the thirteen languages; Bengali covers two. All pinned to the same pair of
  // instances as Bengali above, for the same reason: the app sets 600 on a lot of small
  // chrome, and at 600 an unpinned Noto is a slab beside the same string in latin.
  ...[
    ['Noto+Sans+Devanagari', 'devanagari'],
    ['Noto+Sans+Gujarati', 'gujarati'],
    ['Noto+Sans+Gurmukhi', 'gurmukhi'],
    ['Noto+Sans+Kannada', 'kannada'],
    ['Noto+Sans+Malayalam', 'malayalam'],
    ['Noto+Sans+Oriya', 'oriya'],
    ['Noto+Sans+Tamil', 'tamil'],
    ['Noto+Sans+Telugu', 'telugu'],
  ].map(([family, subset]) => ({
    query: `${family}:wght@100..900`,
    slug: family.toLowerCase().replaceAll('+', '-'),
    subsets: [subset],
    instances: ['260 260', '400 400'],
  })),
]

/**
 * Split the returned stylesheet into blocks and keep the ones whose preceding
 * comment names a subset we want. The comment is the only place the subset appears;
 * the unicode-range would work too but is far more brittle to match on.
 */
function parseFaces(css, wanted) {
  const faces = []
  const blocks = css.split('/*').slice(1)

  for (const block of blocks) {
    const subset = block.slice(0, block.indexOf('*/')).trim()
    if (!wanted.includes(subset)) continue

    const url = /src:\s*url\((https:[^)]+\.woff2)\)/.exec(block)?.[1]
    const weight = /font-weight:\s*([^;]+);/.exec(block)?.[1].trim()
    const family = /font-family:\s*'([^']+)'/.exec(block)?.[1]
    const style = /font-style:\s*([^;]+);/.exec(block)?.[1].trim() ?? 'normal'
    const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1].trim()

    if (url === undefined || weight === undefined || family === undefined) continue
    faces.push({ subset, url, weight, family, style, range })
  }

  return faces
}

await mkdir(outDir, { recursive: true })

const rules = []
let downloaded = 0

for (const { query, slug, subsets, instances, sizeAdjust, note } of FAMILIES) {
  const response = await fetch(`https://fonts.googleapis.com/css2?family=${query}&display=block`, {
    headers: { 'user-agent': UA },
  })
  if (!response.ok) throw new Error(`${query}: css request returned ${response.status}`)

  const faces = parseFaces(await response.text(), subsets ?? SUBSETS)
  if (faces.length === 0) throw new Error(`${query}: no matching subsets in the response`)

  for (const face of faces) {
    // Weight ranges arrive as "100 900"; flatten so the name is filesystem-safe.
    const suffix = face.weight.replace(/\s+/g, '-')
    const name = `${slug}-${suffix}-${face.subset}.woff2`

    const file = await fetch(face.url, { headers: { 'user-agent': UA } })
    if (!file.ok) throw new Error(`${name}: download returned ${file.status}`)

    const bytes = Buffer.from(await file.arrayBuffer())
    await writeFile(resolve(outDir, name), bytes)
    downloaded += 1
    console.log(`${name}  ${(bytes.length / 1024).toFixed(1)}KB`)

    // One face per pinned instance, or one at the weight the file declares.
    const weights = instances ?? [face.weight]
    weights.forEach((weight, position) => {
      rules.push(
        [
          // The note explains the whole family, so it goes above the first face only.
          ...(note !== undefined && position === 0 ? [note] : []),
          '@font-face {',
          `  font-family: '${face.family}';`,
          `  font-style: ${face.style};`,
          `  font-weight: ${weight};`,
          // `block` rather than `swap`. A swap would paint fallback glyphs first and
          // measure them, so the height written to the CRDT would be wrong until the
          // real font landed. A short invisible period is the cheaper failure.
          '  font-display: block;',
          ...(sizeAdjust === undefined ? [] : [`  size-adjust: ${sizeAdjust};`]),
          `  src: url('/fonts/${name}') format('woff2');`,
          ...(face.range === undefined ? [] : [`  unicode-range: ${face.range};`]),
          '}',
        ].join('\n'),
      )
    })
  }
}

const header = [
  '/*',
  ' * Generated by scripts/fetch-fonts.mjs. Do not edit by hand.',
  ' *',
  ' * Self-hosted per ARCHITECTURE 1. Imported once from src/styles.css so both the',
  ' * app and the dev harness resolve the same faces.',
  ' */',
  '',
].join('\n')

await writeFile(resolve(outDir, 'fonts.css'), `${header}${rules.join('\n\n')}\n`)
console.log(`\n${downloaded} files, ${rules.length} faces -> apps/web/public/fonts/fonts.css`)
