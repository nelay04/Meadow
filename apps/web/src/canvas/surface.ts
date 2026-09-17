import type { FontFamily } from '@meadow/schema'

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
  fontFamily: FontFamily
  fontSize: number
  lineHeight: number
  padding: number
  /** How heavy the writing is drawn. See `WRITING_WEIGHT`. */
  fontWeight: number
}

/**
 * The weight a lea's writing is set at: a step under regular.
 *
 * A page of diary reads as handwriting, and at 400 two of its faces did not: Noto's
 * Indic scripts run a stroke along every word and read nearly bold beside Comic Neue,
 * and Poppins' geometric shapes read a notch darker than the hand faces. 350 lands both
 * on something lighter - Noto is variable and draws at 350, Poppins has a Light file
 * for anything under 400 (public/fonts/fonts.css) - while a face with nothing under
 * 400, Comic Neue among them, falls back to its regular and does not change at all.
 *
 * Rendering only. It is not written to the document, and a glade keeps its text at the
 * weight it always had.
 */
export const WRITING_WEIGHT = 350

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
