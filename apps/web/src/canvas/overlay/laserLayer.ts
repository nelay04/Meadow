/**
 * Laser marks: a bright trail that fades, and is never written down.
 *
 * The laser is the one mark on a glade that is not an object. It exists to say "this
 * one, here, now" while somebody is talking over a board, and the whole value of it is
 * that it disappears: a board annotated with a dozen permanent red scribbles is a board
 * somebody has to tidy up afterwards. So nothing here touches the Y.Doc, the undo stack
 * or the thumbnail. It rides awareness beside the cursors, for the same reason they do.
 *
 * Drawn in screen space from the same `ViewTransform` as the wanderers, because a laser
 * is a pointer rather than a mark on the paper: it stays the same width at every zoom.
 * Its *points* are world coordinates, so a trail stays on the thing it was drawn around
 * while either end pans.
 *
 * **One line, one width, one opacity.** No taper along the trail, no glow under it and
 * no per-segment alpha. A stroke that thins and dims as it goes has to be drawn as
 * dozens of separate strokes, and every joint between two of them is a seam that
 * catches the light differently - which is what makes a soft-edged trail read as
 * blurry rather than as bright. A single crisp path at a constant width reads as a beam.
 * The mark still fades, but as a whole and over time, which is a different thing from a
 * gradient baked along its length.
 *
 * Each trail is one pooled `Graphics`, rebuilt every frame, which is the opposite of
 * how dry ink is drawn and right for the same reason the wet stroke is: this geometry
 * is different on every frame by definition.
 */

import { Container, Graphics } from 'pixi.js'

import { type ViewTransform, projectPoint } from '../camera'

/**
 * One trail to draw.
 *
 * `points` are flat world `[x, y]` pairs, oldest first. `alpha` applies to the whole
 * mark: 1 while somebody is pointing, ramping to 0 once they have stopped.
 */
export type LaserTrail = {
  /** 'local', or the awareness client id of the peer pointing. */
  key: string | number
  alpha: number
  points: readonly number[]
}

/**
 * One colour and one width, for everybody, in both themes.
 *
 * Blue rather than the red a laser pointer throws. Red on a board already means
 * something: it is the pen colour people correct and cross out in, and a mark that
 * cannot be erased because it was never written is the worst possible thing to confuse
 * with one that can.
 *
 * The width is in screen pixels, at every zoom and along the whole length: thin enough
 * to point *at* something rather than cover it, heavy enough to hold its colour against
 * a board full of shapes.
 */
const LASER_COLOR = 0x0a84ff
const LASER_WIDTH = 3.5

export class LaserLayer {
  readonly view = new Container()

  private readonly trails = new Map<string | number, Graphics>()

  /** Redraw every trail. Trails that have gone are torn down. */
  draw(transform: ViewTransform, trails: readonly LaserTrail[]): void {
    const present = new Set<string | number>()

    for (const trail of trails) {
      if (trail.points.length < 2 || trail.alpha <= 0) continue
      present.add(trail.key)
      this.paint(this.graphicsFor(trail.key), transform, trail)
    }

    for (const [key, graphics] of this.trails) {
      if (present.has(key)) continue
      graphics.destroy()
      this.trails.delete(key)
    }
  }

  private graphicsFor(key: string | number): Graphics {
    const existing = this.trails.get(key)
    if (existing !== undefined) return existing

    const graphics = new Graphics()
    this.view.addChild(graphics)
    this.trails.set(key, graphics)
    return graphics
  }

  private paint(graphics: Graphics, transform: ViewTransform, trail: LaserTrail): void {
    graphics.clear()

    const count = trail.points.length / 2
    const screen = new Float32Array(count * 2)
    for (let index = 0; index < count; index += 1) {
      const at = projectPoint(transform, trail.points[index * 2], trail.points[index * 2 + 1])
      screen[index * 2] = at.x
      screen[index * 2 + 1] = at.y
    }

    // A tap: one point, and no segment to put a round cap on. Pixi draws nothing for a
    // zero-length line, so the dot has to be a dot.
    if (count === 1) {
      graphics
        .circle(screen[0], screen[1], LASER_WIDTH / 2)
        .fill({ color: LASER_COLOR, alpha: trail.alpha })
      return
    }

    /*
     * Through the midpoints, with the sampled points as the control handles.
     *
     * The classic quadratic smoothing, and the cheapest real answer to a hand: joining
     * the samples with straight lines draws every one of them, so a slow deliberate arc
     * arrives as a row of tiny flats and the corners between them glint. Curving
     * between midpoints instead puts the sampled point off the curve, where it steers
     * rather than appears - so the tremor still bends the line, but it can no longer
     * put a corner in it.
     */
    graphics.moveTo(screen[0], screen[1])
    for (let index = 1; index < count - 1; index += 1) {
      graphics.quadraticCurveTo(
        screen[index * 2],
        screen[index * 2 + 1],
        (screen[index * 2] + screen[(index + 1) * 2]) / 2,
        (screen[index * 2 + 1] + screen[(index + 1) * 2 + 1]) / 2,
      )
    }
    graphics.lineTo(screen[(count - 1) * 2], screen[(count - 1) * 2 + 1])

    // One stroke for the whole path. Round caps and joins are what let it turn back on
    // itself - a circle drawn round a shape crosses its own tail - without a notch.
    graphics.stroke({
      width: LASER_WIDTH,
      color: LASER_COLOR,
      alpha: trail.alpha,
      cap: 'round',
      join: 'round',
    })
  }

  destroy(): void {
    for (const graphics of this.trails.values()) graphics.destroy()
    this.trails.clear()
    this.view.destroy({ children: true })
  }
}
