/**
 * Tests for what a paste onto ruled paper turns into.
 *
 * Every block that reaches a lea row is a rule of paper, so a clipboard that wraps one
 * line in extra blocks opens blank lines nobody typed. These pin the flattening down
 * without a browser: the schema is the editor's own, the slices are built by hand.
 */

import { getSchema } from '@tiptap/core'
import { Fragment, Slice } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import { describe, expect, it } from 'vitest'

import { linesForRules } from './textEditor'

const schema = getSchema([StarterKit])
const { paragraph, heading, bulletList, listItem, codeBlock, hardBreak } = schema.nodes
const p = (text = '') => paragraph.create(null, text === '' ? null : schema.text(text))
const slice = (...nodes: Parameters<typeof Fragment.fromArray>[0]) =>
  new Slice(Fragment.fromArray(nodes), 1, 1)
const lines = (result: Slice) => {
  const out: string[] = []
  result.content.forEach((node) => {
    expect(node.type).toBe(paragraph)
    out.push(node.textContent)
  })
  return out
}

describe('linesForRules', () => {
  it('drops the empty blocks a copied line arrives with', () => {
    expect(lines(linesForRules(slice(p('Pasted'), p()), schema))).toEqual(['Pasted'])
    expect(lines(linesForRules(slice(p(), p(), p('Pasted'), p()), schema))).toEqual(['Pasted'])
  })

  it('keeps blank lines between lines of writing', () => {
    expect(lines(linesForRules(slice(p('A'), p(), p('B')), schema))).toEqual(['A', '', 'B'])
  })

  it('is open at both ends, so one line joins the line the caret is on', () => {
    const result = linesForRules(slice(p('Pasted')), schema)
    expect(result.openStart).toBe(1)
    expect(result.openEnd).toBe(1)
  })

  it('pastes nothing for a clipboard of blank lines', () => {
    expect(linesForRules(slice(p(), p()), schema).size).toBe(0)
  })

  it('turns headings, list items and code into plain lines', () => {
    const list = bulletList.create(null, [
      listItem.create(null, p('one')),
      listItem.create(null, p('two')),
    ])
    const code = codeBlock.create(null, schema.text('x = 1\ny = 2'))
    const result = linesForRules(
      slice(heading.create({ level: 1 }, schema.text('Title')), list, code),
      schema,
    )
    expect(lines(result)).toEqual(['Title', 'one', 'two', 'x = 1', 'y = 2'])
  })

  it('keeps marks and wraps loose inline content in a line', () => {
    const bold = schema.text('bold', [schema.marks.bold.create()])
    const result = linesForRules(new Slice(Fragment.from(bold), 0, 0), schema)
    expect(lines(result)).toEqual(['bold'])
    expect(result.content.firstChild?.firstChild?.marks[0]?.type).toBe(schema.marks.bold)
  })

  it('leaves a hard break inside its line', () => {
    const line = paragraph.create(null, [schema.text('a'), hardBreak.create(), schema.text('b')])
    expect(linesForRules(slice(line), schema).content.childCount).toBe(1)
  })
})
