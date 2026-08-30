import { describe, expect, it } from 'vitest'

import { localCandidates, transliterate } from './bengaliPhonetic'

describe('transliterate', () => {
  it('writes a vowel on its own as the independent letter', () => {
    expect(transliterate('amar')).toBe('আমার')
    expect(transliterate('ei')).toBe('এই')
  })

  it('writes a vowel after a consonant as its kar', () => {
    expect(transliterate('ki')).toBe('কি')
    expect(transliterate('bhat')).toBe('ভাত')
  })

  it('leaves the inherent vowel unwritten', () => {
    expect(transliterate('kolom')).toBe('কলম')
  })

  it('conjoins a consonant that follows a consonant', () => {
    expect(transliterate('bakko')).toBe('বাক্ক')
    expect(transliterate('spoShTo')).toBe('স্পষ্ট')
  })

  it('takes the longest rule, so an aspirate is one letter', () => {
    expect(transliterate('kha')).toBe('খা')
    expect(transliterate('gh')).toBe('ঘ')
  })

  it('reads case as Avro does', () => {
    expect(transliterate('T')).toBe('ট')
    expect(transliterate('t')).toBe('ত')
    expect(transliterate('Sh')).toBe('ষ')
  })

  it('passes through what it has no rule for', () => {
    expect(transliterate("mar'")).toBe("মার'")
  })

  it('converts digits', () => {
    expect(transliterate('2024')).toBe('২০২৪')
  })
})

describe('localCandidates', () => {
  it('leads with the transliteration', () => {
    expect(localCandidates('amar')[0]).toBe('আমার')
  })

  it('ends with the roman, so latin can still be typed', () => {
    expect(localCandidates('amar').at(-1)).toBe('amar')
  })

  it('offers the ambiguous letters as alternatives', () => {
    expect(localCandidates('nam')).toContain('ণাম')
  })

  it('never repeats a candidate', () => {
    const out = localCandidates('kolom')
    expect(new Set(out).size).toBe(out.length)
  })

  it('respects the limit', () => {
    expect(localCandidates('sonirbandho', 4).length).toBeLessThanOrEqual(4)
  })
})
