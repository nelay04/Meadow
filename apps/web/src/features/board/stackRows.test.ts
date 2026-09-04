/**
 * Tests for the stack list's two derivations.
 *
 * Both are where a panel of this shape goes wrong silently. `stackRows` inverts the
 * document's own index, so an off-by-one there prints the wrong depth on every row and
 * nothing throws. `dropTarget` is the drag's whole answer, and its failure mode is a
 * drop that lands one row short of where the insertion line was drawn - which reads as
 * a jumpy list rather than as a bug.
 */

import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import type { ObjectData } from '@meadow/schema'

import {
  addObject,
  createDocSession,
  readObjectById,
  setObjectText,
} from '../../doc/mutations'
import { type StackRow, dropTarget, stackRows } from './stackRows'

function seed(count: number) {
  const session = createDocSession(new Y.Doc(), 'owner')
  const ids = Array.from({ length: count }, () => addObject(session, { type: 'rect' }))
  const objects = ids.map((id) => readObjectById(session, id) as ObjectData)
  return { session, ids, objects }
}

/** Rows by id alone, which is all `dropTarget` reads. */
function rowsOf(ids: readonly string[]): StackRow[] {
  return ids.map((id, index) => ({
    id,
    type: 'rect' as const,
    z: ids.length - index,
    label: id,
    named: false,
    locked: false,
  }))
}

describe('stackRows', () => {
  it('reads front first and numbers depth from the back', () => {
    const { session, ids, objects } = seed(3)
    const rows = stackRows(session, objects)

    // `order` is [back, middle, front]; the list is the other way up.
    expect(rows.map((row) => row.id)).toEqual([ids[2], ids[1], ids[0]])
    expect(rows.map((row) => row.z)).toEqual([3, 2, 1])
  })

  it('names a row by its own words where it has any', () => {
    const { session, objects } = seed(1)
    setObjectText(session, objects[0].id, 'Login box')
    const rows = stackRows(session, [readObjectById(session, objects[0].id) as ObjectData])

    expect(rows[0].label).toBe('Login box')
    expect(rows[0].named).toBe(true)
  })

  it('falls back to the kind, and says that is what it did', () => {
    const { session, objects } = seed(1)
    const rows = stackRows(session, objects)

    expect(rows[0].label).toBe('Rectangle')
    expect(rows[0].named).toBe(false)
  })

  it('flattens a label onto one line and cuts it', () => {
    const { session, objects } = seed(1)
    setObjectText(session, objects[0].id, `first\nsecond ${'x'.repeat(80)}`)
    const rows = stackRows(session, [readObjectById(session, objects[0].id) as ObjectData])

    expect(rows[0].label).not.toContain('\n')
    expect(rows[0].label.startsWith('first second')).toBe(true)
    expect(rows[0].label.endsWith('…')).toBe(true)
  })
})

describe('dropTarget', () => {
  const rows = rowsOf(['a', 'b', 'c', 'd'])

  it('answers null at the top of the list', () => {
    expect(dropTarget(rows, new Set(['c']), 0)).toBeNull()
  })

  it('names the row the block lands under', () => {
    expect(dropTarget(rows, new Set(['d']), 2)).toBe('b')
  })

  it('does not count the dragged rows as neighbours', () => {
    // 'a' dragged down to the gap under 'c'. Two rows sit above that gap, but one of
    // them is 'a' itself, so the neighbour is 'c' - not 'b'.
    expect(dropTarget(rows, new Set(['a']), 3)).toBe('c')
  })

  it('handles a drop past the last row', () => {
    expect(dropTarget(rows, new Set(['a']), rows.length)).toBe('d')
  })

  it('is a no-op gap when the block is already the whole list', () => {
    expect(dropTarget(rows, new Set(['a', 'b', 'c', 'd']), 2)).toBeNull()
  })
})
