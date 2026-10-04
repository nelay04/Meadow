/**
 * The wording of the assistant activity panel, apart from the panel.
 *
 * Split out because this is the part with answers worth pinning down: a count that says
 * "1 objects", or a tool added later that reads as a blank, are the ways a list like
 * this goes quietly wrong. The panel itself is markup around these.
 */

import type { McpEvent } from '../../lib/api'

/**
 * The tool's name as a sentence about what happened.
 *
 * A model reads `create_nodes`; a person reads "added objects". The count comes from
 * the row rather than the name, because the same tool can touch one object or forty.
 */
export function describe(event: McpEvent): string {
  const n = event.accepted
  const things = `${n} ${n === 1 ? 'object' : 'objects'}`
  switch (event.tool) {
    case 'create_nodes':
      return `Added ${things}`
    case 'connect':
      return `Drew ${n === 1 ? 'an arrow' : `${n} arrows`}`
    case 'update_objects':
      return `Changed ${things}`
    case 'delete_objects':
      return `Removed ${things}`
    case 'set_text':
      return `Wrote on ${things}`
    case 'apply_diagram':
      return `Drew a diagram, ${things}`
    case 'tidy_layout':
      return `Tidied the layout, ${things}`
    case 'import_glade':
      return `Imported ${things}`
    case 'move_lea_page':
      return 'Moved a page'
    default:
      // A tool added later still reads as something rather than as nothing. The raw
      // name is a worse sentence than the ones above and a much better one than a gap.
      return `${event.tool.replace(/_/g, ' ')}, ${things}`
  }
}

/** "just now", "14 minutes ago", then the date once that stops being useful. */
export function when(iso: string): string {
  const then = new Date(iso)
  const seconds = Math.round((Date.now() - then.getTime()) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`
  return then.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** Milliseconds, as something a person reads. */
export function took(ms: number): string {
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`
}


/**
 * What a refused call was trying to do, as a phrase that follows "Refused to".
 *
 * Counted from `requested` rather than `accepted`, which is zero on a refusal: the
 * interesting part of a refused row is the size of what was turned away.
 */
export function asked(event: McpEvent): string {
  const n = event.requested
  const things = `${n} ${n === 1 ? 'object' : 'objects'}`
  switch (event.tool) {
    case 'create_nodes':
      return `add ${things}`
    case 'connect':
      return `draw ${n === 1 ? 'an arrow' : `${n} arrows`}`
    case 'update_objects':
      return `change ${things}`
    case 'delete_objects':
      return `remove ${things}`
    case 'set_text':
      return `write on ${things}`
    case 'apply_diagram':
      return 'draw a diagram'
    case 'tidy_layout':
      return 'tidy the layout'
    case 'import_glade':
      return `import ${things}`
    case 'move_lea_page':
      return 'move a page'
    default:
      return event.tool.replace(/_/g, ' ')
  }
}
