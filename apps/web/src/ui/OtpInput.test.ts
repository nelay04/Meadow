/**
 * The string handling behind the six boxes.
 *
 * The component is a view over one string, so everything that can actually go wrong is
 * in these three functions - and none of them needs a React tree, which this repo has no
 * way to build in a test. What is asserted here is the set of cases that turn a code
 * somebody typed into a code the server never sees: a hole in the middle, a seventh
 * character, and a Backspace that walks the wrong way.
 */

import { describe, expect, it } from 'vitest'

import { afterBackspace, clean, nextValue } from './OtpInput'

describe('clean', () => {
  it('keeps only digits', () => {
    // What a code selected in a mail client actually arrives as.
    expect(clean(' 004 821\n')).toBe('004821')
    expect(clean('abc')).toBe('')
  })
})

describe('nextValue', () => {
  it('fills the boxes in order', () => {
    expect(nextValue('', 0, '4', 6)).toBe('4')
    expect(nextValue('48', 2, '1', 6)).toBe('481')
  })

  it('replaces the character already in a box', () => {
    expect(nextValue('481', 1, '9', 6)).toBe('491')
  })

  it('never leaves a hole in the middle', () => {
    // Arrow keys can put the caret past the end. A character landing there appends
    // rather than creating four empty positions in front of it.
    expect(nextValue('4', 4, '9', 6)).toBe('49')
    expect(nextValue('', 5, '9', 6)).toBe('9')
  })

  it('cannot grow past the length', () => {
    expect(nextValue('004821', 5, '7', 6)).toHaveLength(6)
  })

  it('keeps a leading zero', () => {
    // The reason the boxes are not `type="number"`: half the codes this app sends begin
    // with one, and a code that silently loses it is refused with nothing to look at.
    expect(nextValue('', 0, '0', 6)).toBe('0')
  })
})

describe('afterBackspace', () => {
  it('clears the box it is in when there is something in it', () => {
    expect(afterBackspace('0048', 3)).toEqual({ value: '004', focus: 3 })
  })

  it('steps back and takes the character behind when the box is empty', () => {
    expect(afterBackspace('004', 3)).toEqual({ value: '00', focus: 2 })
  })

  it('does nothing at the start', () => {
    // Focus goes to -1, which is no box: `boxes.current[-1]` is undefined and the
    // optional call does nothing. The value must not go negative-length with it.
    expect(afterBackspace('', 0).value).toBe('')
  })
})
