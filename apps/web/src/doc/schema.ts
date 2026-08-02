/**
 * The CRDT document shape, from ARCHITECTURE 4.
 *
 * A flat `objects` map keyed by id, with `parentId` pointers rather than a nested
 * tree. Reparenting - dragging a shape into a frame - is then one field write instead
 * of a delete-and-recreate that would drop a concurrent edit to the moved object.
 *
 * This mirrors what `packages/schema` will hold once M2 needs it in more than one
 * place. It is kept here until then rather than being a package with one consumer.
 */

export const OBJECTS_KEY = 'objects'

export type ObjectType = 'rect' | 'ellipse' | 'diamond' | 'sticky' | 'text'

export type CanvasObject = {
  id: string
  type: ObjectType
  x: number
  y: number
  w: number
  h: number
  rotation: number
  opacity: number
  locked: boolean
  parentId: string | null
}

export const OBJECT_TYPES: readonly ObjectType[] = [
  'rect',
  'ellipse',
  'diamond',
  'sticky',
  'text',
]

export function nanoid(size = 12): string {
  const alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict'
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}
