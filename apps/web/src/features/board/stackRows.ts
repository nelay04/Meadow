/**
 * The stack, as rows.
 *
 * `order` is a `Y.Array` of ids and nothing else - see the z-order section of
 * `doc/mutations.ts` - so everything a person needs to recognise a row by has to be
 * assembled from the object it points at. That assembly is here rather than in the
 * panel because it is the part worth testing: the panel is markup and pointer
 * handling, and this is the answer to "which of these forty rectangles is the one I
 * am looking for".
 *
 * Front first. The array is stored back to front, because index equals depth and depth
 * counts up from the paper, but a list is read from the top and the top of a stack is
 * the thing you can see. Reversing here rather than in the panel keeps the two
 * co-ordinate systems in one file, and `z` carries the depth so nothing downstream has
 * to invert an index to talk to the document.
 */

import type { ObjectData, ObjectType } from '@meadow/schema'

import { fragmentToPlainText } from '../../doc/richText'
import { type DocSession, objectFragment } from '../../doc/mutations'

export type StackRow = {
  id: string
  type: ObjectType
  /**
   * Depth, one-based, counting from the back.
   *
   * One-based because it is shown to a person and typed back in by one, and "layer 0"
   * is a thing only a programmer would write. The document's own index is `z - 1`, and
   * `StackPanel` is the only place that subtraction happens.
   */
  z: number
  /** What the row is called: its own words where it has any, its kind where it has not. */
  label: string
  /** True when the label is the object's own text rather than the name of its kind. */
  named: boolean
  locked: boolean
}

/** What a row is called when the object has nothing written in it. */
const KIND_NOUNS: Record<ObjectType, string> = {
  text: 'Text',
  sticky: 'Sticky',
  rect: 'Rectangle',
  ellipse: 'Ellipse',
  diamond: 'Diamond',
  parallelogram: 'Parallelogram',
  triangle: 'Triangle',
  trapezoid: 'Trapezoid',
  polygon: 'Polygon',
  cylinder: 'Cylinder',
  line: 'Line',
  arrow: 'Arrow',
  freedraw: 'Ink',
  image: 'Image',
  table: 'Table',
  chart: 'Chart',
  frame: 'Frame',
  embed: 'Embed',
}

export function kindNoun(type: ObjectType): string {
  return KIND_NOUNS[type] ?? 'Object'
}

/**
 * How much of an object's text is worth putting in a row.
 *
 * A row is one line and the panel is fifteen rems wide, so anything past this is
 * ellipsis either way. Cutting here rather than in CSS also caps what the newline
 * collapse below has to walk, which matters because a text object can hold a page.
 */
const LABEL_LIMIT = 60

/**
 * One line of an object's own writing, or ''.
 *
 * Newlines become spaces rather than being kept: a row is a single line, and a label
 * with a hard break in it silently loses everything after the break, so the second
 * sentence of a sticky would simply not exist as far as the list is concerned.
 */
function labelFor(session: DocSession, id: string): string {
  const fragment = objectFragment(session, id)
  if (fragment === null) return ''
  const text = fragmentToPlainText(fragment).replace(/\s+/g, ' ').trim()
  return text.length > LABEL_LIMIT ? `${text.slice(0, LABEL_LIMIT).trimEnd()}…` : text
}

/**
 * Every object as a row, front first.
 *
 * `objects` arrives from `useObjects`, which is already in the document's own order and
 * already re-read on every change, including a change to an object's text. So this is a
 * pure map over it and holds no state: the panel gets a fresh array whenever anything
 * anybody did could have changed what a row says.
 */
export function stackRows(session: DocSession, objects: readonly ObjectData[]): StackRow[] {
  const rows: StackRow[] = []
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const object = objects[index]
    const label = labelFor(session, object.id)
    rows.push({
      id: object.id,
      type: object.type,
      z: index + 1,
      label: label === '' ? kindNoun(object.type) : label,
      named: label !== '',
      locked: object.locked,
    })
  }
  return rows
}

/**
 * Where a block of dragged rows lands, expressed as the row it should sit behind.
 *
 * `gap` is a position in the rendered list: 0 is above the first row, `rows.length` is
 * below the last. The answer is the id of the row that will end up directly in front of
 * the block, or null for "nothing in front of it, put it on top", which is what
 * `moveBehind` takes.
 *
 * The dragged rows are filtered out before the neighbour is picked, and that is the
 * whole reason this is a function rather than an expression at the call site. A drop
 * two rows below where the block started must not count the block's own rows as
 * neighbours it is being placed against, or every downward drag lands short by exactly
 * the size of the selection.
 */
export function dropTarget(
  rows: readonly StackRow[],
  dragged: ReadonlySet<string>,
  gap: number,
): string | null {
  let above = 0
  for (let index = 0; index < gap && index < rows.length; index += 1) {
    if (!dragged.has(rows[index].id)) above += 1
  }
  if (above === 0) return null

  const rest = rows.filter((row) => !dragged.has(row.id))
  return rest[above - 1]?.id ?? null
}
