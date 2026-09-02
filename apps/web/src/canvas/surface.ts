/**
 * What the board is drawn on.
 *
 * A surface is paper, not a mode. Every surface holds the same infinite canvas, the
 * same objects and the same tools; only the background under them differs, and the
 * background is CSS (see `.canvas-host` in styles.css). The engine's whole share of
 * this is keeping the repeating layers in step with the camera, which is why a
 * surface is a string here rather than a renderer.
 *
 * Deliberately not named after anything in the product. `src/canvas/` stays
 * extractable, so it knows about graph paper and ruled paper, and nothing about what
 * a glade or a lea is. The mapping lives in `features/boards/kinds.ts`.
 */

export const CANVAS_SURFACES = ['graph', 'ruled'] as const

export type CanvasSurface = (typeof CANVAS_SURFACES)[number]

export const DEFAULT_SURFACE: CanvasSurface = 'graph'

/** The class the host element carries, so CSS can pick the paper. */
export function surfaceClass(surface: CanvasSurface): string {
  return `surface-${surface}`
}

/**
 * The type a ruled surface sets, overriding what an object's own props say.
 *
 * On a writing surface the type is not the object's to choose: the rules are drawn at
 * `fontSize * lineHeight` and the writing has to sit on them, so a row that kept the
 * size it was created at would walk off the lines the moment the surface's spec
 * changed. The spec wins, and every row on the page is set from it.
 */
export type SurfaceType = {
  fontSize: number
  lineHeight: number
  padding: number
}

/**
 * How the graph surface rules itself: lines, or dots at their crossings.
 *
 * A pattern is not a surface. Both draw the same cell at the same spacing and mean
 * the same ruler; one draws the whole rule and the other only where two would meet.
 * Keeping it separate is what lets it be a reader's own preference rather than a
 * property of the board - nobody else on the glade sees it change - and it is why
 * the ruled paper ignores it entirely: a writing line with its middle rubbed out is
 * not a writing line.
 */
export const GRID_PATTERNS = ['lines', 'dots'] as const

export type GridPattern = (typeof GRID_PATTERNS)[number]

export const DEFAULT_GRID_PATTERN: GridPattern = 'lines'

/** The class the host element carries, so CSS can pick the pattern. */
export function gridPatternClass(pattern: GridPattern): string {
  return `grid-${pattern}`
}
