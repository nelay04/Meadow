/**
 * Rendering a `Y.XmlFragment` as static HTML, and seeding one without an editor.
 *
 * ARCHITECTURE 5 gives text objects three states: idle static HTML, an active TipTap
 * instance, then back to static HTML. This file owns the first and third. It exists
 * so the idle path costs nothing: a board with 200 text objects on screen must not
 * hold 200 ProseMirror instances, and mounting one only to read its rendered output
 * would be exactly that.
 *
 * The node names below are ProseMirror's, not HTML's. `y-prosemirror` stores each
 * ProseMirror node as a `Y.XmlElement` whose `nodeName` is the node type, so a
 * paragraph is literally `<paragraph>` in the CRDT. Mapping is this module's job.
 * Anything unrecognised falls through to a `<div>` rather than being dropped, because
 * a future node type should degrade to visible text and not to a silently blank
 * object.
 */

import * as Y from 'yjs'

/** ProseMirror node name to HTML tag. Keep in step with the TipTap extension list. */
const BLOCK_TAGS: Record<string, string> = {
  paragraph: 'p',
  heading: 'h3',
  bulletList: 'ul',
  orderedList: 'ol',
  listItem: 'li',
  codeBlock: 'pre',
  blockquote: 'blockquote',
  hardBreak: 'br',
}

/**
 * The inline marks a user can apply, and the tag each serialises to.
 *
 * This table is the authority, not the editor's extension list. A mark the editor can
 * produce and this cannot render would look fine while being typed and vanish the
 * moment the editor closed, so the formatting bar is built from these names and the
 * editor is configured to offer exactly them.
 *
 * `code` is serialisable but not offered in the bar: it is a block-level idea people
 * reach for through a menu, not a thing to spend a button on beside bold and italic.
 */
export const MARK_TAGS = {
  bold: 'strong',
  italic: 'em',
  underline: 'u',
  strike: 's',
  code: 'code',
} as const

export type MarkName = keyof typeof MARK_TAGS

/** The subset with a button, in the order they appear in the bar. */
export const TEXT_MARKS = ['bold', 'italic', 'underline', 'strike'] as const
export type TextMark = (typeof TEXT_MARKS)[number]

const VOID_TAGS = new Set(['br'])

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function markTagsFor(attributes: Record<string, unknown> | undefined): string[] {
  if (attributes === undefined) return []
  const tags: string[] = []
  // Fixed order rather than key order, so the same marks always produce the same
  // HTML. Otherwise an incidental attribute reordering looks like a content change
  // and invalidates the render cache for no reason.
  for (const [mark, tag] of Object.entries(MARK_TAGS)) {
    if (attributes[mark] !== undefined && attributes[mark] !== null) tags.push(tag)
  }
  return tags
}

function textToHtml(text: Y.XmlText): string {
  let html = ''

  for (const run of text.toDelta() as { insert?: unknown; attributes?: Record<string, unknown> }[]) {
    if (typeof run.insert !== 'string') continue

    const tags = markTagsFor(run.attributes)
    const open = tags.map((tag) => `<${tag}>`).join('')
    const close = tags
      .slice()
      .reverse()
      .map((tag) => `</${tag}>`)
      .join('')

    html += `${open}${escapeHtml(run.insert)}${close}`
  }

  return html
}

function elementToHtml(element: Y.XmlElement): string {
  const name = element.nodeName
  let tag = BLOCK_TAGS[name] ?? 'div'

  // Headings carry their level as an attribute. Clamp rather than trust it: the value
  // arrives straight from a peer's document, and `h${level}` with an arbitrary string
  // in it is how a tag name turns into markup injection.
  if (name === 'heading') {
    const level = Number(element.getAttribute('level') ?? 3)
    tag = `h${Number.isFinite(level) ? Math.min(3, Math.max(1, Math.round(level))) : 3}`
  }

  if (VOID_TAGS.has(tag)) return `<${tag}>`
  return `<${tag}>${nodesToHtml(element.toArray())}</${tag}>`
}

function nodesToHtml(nodes: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): string {
  let html = ''
  for (const node of nodes) {
    if (node instanceof Y.XmlText) html += textToHtml(node)
    else if (node instanceof Y.XmlElement) html += elementToHtml(node)
  }
  return html
}

/**
 * Static HTML for an idle text object.
 *
 * The output is assigned with `innerHTML`, so every value that came from the document
 * is escaped on the way through. A peer can write any string it likes into a
 * `Y.XmlText`; the server never inspects CRDT payloads, so this is the boundary.
 */
export function fragmentToHtml(fragment: Y.XmlFragment): string {
  return nodesToHtml(fragment.toArray())
}

/**
 * Blocks that end a line. Containers such as `bulletList` are not here: a list ends
 * one line per `listItem`, not one for the list and another for each item, and getting
 * that wrong shows up as blank lines between every bullet.
 */
const LINE_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote'])

/** Plain text, for measurement fallbacks, emptiness checks, search, and export. */
export function fragmentToPlainText(fragment: Y.XmlFragment): string {
  const lines: string[] = []
  let current = ''

  const flush = (): void => {
    lines.push(current)
    current = ''
  }

  const walk = (node: Y.XmlElement | Y.XmlText | Y.XmlHook): void => {
    if (node instanceof Y.XmlText) {
      current += node.toString()
      return
    }
    if (!(node instanceof Y.XmlElement)) return

    if (node.nodeName === 'hardBreak') {
      flush()
      return
    }

    for (const child of node.toArray()) walk(child)
    if (LINE_BLOCKS.has(node.nodeName)) flush()
  }

  for (const node of fragment.toArray()) walk(node)
  if (current !== '') flush()

  // Trim only blank leading and trailing lines. Interior blank lines are content the
  // user typed, and indentation inside a line is too.
  return lines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '')
}

export function fragmentIsEmpty(fragment: Y.XmlFragment): boolean {
  return fragmentToPlainText(fragment) === ''
}

/**
 * Put plain text into a fragment, as one paragraph per line.
 *
 * Used to seed a new object and by tests and the dev harness, which have no editor.
 * The shape produced has to be what ProseMirror expects, because the next thing to
 * touch this fragment may well be a real TipTap instance: a bare `Y.XmlText` at the
 * top level with no block wrapper makes `y-prosemirror` throw on mount.
 *
 * Caller wraps this in a transaction, like every other document write.
 */
export function setFragmentPlainText(fragment: Y.XmlFragment, value: string): void {
  if (fragment.length > 0) fragment.delete(0, fragment.length)

  const paragraphs = value.split('\n').map((line) => {
    const element = new Y.XmlElement('paragraph')
    if (line !== '') element.insert(0, [new Y.XmlText(line)])
    return element
  })

  fragment.insert(0, paragraphs)
}

/**
 * A fragment's content as plain JSON, for copying text between objects.
 *
 * Deliberately not HTML. The static HTML above is for display and is lossy on the way
 * back - a heading's level survives as a tag name, a mark this file does not know
 * about does not survive at all - and reading it back would mean a parser that has to
 * agree with the serialiser forever. This is the CRDT's own shape written out: node
 * names as ProseMirror stores them, attributes as they are, and a `Y.XmlText` as the
 * delta it already reports. Anything TipTap can produce round-trips, including nodes
 * added after this was written.
 */
export type RichRun = { insert: string; attributes?: Record<string, unknown> }

export type RichNode =
  | { text: RichRun[] }
  | { name: string; attributes?: Record<string, string>; children: RichNode[] }

function nodeSnapshot(node: Y.XmlElement | Y.XmlText | Y.XmlHook): RichNode | null {
  if (node instanceof Y.XmlText) {
    const runs: RichRun[] = []
    for (const run of node.toDelta() as RichRun[]) {
      if (typeof run.insert !== 'string') continue
      runs.push(run.attributes === undefined ? { insert: run.insert } : run)
    }
    return { text: runs }
  }
  if (!(node instanceof Y.XmlElement)) return null

  const attributes = node.getAttributes() as Record<string, string>
  return {
    name: node.nodeName,
    // Omitted when empty rather than written as `{}`, because this goes on the
    // clipboard as JSON and a paragraph is the overwhelmingly common node.
    ...(Object.keys(attributes).length > 0 ? { attributes } : {}),
    children: nodesSnapshot(node.toArray()),
  }
}

function nodesSnapshot(nodes: readonly (Y.XmlElement | Y.XmlText | Y.XmlHook)[]): RichNode[] {
  const out: RichNode[] = []
  for (const node of nodes) {
    const snapshot = nodeSnapshot(node)
    if (snapshot !== null) out.push(snapshot)
  }
  return out
}

/** Read a fragment out as JSON. A pure read: nothing is written and nothing is held. */
export function fragmentToNodes(fragment: Y.XmlFragment): RichNode[] {
  return nodesSnapshot(fragment.toArray())
}

function buildNode(node: RichNode): Y.XmlElement | Y.XmlText | null {
  if ('text' in node) {
    const text = new Y.XmlText()
    // Built before integration, which Yjs queues and replays when the tree is
    // inserted. Filling the nodes after insertion instead would emit one update per
    // node and put a half-built paragraph on the wire.
    if (node.text.length > 0) text.applyDelta(node.text)
    return text
  }
  if (typeof node.name !== 'string' || node.name === '') return null

  const element = new Y.XmlElement(node.name)
  for (const [key, value] of Object.entries(node.attributes ?? {})) {
    if (typeof value === 'string') element.setAttribute(key, value)
  }
  const children = buildNodes(node.children ?? [])
  if (children.length > 0) element.insert(0, children)
  return element
}

function buildNodes(nodes: readonly RichNode[]): (Y.XmlElement | Y.XmlText)[] {
  const out: (Y.XmlElement | Y.XmlText)[] = []
  for (const node of nodes) {
    if (node === null || typeof node !== 'object') continue
    const built = buildNode(node)
    if (built !== null) out.push(built)
  }
  return out
}

/**
 * Replace a fragment's content with a snapshot taken by `fragmentToNodes`.
 *
 * The same contract as `setFragmentPlainText`: the caller wraps it in a transaction,
 * and what lands has to be something `y-prosemirror` can mount. A snapshot whose top
 * level is bare text would break that, so it is wrapped in a paragraph rather than
 * inserted as it stands - the source of a snapshot is a clipboard, which is to say a
 * string a peer or another build wrote.
 */
export function setFragmentNodes(fragment: Y.XmlFragment, nodes: readonly RichNode[]): void {
  if (fragment.length > 0) fragment.delete(0, fragment.length)

  const built = buildNodes(nodes).map((node) => {
    if (!(node instanceof Y.XmlText)) return node
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.insert(0, [node])
    return paragraph
  })

  if (built.length > 0) fragment.insert(0, built)
}
