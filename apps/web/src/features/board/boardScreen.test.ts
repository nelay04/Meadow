/**
 * Tests for the one decision that decides whether a glade's contents are allowed on
 * screen at all.
 *
 * Written before the fix, per the working agreement: this is the client half of a
 * password, and the client half used to lose. Opening a locked glade drew the whole
 * document from this browser's own offline copy and only put the password screen up
 * once the handshake came back refused, a second or two later - which is a lock that
 * shows you the room before it asks for the key.
 */

import { describe, expect, it } from 'vitest'

import { boardScreen } from './boardScreen'

/** Nothing has happened yet: no answer, no failure, no history. */
const FRESH = { admitted: false, unreachable: false, lockedBefore: false }

describe('boardScreen', () => {
  it('shows nothing of the glade until the server has admitted this browser', () => {
    expect(boardScreen('connecting', FRESH)).toBe('opening')
    expect(boardScreen('connected', FRESH)).toBe('opening')
  })

  it('draws the glade once the handshake has admitted it', () => {
    expect(boardScreen('connected', { ...FRESH, admitted: true })).toBe('glade')
  })

  it('asks for the password instead of drawing anything', () => {
    expect(boardScreen('password', FRESH)).toBe('password')
    // And still does, mid-session: a password put on a glade somebody is already
    // looking at closes their socket, and the re-mint is refused.
    expect(boardScreen('password', { ...FRESH, admitted: true })).toBe('password')
  })

  it('refuses outright where access is gone, admitted or not', () => {
    expect(boardScreen('denied', FRESH)).toBe('denied')
    expect(boardScreen('denied', { ...FRESH, admitted: true })).toBe('denied')
  })

  it('opens an ordinary glade from the offline copy when the API cannot be reached', () => {
    // Offline-first is the point of the local store, and an unreachable API is not a
    // refusal. Nothing has ever asked for a password here.
    expect(boardScreen('disconnected', { ...FRESH, unreachable: true })).toBe('glade')
  })

  it('refuses a glade known to be locked while the API cannot be reached', () => {
    // The password can only be checked by the server, so there is no honest way to
    // open this from cache. Refused and saying so beats silently showing it.
    expect(boardScreen('disconnected', { ...FRESH, unreachable: true, lockedBefore: true }))
      .toBe('blocked')
  })

  it('keeps a glade on screen through a blip once it has been admitted', () => {
    // A dropped socket on a locked glade this browser has already got into is not a
    // reason to take the document away mid-edit.
    expect(
      boardScreen('disconnected', { admitted: true, unreachable: true, lockedBefore: true }),
    ).toBe('glade')
  })

  it('waits rather than guessing while the first attempt is still out', () => {
    // The whole bug: this used to be 'glade'.
    expect(boardScreen('connecting', { ...FRESH, lockedBefore: true })).toBe('opening')
  })
})
