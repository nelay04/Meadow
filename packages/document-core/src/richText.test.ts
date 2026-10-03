/**
 * Tests for the static rendering of a `Y.XmlFragment`.
 *
 * This is the read path for every idle text object on a board, and it is also a
 * security boundary: the server never inspects CRDT payloads, so whatever a peer puts
 * in a fragment arrives here and is handed to `innerHTML`. Escaping is tested for that
 * reason rather than for tidiness.
 *
 * The DOM-dependent half of the text stack, measurement and the overlay itself, is
 * covered by scripts/overlay-smoke.mjs against a real browser. Faking layout in jsdom
 * would test the fake.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import {
  escapeHtml,
  fragmentIsEmpty,
  fragmentToHtml,
  fragmentToPlainText,
  setFragmentPlainText,
} from './richText'

function fragment(): Y.XmlFragment {
  return new Y.Doc().getXmlFragment('text')
}

/** Build `<name>children</name>` the way y-prosemirror stores a ProseMirror node. */
function element(name: string, children: (Y.XmlElement | Y.XmlText)[]): Y.XmlElement {
  const node = new Y.XmlElement(name)
  if (children.length > 0) node.insert(0, children)
  return node
}

describe('fragmentToHtml', () => {
  it('maps ProseMirror node names to HTML tags', () => {
    const root = fragment()
    root.insert(0, [element('paragraph', [new Y.XmlText('hello')])])

    expect(fragmentToHtml(root)).toBe('<p>hello</p>')
  })

  it('renders lists as nested tags rather than flattening them', () => {
    const root = fragment()
    root.insert(0, [
      element('bulletList', [
        element('listItem', [element('paragraph', [new Y.XmlText('one')])]),
        element('listItem', [element('paragraph', [new Y.XmlText('two')])]),
      ]),
    ])

    expect(fragmentToHtml(root)).toBe('<ul><li><p>one</p></li><li><p>two</p></li></ul>')
  })

  it('escapes text so a peer cannot inject markup through the document', () => {
    const root = fragment()
    root.insert(0, [
      element('paragraph', [new Y.XmlText('<img src=x onerror="alert(1)"> & "quoted"')]),
    ])

    const html = fragmentToHtml(root)
    // The word `onerror` survives as literal text, which is the point: it is content,
    // not an attribute. What must not survive is the angle bracket that would make it
    // one.
    expect(html).not.toContain('<img')
    expect(html).toBe(
      '<p>&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &quot;quoted&quot;</p>',
    )
  })

  it('clamps a heading level, since it arrives from another client unchecked', () => {
    const root = fragment()
    const heading = element('heading', [new Y.XmlText('title')])
    heading.setAttribute('level', '9' as unknown as string)
    root.insert(0, [heading])

    expect(fragmentToHtml(root)).toBe('<h3>title</h3>')
  })

  it('does not build a tag name out of a hostile heading level', () => {
    const root = fragment()
    const heading = element('heading', [new Y.XmlText('x')])
    heading.setAttribute('level', 'script onload=alert(1)' as unknown as string)
    root.insert(0, [heading])

    // A non-numeric level falls back rather than producing `<hscript onload=...>`.
    expect(fragmentToHtml(root)).toBe('<h3>x</h3>')
  })

  it('wraps marks in a fixed order, so identical content produces identical HTML', () => {
    const doc = new Y.Doc()
    const root = doc.getXmlFragment('text')
    const text = new Y.XmlText()
    root.insert(0, [element('paragraph', [text])])
    text.insert(0, 'bold and italic')
    text.format(0, 4, { italic: {}, bold: {} })

    expect(fragmentToHtml(root)).toBe('<p><strong><em>bold</em></strong> and italic</p>')
  })

  it('renders an unknown node type as a div rather than dropping it', () => {
    const root = fragment()
    root.insert(0, [element('someFutureBlock', [new Y.XmlText('still here')])])

    expect(fragmentToHtml(root)).toBe('<div>still here</div>')
  })

  it('is empty for an empty fragment', () => {
    expect(fragmentToHtml(fragment())).toBe('')
  })
})

describe('fragmentToPlainText', () => {
  it('puts one line per block and none between list items', () => {
    const root = fragment()
    root.insert(0, [
      element('paragraph', [new Y.XmlText('intro')]),
      element('bulletList', [
        element('listItem', [element('paragraph', [new Y.XmlText('one')])]),
        element('listItem', [element('paragraph', [new Y.XmlText('two')])]),
      ]),
    ])

    expect(fragmentToPlainText(root)).toBe('intro\none\ntwo')
  })

  it('treats a hard break as a line break', () => {
    const root = fragment()
    root.insert(0, [
      element('paragraph', [new Y.XmlText('a'), element('hardBreak', []), new Y.XmlText('b')]),
    ])

    expect(fragmentToPlainText(root)).toBe('a\nb')
  })

  it('keeps interior blank lines, which the user typed', () => {
    const root = fragment()
    setFragmentPlainText(root, 'one\n\ntwo')

    expect(fragmentToPlainText(root)).toBe('one\n\ntwo')
  })
})

describe('setFragmentPlainText', () => {
  it('round-trips through the serialiser', () => {
    const root = fragment()
    setFragmentPlainText(root, 'first line\nsecond line')

    expect(fragmentToHtml(root)).toBe('<p>first line</p><p>second line</p>')
    expect(fragmentToPlainText(root)).toBe('first line\nsecond line')
  })

  it('replaces rather than appends, so seeding twice does not duplicate', () => {
    const root = fragment()
    setFragmentPlainText(root, 'one')
    setFragmentPlainText(root, 'two')

    expect(fragmentToPlainText(root)).toBe('two')
  })

  it('wraps every line in a block, since a bare text node breaks ProseMirror on mount', () => {
    const root = fragment()
    setFragmentPlainText(root, 'a\nb')

    for (const node of root.toArray()) {
      expect(node).toBeInstanceOf(Y.XmlElement)
      expect((node as Y.XmlElement).nodeName).toBe('paragraph')
    }
  })

  it('produces an empty fragment for an empty string', () => {
    const root = fragment()
    setFragmentPlainText(root, '')

    expect(fragmentIsEmpty(root)).toBe(true)
    expect(fragmentToHtml(root)).toBe('<p></p>')
  })
})

describe('escapeHtml', () => {
  it('covers the four characters that change parsing', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;')
  })
})
