import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  setSpellcheckEnabled,
  spellcheckEnabled,
  subscribeSpellcheck,
} from './spellcheckStore'

// The store is module state shared by every test in this file, and it is what the
// editor and the menu both read. Leaving it off would make the next test's default a
// lie about what a fresh browser does.
afterEach(() => setSpellcheckEnabled(true))

describe('spellcheck preference', () => {
  it('is on before anybody has chosen, so a typo is marked the way it is everywhere else', () => {
    expect(spellcheckEnabled()).toBe(true)
  })

  it('turns off and back on', () => {
    setSpellcheckEnabled(false)
    expect(spellcheckEnabled()).toBe(false)
    setSpellcheckEnabled(true)
    expect(spellcheckEnabled()).toBe(true)
  })

  it('tells its readers, which is how the open editor hears about the menu', () => {
    const listener = vi.fn()
    const stop = subscribeSpellcheck(listener)

    setSpellcheckEnabled(false)
    expect(listener).toHaveBeenCalledTimes(1)

    stop()
    setSpellcheckEnabled(true)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('says nothing when the value has not moved', () => {
    // Every notification dispatches an empty transaction into the live editor. Setting
    // the value it already holds must not be one.
    const listener = vi.fn()
    const stop = subscribeSpellcheck(listener)

    setSpellcheckEnabled(true)
    expect(listener).not.toHaveBeenCalled()

    stop()
  })

  it('survives a browser with no storage at all', () => {
    // Vitest runs this in node, where there is no `window` - the same shape as Safari
    // in a private window, which throws on `localStorage`. The preference has to keep
    // working for the session either way; it just does not outlive a reload.
    expect(() => setSpellcheckEnabled(false)).not.toThrow()
    expect(spellcheckEnabled()).toBe(false)
  })
})
