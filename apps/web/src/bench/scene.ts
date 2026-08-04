/**
 * Deterministic scene generation for the renderer benchmark.
 *
 * Seeded, so every strategy renders byte-identical input and a run is comparable to
 * the one before it.
 */

export type BenchShape = 'rect' | 'ellipse' | 'diamond'

export type BenchObject = {
  id: string
  shape: BenchShape
  x: number
  y: number
  w: number
  h: number
  rotation: number
  fill: number
  stroke: number
  strokeWidth: number
  radius: number
}

/** mulberry32: small, fast, and reproducible across engines. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const SHAPES: BenchShape[] = ['rect', 'ellipse', 'diamond']

const PALETTE = [
  0x4f8a6d, 0x6fcf97, 0x2f7d4f, 0xe8c468, 0xd88c5a, 0x7b8fd4, 0xc47ba0, 0x5aa7c4,
]

/**
 * `spread` is the world box the objects fill. The benchmark sizes it to the viewport
 * so that all `count` objects are genuinely on screen - the exit criterion is 5,000
 * objects *visible*, and culling would otherwise quietly do the work.
 */
export function generateScene(count: number, spread: { w: number; h: number }): BenchObject[] {
  const random = seeded(0x5eed)
  const objects: BenchObject[] = []

  for (let index = 0; index < count; index += 1) {
    const w = 40 + random() * 120
    const h = 30 + random() * 90
    objects.push({
      id: `bench-${index}`,
      shape: SHAPES[Math.floor(random() * SHAPES.length)],
      x: random() * (spread.w - w),
      y: random() * (spread.h - h),
      w,
      h,
      rotation: random() < 0.25 ? random() * Math.PI * 2 : 0,
      fill: PALETTE[Math.floor(random() * PALETTE.length)],
      stroke: 0x1a1a1a,
      strokeWidth: 1 + Math.floor(random() * 2),
      radius: random() < 0.4 ? 4 + random() * 8 : 0,
    })
  }

  return objects
}
