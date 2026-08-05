/**
 * Wanderers: other people's cursors and selections. ARCHITECTURE 6.
 *
 * Drawn in screen space, from the same `ViewTransform` as everything else, because a
 * cursor must stay the same size at every zoom. Their *positions* are world
 * coordinates, so a wanderer stays on the object it is pointing at while either peer
 * pans.
 *
 * Awareness is not document state and must never reach the Y.Doc. It is ephemeral, it
 * is lost on disconnect by design, and writing it into the CRDT would put every mouse
 * movement into the update log and the undo stack.
 *
 * Nodes are pooled per wanderer rather than rebuilt, because a `Text` is expensive to
 * construct and a cursor moves on nearly every frame while its label does not change.
 */

import { Container, Graphics, Text } from 'pixi.js'

import { type ViewTransform, projectPoint } from '../camera'
import { FONT_STACKS } from '../text/textStyle'

export type Wanderer = {
  /** Yjs awareness client id. Stable for the life of a connection. */
  clientId: number
  name: string
  color: number
  /** World coordinates, or null when the pointer is off the canvas. */
  cursor: { x: number; y: number } | null
  selection: readonly string[]
}

/** Bounds of a remote selection, resolved by the engine from its own cache. */
export type WandererSelection = {
  color: number
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
}

const CURSOR_SIZE = 14
const LABEL_PADDING_X = 6
const LABEL_PADDING_Y = 3
const LABEL_OFFSET = 4

type Entry = {
  container: Container
  arrow: Graphics
  plate: Graphics
  label: Text
  name: string
  color: number
}

export class WandererLayer {
  readonly view = new Container()

  private readonly entries = new Map<number, Entry>()
  private readonly selections = new Graphics()

  constructor() {
    // Selections sit under the cursors, so a name plate is never hidden behind
    // somebody else's selection outline.
    this.view.addChild(this.selections)
  }

  /**
   * Redraw remote selections. Called with bounds already resolved, so this file never
   * needs to know how an object's bounds are computed.
   */
  drawSelections(transform: ViewTransform, selections: readonly WandererSelection[]): void {
    this.selections.clear()
    if (selections.length === 0) return

    for (const selection of selections) {
      const topLeft = projectPoint(transform, selection.bounds.minX, selection.bounds.minY)
      const bottomRight = projectPoint(transform, selection.bounds.maxX, selection.bounds.maxY)
      this.selections
        .rect(
          topLeft.x - 1,
          topLeft.y - 1,
          bottomRight.x - topLeft.x + 2,
          bottomRight.y - topLeft.y + 2,
        )
        .stroke({ width: 1.5, color: selection.color, alpha: 0.85 })
    }
  }

  /** Position every cursor. Wanderers that have left are torn down. */
  drawCursors(transform: ViewTransform, wanderers: readonly Wanderer[]): void {
    const present = new Set<number>()

    for (const wanderer of wanderers) {
      if (wanderer.cursor === null) continue
      present.add(wanderer.clientId)

      const entry = this.entryFor(wanderer)
      const point = projectPoint(transform, wanderer.cursor.x, wanderer.cursor.y)
      // Whole pixels: a cursor is a small high-contrast shape and half-pixel
      // positioning makes its edges shimmer as it moves.
      entry.container.position.set(Math.round(point.x), Math.round(point.y))
    }

    for (const [clientId, entry] of this.entries) {
      if (present.has(clientId)) continue
      entry.container.destroy({ children: true })
      this.entries.delete(clientId)
    }
  }

  private entryFor(wanderer: Wanderer): Entry {
    const existing = this.entries.get(wanderer.clientId)
    if (existing !== undefined) {
      // Name and colour change far less often than position, so redrawing them every
      // frame would be most of this layer's cost for no visible difference.
      if (existing.name !== wanderer.name || existing.color !== wanderer.color) {
        existing.name = wanderer.name
        existing.color = wanderer.color
        existing.label.text = wanderer.name
        existing.label.style.fill = 0xffffff
        this.paint(existing)
      }
      return existing
    }

    const container = new Container()
    const arrow = new Graphics()
    const plate = new Graphics()
    const label = new Text({
      text: wanderer.name,
      style: {
        fontFamily: FONT_STACKS.inter,
        fontSize: 11,
        fontWeight: '600',
        fill: 0xffffff,
      },
    })

    container.addChild(arrow, plate, label)
    this.view.addChild(container)

    const entry: Entry = { container, arrow, plate, label, name: wanderer.name, color: wanderer.color }
    this.paint(entry)
    this.entries.set(wanderer.clientId, entry)
    return entry
  }

  /** Draw the pointer and its name plate at the container's origin. */
  private paint(entry: Entry): void {
    entry.arrow
      .clear()
      // A classic pointer, tip at the origin so the shape sits where the cursor is
      // rather than beside it.
      .poly([0, 0, 0, CURSOR_SIZE, CURSOR_SIZE * 0.29, CURSOR_SIZE * 0.72, CURSOR_SIZE * 0.62, CURSOR_SIZE * 0.95])
      .fill({ color: entry.color })
      .stroke({ width: 1, color: 0xffffff, alpha: 0.9 })

    const width = entry.label.width + LABEL_PADDING_X * 2
    const height = entry.label.height + LABEL_PADDING_Y * 2
    const x = CURSOR_SIZE * 0.6
    const y = CURSOR_SIZE * 0.9 + LABEL_OFFSET

    entry.plate.clear().roundRect(x, y, width, height, 4).fill({ color: entry.color })
    entry.label.position.set(x + LABEL_PADDING_X, y + LABEL_PADDING_Y)
  }

  destroy(): void {
    for (const entry of this.entries.values()) entry.container.destroy({ children: true })
    this.entries.clear()
    this.view.destroy({ children: true })
  }
}
