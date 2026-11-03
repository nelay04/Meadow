/**
 * Part of a board as one standalone image file.
 *
 * The SVG is the export. It is vector all the way through, so it is as sharp zoomed
 * in a thousand times as it is at one, whatever the size of the diagram, and that is
 * the promise a raster capture cannot keep: a big enough diagram is always either soft
 * or bigger than a browser will allocate. The PNG is made from the SVG, at a density
 * the person picks, for the places that only take pixels.
 *
 * The layers are stacked as the canvas stacks them, which is not plain z-order: every
 * shape, then every arrow, then all ink, and the text above everything because on the
 * canvas it is DOM over WebGL. A file that interleaved them by z would look tidier and
 * would not be the board.
 *
 * Text is laid out by a second `TextLayer`, mounted inside the engine's own element
 * so it inherits the same cascade, synced at scale 1 with exactly the objects being
 * exported, and hidden. It is the same code that lays out the canvas, so it cannot
 * disagree with the canvas about where a line breaks; `textSvg.ts` reads it back.
 */

import {
  type ObjectData,
  absolutePoints,
  arrowPolyline,
  isArrowLike,
  isFreedraw,
  isTextBearing,
  resolveArrowProps,
  resolveFreedrawProps,
  resolveTextProps,
} from '@meadow/schema'

import { TextLayer } from '../overlay/textLayer'
import { fontReady } from '../text/measure'
import { FONT_FACE_NAMES } from '../text/textStyle'
import { resolveStyle, shapeKindFor } from '../style'
import {
  type Bounds,
  arrowSvg,
  emptyBounds,
  extendByBox,
  idSource,
  inkSvg,
  shapeSvg,
  svgDocument,
} from './sceneSvg'
import { type FontUse, boxSvg, embedFonts } from './textSvg'

export type SceneFrame = { x: number; y: number; w: number; h: number }

export type SceneInput = {
  /** What to draw, bottom to top. */
  objects: readonly ObjectData[]
  /** The world rectangle to show, or null to fit what is drawn with a margin round it. */
  frame: SceneFrame | null
  /** Where the hidden text layer is mounted: the engine's element, for its cascade. */
  host: HTMLElement
  dark: boolean
  /** The board's ink: the default for text and for pen strokes. */
  ink: number
  /** The default for an arrow that never chose a colour. */
  connectorInk: number
  /** A CSS colour to fill the frame with, or null for transparent. */
  background: string | null
  title: string
  html(id: string): string
}

export type SceneImage = {
  svg: string
  /** The world rectangle the file shows. Its natural size is one pixel per world unit. */
  frame: SceneFrame
}

/** Margin round a fitted export, in world units. */
const FIT_MARGIN = 32

/**
 * Curved arrows are flattened, and the canvas picks the count from the zoom. A file
 * has no zoom, so it gets the most the schema will make. At 256 segments the turn
 * between two of them is a fraction of a degree, which no zoom makes visible.
 */
const CURVE_SEGMENTS = 256

const IDENTITY = { tx: 0, ty: 0, scale: 1 }

export async function buildSceneSvg(input: SceneInput): Promise<SceneImage | null> {
  const container = document.createElement('div')
  container.setAttribute('aria-hidden', 'true')
  container.style.cssText = [
    'position:absolute',
    'left:0',
    'top:0',
    'width:0',
    'height:0',
    'overflow:visible',
    'visibility:hidden',
    'pointer-events:none',
    'z-index:-1',
  ].join(';')
  input.host.appendChild(container)

  const layer = new TextLayer(container, {
    html: input.html,
    // Measuring is the live overlay's job. This copy only lays out what is already
    // stored, and must never write a size back into the document.
    onMeasured: () => undefined,
  })
  layer.ink = input.ink
  layer.columnType = null

  try {
    const texts: { object: ObjectData; z: number }[] = []
    input.objects.forEach((object, z) => {
      if (isTextBearing(object.type)) texts.push({ object, z })
    })

    // An optional face the canvas has not drawn yet would lay out in a fallback, and
    // the export would break its lines somewhere the board does not. So every face the
    // exported text is set in is loaded first, and the layer is laid out again once
    // they are in.
    layer.sync(IDENTITY, texts)
    const families = new Set(texts.map(({ object }) => resolveTextProps(object).fontFamily))
    await Promise.all(
      Array.from(families).flatMap((family) => {
        const name = FONT_FACE_NAMES[family]
        return [
          document.fonts.load(`16px "${name}"`).catch(() => undefined),
          document.fonts.load(`700 16px "${name}"`).catch(() => undefined),
        ]
      }),
    )
    for (const family of families) fontReady(family)
    await document.fonts.ready.catch(() => undefined)
    layer.invalidateAll()
    layer.sync(IDENTITY, texts)

    const bounds: Bounds = emptyBounds()
    const ids = idSource()
    let shapes = ''
    let arrows = ''
    let ink = ''

    for (const object of input.objects) {
      if (isArrowLike(object.type)) {
        const style = resolveArrowProps(object)
        const anchors = absolutePoints(object, style)
        const label = layer.labelBounds(object.id)
        arrows += arrowSvg(
          {
            points: arrowPolyline(
              anchors,
              style.routing,
              style.curvature,
              style.curvatureEnd,
              CURVE_SEGMENTS,
            ),
            stroke: typeof object.props.stroke === 'number' ? style.stroke : input.connectorInk,
            strokeAlpha: style.strokeAlpha * object.opacity,
            strokeWidth: style.strokeWidth,
            startHead: style.startHead,
            endHead: style.endHead,
            headSize: style.headSize,
            gap: label ?? undefined,
          },
          bounds,
        )
        continue
      }

      if (isFreedraw(object.type)) {
        const props = resolveFreedrawProps(object)
        ink += inkSvg(
          object,
          props,
          typeof object.props.stroke === 'number' ? props.stroke : input.ink,
          props.strokeAlpha * object.opacity,
          bounds,
        )
        continue
      }

      const kind = shapeKindFor(object.type)
      if (kind === null) continue
      const style = resolveStyle(object, kind, input.dark)
      const drawn = shapeSvg(object, style, ids)
      if (drawn === '') continue
      shapes += drawn
      extendByBox(bounds, object, style.strokeWidth / 2)
    }

    const origin = layer.root.getBoundingClientRect()
    const fonts: FontUse = new Map()
    const depth = new Map(texts.map(({ object, z }) => [object.id, z]))
    let text = ''
    for (const box of layer
      .shownBoxes()
      .sort((a, b) => (depth.get(a.id) ?? 0) - (depth.get(b.id) ?? 0))) {
      text += boxSvg(box.element, box.rotation, { x: origin.left, y: origin.top }, fonts, bounds)
    }

    let frame = input.frame
    if (frame === null) {
      if (!Number.isFinite(bounds.minX)) return null
      frame = {
        x: bounds.minX - FIT_MARGIN,
        y: bounds.minY - FIT_MARGIN,
        w: bounds.maxX - bounds.minX + FIT_MARGIN * 2,
        h: bounds.maxY - bounds.minY + FIT_MARGIN * 2,
      }
    }

    const faces = await embedFonts(fonts)
    const defs = faces === '' ? '' : `<style><![CDATA[\n${faces}\n]]></style>`

    return {
      svg: svgDocument({
        view: frame,
        background: input.background,
        defs,
        body:
          `<g id="shapes">${shapes}</g>` +
          `<g id="connectors">${arrows}</g>` +
          `<g id="ink">${ink}</g>` +
          `<g id="text">${text}</g>`,
        title: input.title,
      }),
      frame,
    }
  } finally {
    layer.destroy()
    container.remove()
  }
}

// --- pixels ----------------------------------------------------------------------------

/**
 * The largest PNG offered: half a billion pixels, and 65,535 a side.
 *
 * Not a canvas limit. Past what one canvas holds (`CANVAS_SIDE`, `CANVAS_PIXELS`) the
 * image is drawn a tile at a time and its rows streamed through the encoder, so the
 * full picture never exists in memory, only one band of it and the compressed file.
 * The ceiling is about time and about the file being openable: at this size a flat
 * diagram encodes in well under a minute and lands in the tens of megabytes, and much
 * past it most image viewers give up before the browser does. Past here the answer is
 * the SVG, which has no ceiling at all.
 */
export const MAX_PNG_SIDE = 65_535
export const MAX_PNG_PIXELS = 500_000_000

/** What one canvas is trusted to hold in every engine. Larger goes through tiles. */
const CANVAS_SIDE = 16_384
const CANVAS_PIXELS = 64_000_000
/** One tile of a tiled render, at most this wide. */
const TILE = 4_096
/**
 * The most one band of rows may hold, in bytes. A band is the full width of the image,
 * so its height follows from this rather than being fixed: 4,096 rows of a 30,000-pixel
 * image was half a gigabyte, and that is what ran a test machine out of memory.
 */
const BAND_BYTES = 64 * 1024 * 1024

/** Pixel size for a density, and the density actually used once the ceiling applies. */
export function pngSize(
  frame: SceneFrame,
  density: number,
): { width: number; height: number; density: number; capped: boolean } {
  const w = Math.max(frame.w, 1)
  const h = Math.max(frame.h, 1)
  const ceiling = Math.min(MAX_PNG_SIDE / w, MAX_PNG_SIDE / h, Math.sqrt(MAX_PNG_PIXELS / (w * h)))
  const used = Math.min(density, ceiling)
  return {
    width: Math.max(1, Math.floor(w * used)),
    height: Math.max(1, Math.floor(h * used)),
    density: used,
    capped: used < density,
  }
}

/**
 * Wait for the fonts inside an SVG image to land.
 *
 * `decode()` resolves before the image's own `@font-face` rules have loaded, and text
 * in a face still loading is drawn invisible. The first PNG this made had its bold and
 * its headings and none of its regular text, because the regular face lost the race.
 * The image's font state is not reachable from here, so the picture itself is the
 * signal: it is drawn small until it has stopped changing for a while, which is when
 * every face it asked for is in. Capped, so a face that never loads costs a few
 * seconds and a fallback rather than a download that never comes.
 */
async function fontsSettled(image: HTMLImageElement, width: number, height: number): Promise<void> {
  const scale = Math.min(1, 640 / Math.max(width, height))
  const probe = document.createElement('canvas')
  probe.width = Math.max(1, Math.round(width * scale))
  probe.height = Math.max(1, Math.round(height * scale))
  const context = probe.getContext('2d', { willReadFrequently: true })
  if (context === null) return

  const signature = (): number => {
    context.clearRect(0, 0, probe.width, probe.height)
    context.drawImage(image, 0, 0, probe.width, probe.height)
    const data = context.getImageData(0, 0, probe.width, probe.height).data
    let hash = 0
    for (let i = 0; i < data.length; i += 1) hash = (hash * 31 + data[i]) | 0
    return hash
  }

  const STEP_MS = 50
  const QUIET_STEPS = 8
  const LIMIT_MS = 5_000
  let last = signature()
  let quiet = 0
  for (let waited = 0; waited < LIMIT_MS && quiet < QUIET_STEPS; waited += STEP_MS) {
    await new Promise((resolve) => window.setTimeout(resolve, STEP_MS))
    const next = signature()
    quiet = next === last ? quiet + 1 : 0
    last = next
  }
}

/** The SVG as a decoded image with its fonts in, and how to let it go. */
async function loadImage(
  svg: string,
  width: number,
  height: number,
): Promise<{ image: HTMLImageElement; release: () => void }> {
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const image = new Image()
    image.decoding = 'async'
    image.src = url
    await image.decode()
    await fontsSettled(image, width, height)
    return { image, release: () => URL.revokeObjectURL(url) }
  } catch (error) {
    URL.revokeObjectURL(url)
    throw error
  }
}

/** True when a size fits in one canvas, which is encoded by the browser itself. */
const fitsOneCanvas = (width: number, height: number): boolean =>
  width <= CANVAS_SIDE && height <= CANVAS_SIDE && width * height <= CANVAS_PIXELS

/**
 * Draw the SVG at a pixel size and encode it as PNG.
 *
 * The browser rasterises an SVG image at the size it is drawn, so this is the vector
 * rendered at the target resolution, not a small picture scaled up. Fonts are inside
 * the file as data, which an image is allowed to load, so the type is right.
 *
 * `onProgress` hears the fraction done, for the tiled path, which can take a while.
 */
export async function rasterizeSvg(
  svg: string,
  width: number,
  height: number,
  onProgress?: (done: number) => void,
): Promise<Blob> {
  const { image, release } = await loadImage(svg, width, height)
  try {
    return fitsOneCanvas(width, height)
      ? await singleCanvas(image, width, height)
      : await tiled(image, width, height, onProgress)
  } finally {
    release()
  }
}

/**
 * How large the PNG will be at any density, in bytes, from two small samples.
 *
 * A diagram's PNG does not grow with its pixel count alone. Flat colour costs a little
 * per pixel, so it grows with the area, and every edge costs a little per pixel of its
 * length, so that part grows with the density rather than its square. Two encodes at
 * small densities fix both rates, `bytes = a * d^2 + b * d`, and the rest is
 * arithmetic. Each sample goes through the encoder the real file would use, since the
 * browser's own and the tiled one compress differently. An estimate, and the dialog
 * says "about": text and gradients do not fit the model exactly.
 */
export async function pngEstimator(
  svg: string,
  frame: SceneFrame,
): Promise<(density: number) => number> {
  const area = Math.max(frame.w, 1) * Math.max(frame.h, 1)
  // Densities that give about a million and four million pixels. Smaller samples are
  // mostly antialiased edge and overestimated a flat diagram by more than double;
  // these are close enough to a real file's balance and still encode in seconds.
  const d1 = Math.sqrt(1_000_000 / area)
  const d2 = d1 * 2
  const size = (d: number) => ({
    width: Math.max(1, Math.floor(frame.w * d)),
    height: Math.max(1, Math.floor(frame.h * d)),
  })
  const first = size(d1)
  const { image, release } = await loadImage(svg, first.width, first.height)
  try {
    const sample = async (d: number, tiledEncoder: boolean): Promise<number> => {
      const { width, height } = size(d)
      const blob = tiledEncoder
        ? await tiled(image, width, height)
        : await singleCanvas(image, width, height)
      return blob.size
    }
    const fit = async (tiledEncoder: boolean) => {
      const s1 = await sample(d1, tiledEncoder)
      const s2 = await sample(d2, tiledEncoder)
      // bytes / d^2 = a + b / d, a line in 1/d through the two samples.
      const b = (s1 / (d1 * d1) - s2 / (d2 * d2)) / (1 / d1 - 1 / d2)
      const a = s1 / (d1 * d1) - b / d1
      return { a: Math.max(0, a), b: Math.max(0, b), floor: s2 }
    }
    const native = await fit(false)
    const streamed = typeof CompressionStream === 'undefined' ? native : await fit(true)
    return (density: number) => {
      const { width, height } = pngSize(frame, density)
      const d = width / Math.max(frame.w, 1)
      const model = fitsOneCanvas(width, height) ? native : streamed
      return Math.round(Math.max(model.a * d * d + model.b * d, d >= d2 ? model.floor : 0))
    }
  } finally {
    release()
  }
}

async function singleCanvas(image: HTMLImageElement, width: number, height: number): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('This browser could not make an image that large.')
  context.drawImage(image, 0, 0, width, height)

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((result) => resolve(result), 'image/png'),
  )
  // Released straight away rather than left to the collector: at full size this one
  // canvas is most of the memory the tab has.
  canvas.width = 0
  canvas.height = 0
  if (blob === null) throw new Error('This browser could not make an image that large.')
  return blob
}

/**
 * A PNG larger than any canvas, drawn in tiles and encoded as it goes.
 *
 * Each band of rows is drawn tile by tile, every tile being the whole image placed at
 * the full size and shifted so the tile's corner is at the origin. The canvas clips the
 * rest, and since every tile rasterises the same vector at the same scale and starts on
 * a whole pixel, neighbouring tiles meet without a seam. The band's rows go to the
 * deflate stream as soon as they are read and the band is dropped, so memory is one
 * band plus the compressed output, whatever the size of the image.
 *
 * Filter type 0 on every row. A diagram is long runs of one colour, which deflate
 * already finds in unfiltered rows, and filtering half a billion pixels in script
 * would cost more time than it saves bytes.
 */
async function tiled(
  image: HTMLImageElement,
  width: number,
  height: number,
  onProgress?: (done: number) => void,
): Promise<Blob> {
  if (typeof CompressionStream === 'undefined') {
    throw new Error('This browser cannot make an image that large. Use SVG instead.')
  }
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (context === null) throw new Error('This browser could not make an image that large.')

  const deflate = new CompressionStream('deflate')
  const writer = deflate.writable.getWriter()
  const chunks: Uint8Array<ArrayBuffer>[] = []
  const collected = (async () => {
    const reader = deflate.readable.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) return
      chunks.push(value)
    }
  })()

  const stride = width * 4 + 1
  const bandRows = Math.max(1, Math.min(TILE, Math.floor(BAND_BYTES / stride)))
  try {
    for (let top = 0; top < height; top += bandRows) {
      const rows = Math.min(bandRows, height - top)
      const band = new Uint8Array(stride * rows)
      for (let left = 0; left < width; left += TILE) {
        const columns = Math.min(TILE, width - left)
        canvas.width = columns
        canvas.height = rows
        context.setTransform(1, 0, 0, 1, -left, -top)
        context.drawImage(image, 0, 0, width, height)
        const pixels = context.getImageData(0, 0, columns, rows).data
        for (let y = 0; y < rows; y += 1) {
          band.set(
            pixels.subarray(y * columns * 4, (y + 1) * columns * 4),
            y * stride + 1 + left * 4,
          )
        }
      }
      await writer.write(band)
      onProgress?.(Math.min(1, (top + rows) / height))
    }
    await writer.close()
  } catch (error) {
    await writer.abort(error).catch(() => undefined)
    throw error
  } finally {
    canvas.width = 0
    canvas.height = 0
  }
  await collected

  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header[8] = 8 // bits per channel
  header[9] = 6 // RGBA
  return new Blob(
    [
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ...pngChunk('IHDR', header),
      ...idatChunks(chunks),
      ...pngChunk('IEND', new Uint8Array(0)),
    ],
    { type: 'image/png' },
  )
}

/** The compressed stream as IDAT chunks, each under the 2 GB a chunk length allows. */
function idatChunks(parts: readonly Uint8Array<ArrayBuffer>[]): Uint8Array<ArrayBuffer>[] {
  const out: Uint8Array<ArrayBuffer>[] = []
  for (const part of parts) {
    if (part.length > 0) out.push(...pngChunk('IDAT', part))
  }
  return out
}

/** Length, type, data, CRC: the three pieces of a chunk around its data, unconcatenated. */
function pngChunk(type: string, data: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer>[] {
  const head = new Uint8Array(8)
  const view = new DataView(head.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i += 1) head[4 + i] = type.charCodeAt(i)
  let crc = crc32(0xffffffff, head.subarray(4))
  crc = crc32(crc, data) ^ 0xffffffff
  const tail = new Uint8Array(4)
  new DataView(tail.buffer).setUint32(0, crc >>> 0)
  return [head, data, tail]
}

let crcTable: Uint32Array | null = null

function crc32(seed: number, bytes: Uint8Array): number {
  if (crcTable === null) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n += 1) {
      let c = n
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let crc = seed
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8)
  return crc
}
