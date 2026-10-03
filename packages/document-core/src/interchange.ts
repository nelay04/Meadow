/**
 * A glade as a file, and a file as something to put back into a glade.
 *
 * The format is defined in `packages/schema/src/interchange.ts`. This is the half that
 * touches a live document, and it only reads: writing a file into a document is
 * `importGlade` in `mutations.ts`, for the reason that file gives. The Y constructors at
 * the bottom build detached types and write nothing until something integrates them.
 *
 * Nothing here needs a DOM, so the same code can run anywhere a Y.Doc can.
 */

import {
  type BindingData,
  type GladeBoard,
  type GladeFile,
  type GladeMetaValue,
  type GladeObject,
  type GladeRichRun,
  GLADE_EXTENSION,
  GLADE_FORMAT,
  GLADE_VERSION,
  objectText,
  readBinding,
  readObject,
} from '@meadow/schema'
import * as Y from 'yjs'

import type { DocSession, DocSnapshot } from './mutations'
import { fragmentToNodes, setFragmentNodes } from './richText'

/**
 * A shared type or a plain value, written for the file.
 *
 * Shared types are tagged so the import can rebuild the same kind of type; see the note
 * on `meta` in the schema. Anything that is neither is written as null rather than
 * thrown on, since `meta` is open and a peer may have put something odd in it.
 */
export function encodeYValue(value: unknown): GladeMetaValue {
  if (value instanceof Y.Map) {
    const out: Record<string, GladeMetaValue> = {}
    for (const [key, entry] of value.entries()) out[key] = encodeYValue(entry)
    return { $y: 'map', value: out }
  }
  if (value instanceof Y.Array) return { $y: 'array', value: value.toArray().map(encodeYValue) }
  if (value instanceof Y.XmlFragment) return { $y: 'xml', value: fragmentToNodes(value) }
  if (value instanceof Y.Text) return { $y: 'text', value: value.toDelta() as GladeRichRun[] }
  if (value === undefined) return null
  if (value instanceof Uint8Array) return null
  // A plain object or array stored in a Y.Map is JSON already; the round trip through
  // stringify drops what JSON cannot hold rather than writing it half-way.
  return JSON.parse(JSON.stringify(value)) as GladeMetaValue
}

function isTagged(value: GladeMetaValue): value is Extract<GladeMetaValue, { $y: string }> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && '$y' in value
}

/**
 * The detached Y type or plain value a file entry stands for.
 *
 * Detached is the point: Yjs queues content written into a type before it is integrated
 * and replays it on insertion, so a whole `pages` array arrives in the one update that
 * sets it rather than one update per field.
 */
export function buildYValue(value: GladeMetaValue): unknown {
  if (!isTagged(value)) return value
  switch (value.$y) {
    case 'map': {
      const map = new Y.Map<unknown>()
      for (const [key, entry] of Object.entries(value.value)) map.set(key, buildYValue(entry))
      return map
    }
    case 'array': {
      const array = new Y.Array<unknown>()
      array.insert(0, value.value.map(buildYValue))
      return array
    }
    case 'text': {
      const text = new Y.Text()
      text.applyDelta(value.value)
      return text
    }
    case 'xml': {
      const fragment = new Y.XmlFragment()
      setFragmentNodes(fragment, value.value)
      return fragment
    }
  }
}

/**
 * Read a whole glade into a file.
 *
 * A pure read. `order` is written exactly as stored and the objects follow it, with any
 * the order does not list after the rest, so the file reads bottom to top the way the
 * board is stacked.
 */
export function exportGlade(
  session: DocSession,
  board: GladeBoard,
  options: { app: string; now?: Date },
): GladeFile {
  const order = session.order.toArray()
  // A set, because `order` can briefly list an id twice after a concurrent move, and an
  // object written twice would be read back as a duplicate and dropped.
  const ids = new Set(order.filter((id) => session.objects.has(id)))
  for (const id of session.objects.keys()) ids.add(id)

  const objects: GladeObject[] = []
  for (const id of ids) {
    const map = session.objects.get(id)
    if (map === undefined) continue
    const fragment = objectText(map)
    objects.push({ ...readObject(map), text: fragment === null ? null : fragmentToNodes(fragment) })
  }

  const bindings: BindingData[] = []
  for (const map of session.bindings.values()) bindings.push(readBinding(map))

  const meta: Record<string, GladeMetaValue> = {}
  for (const [key, value] of session.meta.entries()) meta[key] = encodeYValue(value)

  return {
    format: GLADE_FORMAT,
    version: GLADE_VERSION,
    exportedAt: (options.now ?? new Date()).toISOString(),
    app: options.app,
    board: { title: board.title, kind: board.kind },
    meta,
    order,
    objects,
    bindings,
    assets: {},
  }
}

/** A file as text. Indented, because a person or a model is as likely to read it as a parser. */
export function serialiseGlade(file: GladeFile): string {
  return `${JSON.stringify(file, null, 2)}\n`
}

/**
 * A file as a paste: for dropping a glade into one that already has things in it.
 *
 * Ids are remapped on the way in by `insertSnapshot`, so this is the path that cannot
 * collide. It carries objects and bindings and nothing from `meta`, which belongs to the
 * board the file came from and not to the one it is being dropped on.
 */
export function gladeToSnapshot(file: GladeFile): DocSnapshot {
  const byId = new Map(file.objects.map((object) => [object.id, object]))
  const objects = file.order.flatMap((id) => {
    const entry = byId.get(id)
    if (entry === undefined) return []
    const { text, ...object } = entry
    return [{ object, text }]
  })
  return { objects, bindings: file.bindings }
}

/** A filename for a glade: its title with the characters filesystems refuse taken out. */
export function gladeFilename(title: string): string {
  const safe = title
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return `${safe === '' ? 'glade' : safe}${GLADE_EXTENSION}`
}
