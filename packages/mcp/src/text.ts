/**
 * Text in and out of a glade object, for a model.
 *
 * Out is plain text (see `richTextToPlain` in the schema). In is a small, forgiving
 * slice of Markdown, because that is what a model writes when asked for formatted text:
 * paragraphs, `#` headings, `-` bullets, and **bold**, *italic*, ~~strike~~ and `code`
 * inline. Anything else arrives as the characters it is, which is never wrong, only
 * plainer than meant.
 *
 * The output is the shape `setFragmentNodes` builds from, which is ProseMirror's own
 * document: node names as TipTap stores them, marks as run attributes.
 */

import type { GladeRichNode, GladeRichRun } from '@meadow/schema'

const INLINE = /(\*\*[^*]+\*\*|__[^_]+__|\*[^*\s][^*]*\*|_[^_\s][^_]*_|~~[^~]+~~|`[^`]+`)/

function runs(line: string): GladeRichRun[] {
  const out: GladeRichRun[] = []
  for (const part of line.split(INLINE)) {
    if (part === '') continue
    const mark = (name: string, inner: string): void => {
      out.push({ insert: inner, attributes: { [name]: {} } })
    }
    if (
      (part.startsWith('**') && part.endsWith('**')) ||
      (part.startsWith('__') && part.endsWith('__'))
    ) {
      if (part.length > 4) mark('bold', part.slice(2, -2))
      else out.push({ insert: part })
    } else if (part.startsWith('~~') && part.endsWith('~~') && part.length > 4) {
      mark('strike', part.slice(2, -2))
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      mark('code', part.slice(1, -1))
    } else if (
      part.length > 2 &&
      ((part.startsWith('*') && part.endsWith('*')) || (part.startsWith('_') && part.endsWith('_')))
    ) {
      mark('italic', part.slice(1, -1))
    } else {
      out.push({ insert: part })
    }
  }
  return out
}

const paragraph = (line: string): GladeRichNode => ({
  name: 'paragraph',
  children: line === '' ? [] : [{ text: runs(line) }],
})

/** Markdown-ish text to rich nodes. `markdown: false` keeps every character literal. */
export function textToRich(value: string, markdown = true): GladeRichNode[] {
  const lines = value.replace(/\r\n?/g, '\n').split('\n')
  if (!markdown) {
    return lines.map((line) => ({
      name: 'paragraph',
      children: line === '' ? [] : [{ text: [{ insert: line }] }],
    }))
  }

  const nodes: GladeRichNode[] = []
  let bullets: GladeRichNode[] | null = null
  for (const line of lines) {
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line)
    if (bullet !== null) {
      bullets ??= []
      bullets.push({ name: 'listItem', children: [paragraph(bullet[1])] })
      continue
    }
    if (bullets !== null) {
      nodes.push({ name: 'bulletList', children: bullets })
      bullets = null
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading !== null) {
      nodes.push({
        name: 'heading',
        attributes: { level: String(heading[1].length) },
        children: [{ text: runs(heading[2]) }],
      })
      continue
    }
    nodes.push(paragraph(line))
  }
  if (bullets !== null) nodes.push({ name: 'bulletList', children: bullets })
  // A trailing blank line is the model's newline, not a paragraph somebody wanted.
  while (nodes.length > 1) {
    const last = nodes[nodes.length - 1]
    if ('name' in last && last.name === 'paragraph' && last.children.length === 0) nodes.pop()
    else break
  }
  return nodes
}
