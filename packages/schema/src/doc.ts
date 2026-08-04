/**
 * The document roots. ARCHITECTURE 4.
 *
 *   objects   Y.Map<ObjectId, Y.Map>    flat, never nested
 *   bindings  Y.Map<BindingId, Y.Map>   arrow attachments
 *   order     Y.Array<ObjectId>         z-order, index = depth
 *   meta      Y.Map                     title, background, grid
 *
 * Root names are part of the wire format. A client using different ones sees an empty
 * document rather than an error, so they live here and nowhere else.
 */

import * as Y from 'yjs'

export const ROOT_OBJECTS = 'objects'
export const ROOT_BINDINGS = 'bindings'
export const ROOT_ORDER = 'order'
export const ROOT_META = 'meta'

export type DocRoots = {
  objects: Y.Map<Y.Map<unknown>>
  bindings: Y.Map<Y.Map<unknown>>
  order: Y.Array<string>
  meta: Y.Map<unknown>
}

/**
 * Resolve every root at once.
 *
 * Y.Doc.getMap is idempotent and creates on first access, so calling this early means
 * the roots exist before any observer attaches. Resolving a root lazily inside a
 * transaction has caught people out: the type is only fixed on first access, and
 * `getMap` after a peer already created it as an Array throws.
 */
export function docRoots(doc: Y.Doc): DocRoots {
  return {
    objects: doc.getMap<Y.Map<unknown>>(ROOT_OBJECTS),
    bindings: doc.getMap<Y.Map<unknown>>(ROOT_BINDINGS),
    order: doc.getArray<string>(ROOT_ORDER),
    meta: doc.getMap<unknown>(ROOT_META),
  }
}

/** nanoid-ish. Not cryptographic; it only has to not collide across peers. */
export function nanoid(size = 12): string {
  const alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict'
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}
