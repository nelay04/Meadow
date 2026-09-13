import { describe, expect, it } from 'vitest'

import { textToRich } from '../src/text'

describe('textToRich', () => {
  it('turns lines into paragraphs', () => {
    expect(textToRich('one\ntwo')).toEqual([
      { name: 'paragraph', children: [{ text: [{ insert: 'one' }] }] },
      { name: 'paragraph', children: [{ text: [{ insert: 'two' }] }] },
    ])
  })

  it('reads inline marks as the attributes TipTap stores', () => {
    const [paragraph] = textToRich('a **b** *c* ~~d~~ `e`')
    expect(paragraph).toEqual({
      name: 'paragraph',
      children: [
        {
          text: [
            { insert: 'a ' },
            { insert: 'b', attributes: { bold: {} } },
            { insert: ' ' },
            { insert: 'c', attributes: { italic: {} } },
            { insert: ' ' },
            { insert: 'd', attributes: { strike: {} } },
            { insert: ' ' },
            { insert: 'e', attributes: { code: {} } },
          ],
        },
      ],
    })
  })

  it('groups bullets into a list and reads headings', () => {
    const nodes = textToRich('## Plan\n- one\n- two\nafter')
    expect(nodes.map((node) => ('name' in node ? node.name : 'text'))).toEqual(['heading', 'bulletList', 'paragraph'])
  })

  it('keeps every character when markdown is off, and drops a trailing newline', () => {
    expect(textToRich('**x**\n', false)).toEqual([
      { name: 'paragraph', children: [{ text: [{ insert: '**x**' }] }] },
      { name: 'paragraph', children: [] },
    ])
    expect(textToRich('x\n')).toHaveLength(1)
  })
})
