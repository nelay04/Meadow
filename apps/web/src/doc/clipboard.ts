/**
 * The clipboard, between the engine and the system.
 *
 * Two stores, because neither one alone is enough.
 *
 * The system clipboard is the one that matters: it is what makes copy in one glade and
 * paste in another - or in a second tab, or after a reload - work at all, and it is
 * where the browser expects this to live. Objects go on it as JSON under a custom
 * type, with the copied text in `text/plain` beside them so that pasting a sticky into
 * a mail still gives somebody the words instead of a wall of coordinates.
 *
 * The held snapshot is the fallback. Not every browser preserves a custom clipboard
 * type - Safari sanitises the DataTransfer down to the types it knows - and a copy
 * that comes from a button rather than a keystroke has no ClipboardEvent to write to
 * in the first place. Holding the last copy in memory means those cases still paste
 * within the session, which is where nearly all copying happens.
 *
 * Everything read back is validated. The string on the clipboard was last written by
 * some other build of this app, or by another program entirely, or by hand.
 */

import { bindingData, objectData } from '@meadow/schema'

import type { DocSnapshot, ObjectSnapshot } from './mutations'

/**
 * The DataTransfer type objects travel under.
 *
 * A type of our own rather than JSON in `text/plain`, so that pasting into anything
 * else gets the text and not the payload. The cost is that a browser which drops
 * unknown types drops this too, which is what the held snapshot is for.
 */
export const CLIPBOARD_TYPE = 'application/x-meadow-objects'

/** Bumped when the payload's shape changes in a way an older build cannot read. */
const CLIPBOARD_VERSION = 1

type ClipboardPayload = {
  meadow: number
  objects: ObjectSnapshot[]
  bindings: unknown[]
}

export function encodeSnapshot(snapshot: DocSnapshot): string {
  const payload: ClipboardPayload = {
    meadow: CLIPBOARD_VERSION,
    objects: [...snapshot.objects],
    bindings: [...snapshot.bindings],
  }
  return JSON.stringify(payload)
}

/**
 * Parse a payload, or return null for anything that is not one.
 *
 * Field by field through the schemas the document itself is written with, so a payload
 * from a build with an extra field, or with a nonsense one, cannot put an object into
 * the document that `readObject` would then choke on. An entry that fails is dropped
 * rather than failing the paste: three shapes out of four is a better answer than
 * nothing happening and no explanation.
 */
export function decodeSnapshot(raw: string): DocSnapshot | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (typeof parsed !== 'object' || parsed === null) return null
  const payload = parsed as Partial<ClipboardPayload>
  if (payload.meadow !== CLIPBOARD_VERSION || !Array.isArray(payload.objects)) return null

  const objects: ObjectSnapshot[] = []
  for (const entry of payload.objects) {
    if (typeof entry !== 'object' || entry === null) continue
    const object = objectData.safeParse((entry as ObjectSnapshot).object)
    if (!object.success) continue
    const text = (entry as ObjectSnapshot).text
    objects.push({ object: object.data, text: Array.isArray(text) ? text : null })
  }
  if (objects.length === 0) return null

  const known = new Set(objects.map((entry) => entry.object.id))
  const bindings = []
  for (const entry of payload.bindings ?? []) {
    const binding = bindingData.safeParse(entry)
    // A binding whose arrow did not survive validation would be remapped to nothing
    // on the way in. Dropping it here keeps that decision in one place.
    if (binding.success && known.has(binding.data.arrowId)) bindings.push(binding.data)
  }

  return { objects, bindings }
}

/** The bounding box of a snapshot, or null when it is empty. */
export function snapshotBounds(
  snapshot: DocSnapshot,
): { x: number; y: number; w: number; h: number } | null {
  if (snapshot.objects.length === 0) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity

  for (const { object } of snapshot.objects) {
    // Normalised, because w or h may be negative: an arrow drawn right to left stores
    // its box that way, and a min of the raw corners would be the wrong corner.
    minX = Math.min(minX, object.x, object.x + object.w)
    minY = Math.min(minY, object.y, object.y + object.h)
    maxX = Math.max(maxX, object.x, object.x + object.w)
    maxY = Math.max(maxY, object.y, object.y + object.h)
  }

  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
}

/** The last copy this tab made. See the note above on why it is kept. */
let held: DocSnapshot | null = null

/**
 * Put a snapshot on the clipboard.
 *
 * `data` is the event's DataTransfer, or null for a copy that has no event behind it.
 * The held snapshot is set either way, so a button and a keystroke leave the app in
 * the same state.
 */
export function writeClipboard(
  data: DataTransfer | null,
  snapshot: DocSnapshot,
  plainText: string,
): void {
  held = snapshot
  if (data === null) return

  // Wrapped: a browser that refuses an unknown type throws rather than returning
  // false, and losing the whole copy over the interop half of it is the wrong trade.
  try {
    data.setData(CLIPBOARD_TYPE, encodeSnapshot(snapshot))
  } catch {
    // The held snapshot still covers this tab.
  }
  data.setData('text/plain', plainText)
}

/**
 * Read a snapshot for a paste, or null when the clipboard holds nothing of ours.
 *
 * The event's payload wins when there is one. Falling back to the held snapshot only
 * when there is not is what keeps a stale in-memory copy from beating something the
 * user copied a moment ago in another tab.
 */
export function readClipboard(data: DataTransfer | null): DocSnapshot | null {
  const raw = data?.getData(CLIPBOARD_TYPE) ?? ''
  if (raw !== '') return decodeSnapshot(raw)
  return held
}

/** Whether a paste would have anything to insert without a ClipboardEvent to read. */
export function hasHeldSnapshot(): boolean {
  return held !== null
}
