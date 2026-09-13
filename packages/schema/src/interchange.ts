/**
 * The glade interchange format: a whole board as one JSON file.
 *
 * What it is for is a round trip that loses nothing. Export a glade, import the file,
 * export again, and the two files are the same file. That is the test this format is
 * held to (`apps/web/src/doc/interchange.test.ts`), and it is a stronger promise than a
 * picture of the board: the file says which shape an arrow is bound to, where on its
 * edge, what is written on it and in which marks, and what order everything is stacked
 * in. Something outside this app - a script, another tool, a language model - can read
 * that and write it back.
 *
 * It is a representation of ARCHITECTURE 4, not a change to it. The Y.Doc is still the
 * state; this is what it looks like written down. So the shape follows the document's
 * roots closely: objects with their ids, bindings with theirs, `order` as the z-order,
 * and `meta` as it is stored.
 *
 * Two decisions that matter for a reader:
 *
 * - Ids are kept. An import goes into a fresh document, where nothing can collide, and a
 *   stable id is what lets anything outside the app refer to "that box" across an export
 *   and an import. Pasting a file into a glade that already has objects in it is a
 *   different operation and goes through the clipboard's path, which remaps.
 * - `props` is carried as it stands, keys this build does not know included. A file from
 *   a newer build keeps its newer styling when it passes through an older one.
 *
 * Everything read in is validated. A file is a string somebody else wrote, so an entry
 * that fails is dropped and counted rather than failing the import, and the count is
 * reported: degraded, and said so, never silently wrong (ARCHITECTURE 12).
 */

import { z } from 'zod'

import { bindingData, type BindingData } from './bindings'
import { objectData, type ObjectData } from './objects'

/** The value of `format`. A file without it is not one of these. */
export const GLADE_FORMAT = 'meadow.glade'

/** Bumped when the shape changes in a way an older importer cannot read. */
export const GLADE_VERSION = 1

export const GLADE_EXTENSION = '.meadow.json'
export const GLADE_MEDIA_TYPE = 'application/vnd.meadow.glade+json'

/**
 * The most objects one file may hold.
 *
 * Ten times the 5k the renderer is measured at. Past it a file is a mistake or an
 * attack, and refusing it up front is better than a tab that stops responding halfway
 * through building the document.
 */
export const GLADE_MAX_OBJECTS = 50_000

/** The largest file the app will read, in bytes. */
export const GLADE_MAX_BYTES = 64 * 1024 * 1024

// --- rich text ------------------------------------------------------------------
//
// The same JSON `fragmentToNodes` writes in apps/web/src/doc/richText.ts: node names as
// ProseMirror stores them and each text run as the delta Yjs reports. Declared here so
// the file format is described in one package, including to a JSON Schema reader.

export const gladeRichRun = z.object({
  insert: z.string(),
  attributes: z.record(z.unknown()).optional(),
})

export type GladeRichRun = z.infer<typeof gladeRichRun>

export type GladeRichNode =
  | { text: GladeRichRun[] }
  | { name: string; attributes?: Record<string, string>; children: GladeRichNode[] }

export const gladeRichNode: z.ZodType<GladeRichNode> = z.lazy(() =>
  z.union([
    z.object({ text: z.array(gladeRichRun) }),
    z.object({
      name: z.string().min(1),
      attributes: z.record(z.string()).optional(),
      children: z.array(gladeRichNode),
    }),
  ]),
)

// --- meta -----------------------------------------------------------------------
//
// `meta` holds plain values and shared types side by side: `pagePaper` is a string,
// `pages` is a Y.Array of Y.Maps. JSON cannot tell a Y.Map from an object, and reading
// one back as the other would change how concurrent edits to it merge, so shared types
// are written tagged. Plain values are written as themselves.

export type GladeJson =
  | null
  | boolean
  | number
  | string
  | GladeJson[]
  | { [key: string]: GladeJson }

const gladeJson: z.ZodType<GladeJson> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(gladeJson),
    // An object carrying the tag key is a shared type that failed its own validation.
    // Accepting it as a plain object would import a Y.Map as a dictionary nobody can
    // merge, so it is refused and the key is dropped instead.
    z.record(gladeJson).refine((value) => !('$y' in value), 'malformed shared type'),
  ]),
)

export type GladeMetaValue =
  | { $y: 'map'; value: Record<string, GladeMetaValue> }
  | { $y: 'array'; value: GladeMetaValue[] }
  | { $y: 'text'; value: GladeRichRun[] }
  | { $y: 'xml'; value: GladeRichNode[] }
  | GladeJson

export const gladeMetaValue: z.ZodType<GladeMetaValue> = z.lazy(() =>
  z.union([
    z.object({ $y: z.literal('map'), value: z.record(gladeMetaValue) }),
    z.object({ $y: z.literal('array'), value: z.array(gladeMetaValue) }),
    z.object({ $y: z.literal('text'), value: z.array(gladeRichRun) }),
    z.object({ $y: z.literal('xml'), value: z.array(gladeRichNode) }),
    gladeJson,
  ]),
)

// --- the file -------------------------------------------------------------------

/**
 * One object: its fields, flattened, plus its text.
 *
 * `text` is null for an object with no fragment and an array for one that has a
 * fragment, even an empty one. The two are different documents - a shape drawn before
 * shapes could be labelled has no fragment at all - and keeping them apart is part of
 * the round trip being exact.
 */
export type GladeObject = ObjectData & { text: GladeRichNode[] | null }

export const gladeBoard = z.object({
  title: z.string().default(''),
  kind: z.string().default('glade'),
})

export type GladeBoard = z.infer<typeof gladeBoard>

/**
 * The file as it is written, for a JSON Schema reader and for the export side.
 *
 * Import does not parse with this in one go: see `parseGladeFile`, which validates entry
 * by entry so one bad object costs that object and not the whole board.
 */
export const gladeFile = z.object({
  format: z.literal(GLADE_FORMAT),
  version: z.literal(GLADE_VERSION),
  exportedAt: z.string(),
  app: z.string(),
  board: gladeBoard,
  meta: z.record(gladeMetaValue),
  order: z.array(z.string()),
  objects: z.array(objectData.extend({ text: z.array(gladeRichNode).nullable() })),
  bindings: z.array(bindingData),
  // Reserved for images, which are in the type list and not yet built. An asset will be
  // keyed by id and carry its media type, a digest, and either its bytes or a URL.
  assets: z.record(z.unknown()),
})

export type GladeFile = {
  format: typeof GLADE_FORMAT
  version: typeof GLADE_VERSION
  exportedAt: string
  app: string
  board: GladeBoard
  meta: Record<string, GladeMetaValue>
  order: string[]
  objects: GladeObject[]
  bindings: BindingData[]
  assets: Record<string, unknown>
}

/** What validation had to leave out or repair. All zero for a file this app wrote. */
export type GladeReport = {
  droppedObjects: number
  droppedBindings: number
  droppedMeta: number
  /** Bindings kept as free ends because the object they pointed at was dropped. */
  freedBindings: number
  /** Ids added to or removed from `order` so it lists every object exactly once. */
  repairedOrder: number
}

export type GladeParse =
  | { ok: true; file: GladeFile; report: GladeReport }
  | { ok: false; error: string }

function refuse(error: string): GladeParse {
  return { ok: false, error }
}

/**
 * Read a file, validating it entry by entry.
 *
 * Refuses outright only what cannot be imported in any useful form: not JSON, not this
 * format, a version this build does not know, or more objects than the limit. Anything
 * narrower is dropped, repaired and counted.
 */
export function parseGladeFile(raw: string | unknown): GladeParse {
  let parsed: unknown = raw
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw)
    } catch {
      return refuse('This file is not valid JSON.')
    }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refuse('This file is not a Meadow glade.')
  }
  const input = parsed as Record<string, unknown>
  if (input.format !== GLADE_FORMAT) return refuse('This file is not a Meadow glade.')
  if (input.version !== GLADE_VERSION) {
    return refuse(
      `This glade was written in format version ${String(input.version)}, which this version of Meadow cannot read.`,
    )
  }

  const rawObjects = Array.isArray(input.objects) ? input.objects : []
  if (rawObjects.length > GLADE_MAX_OBJECTS) {
    return refuse(
      `This glade has ${rawObjects.length} objects, more than the ${GLADE_MAX_OBJECTS} one import may hold.`,
    )
  }

  const report: GladeReport = {
    droppedObjects: 0,
    droppedBindings: 0,
    droppedMeta: 0,
    freedBindings: 0,
    repairedOrder: 0,
  }

  const objects: GladeObject[] = []
  const known = new Set<string>()
  for (const entry of rawObjects) {
    if (typeof entry !== 'object' || entry === null) {
      report.droppedObjects++
      continue
    }
    const { text: rawText, ...fields } = entry as Record<string, unknown>
    const object = objectData.safeParse(fields)
    const text =
      rawText === null || rawText === undefined
        ? ({ success: true, data: null } as const)
        : z.array(gladeRichNode).safeParse(rawText)
    // A repeated id would overwrite the first object with the second in the map while
    // listing both in `order`. The first one wins, as it would have in the document.
    if (!object.success || !text.success || known.has(object.data.id)) {
      report.droppedObjects++
      continue
    }
    known.add(object.data.id)
    objects.push({ ...object.data, text: text.data })
  }

  const bindings: BindingData[] = []
  const bindingIds = new Set<string>()
  for (const entry of Array.isArray(input.bindings) ? input.bindings : []) {
    const binding = bindingData.safeParse(entry)
    if (!binding.success || bindingIds.has(binding.data.id) || !known.has(binding.data.arrowId)) {
      report.droppedBindings++
      continue
    }
    bindingIds.add(binding.data.id)
    // ARCHITECTURE 4: a binding to an object that is not there is a free end, which is
    // what it would have become had the target been deleted in the document.
    if (binding.data.targetId !== null && !known.has(binding.data.targetId)) {
      report.freedBindings++
      bindings.push({ ...binding.data, targetId: null })
      continue
    }
    bindings.push(binding.data)
  }

  // The same repair as `reconcileOrder`: every object exactly once, the listed ones in
  // the order they were listed, anything unlisted on top.
  const rawOrder = Array.isArray(input.order) ? input.order : []
  const order: string[] = []
  const seen = new Set<string>()
  for (const id of rawOrder) {
    if (typeof id === 'string' && known.has(id) && !seen.has(id)) {
      seen.add(id)
      order.push(id)
    } else {
      report.repairedOrder++
    }
  }
  for (const object of objects) {
    if (seen.has(object.id)) continue
    order.push(object.id)
    report.repairedOrder++
  }

  const meta: Record<string, GladeMetaValue> = {}
  const rawMeta = input.meta
  if (typeof rawMeta === 'object' && rawMeta !== null && !Array.isArray(rawMeta)) {
    for (const [key, value] of Object.entries(rawMeta)) {
      const checked = gladeMetaValue.safeParse(value)
      if (checked.success) meta[key] = checked.data
      else report.droppedMeta++
    }
  }

  const board = gladeBoard.safeParse(input.board ?? {})
  const assets =
    typeof input.assets === 'object' && input.assets !== null && !Array.isArray(input.assets)
      ? (input.assets as Record<string, unknown>)
      : {}

  return {
    ok: true,
    file: {
      format: GLADE_FORMAT,
      version: GLADE_VERSION,
      exportedAt: typeof input.exportedAt === 'string' ? input.exportedAt : '',
      app: typeof input.app === 'string' ? input.app : '',
      board: board.success ? board.data : { title: '', kind: 'glade' },
      meta,
      order,
      objects,
      bindings,
      assets,
    },
    report,
  }
}

/** Whether a report has anything in it worth telling somebody about. */
export function gladeReportIsClean(report: GladeReport): boolean {
  return (
    report.droppedObjects === 0 &&
    report.droppedBindings === 0 &&
    report.droppedMeta === 0 &&
    report.freedBindings === 0 &&
    report.repairedOrder === 0
  )
}
