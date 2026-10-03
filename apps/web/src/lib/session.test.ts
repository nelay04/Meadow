/**
 * Tests for the one question this client must never answer by guessing: is this
 * browser still signed in?
 *
 * A 401 settles it. Anything else is a failure to ask, not an answer - a 502 from
 * nginx for the few seconds the API spends restarting after a deploy, a dropped
 * connection, a tab that was asleep when the wifi went. Reading those as a logout is
 * what empties a working session out from under somebody who is looking at the screen,
 * and the reload that brings their glades straight back is the proof it was never
 * their session that ended.
 *
 * Written before the fix, per the working agreement for anything auth-related.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { clearAccessToken, hasAccessToken, restoreSession, setAccessToken } from './api'

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

const USER = { id: 'u1', email: 'a@b.c', display_name: 'A' }

/** A fetch that answers each path from a table, and records what was asked. */
function stubFetch(answers: Record<string, () => Promise<Response>>): string[] {
  const asked: string[] = []
  vi.stubGlobal('fetch', (url: string) => {
    const path = url.replace('/api/v1', '')
    asked.push(path)
    const answer = answers[path]
    if (answer === undefined) throw new Error(`unexpected request to ${path}`)
    return answer()
  })
  return asked
}

beforeEach(() => {
  clearAccessToken()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('restoreSession', () => {
  it('reports an active session, with the user', async () => {
    stubFetch({
      '/auth/refresh': () => Promise.resolve(json({ access_token: 'tok' })),
      '/auth/me': () => Promise.resolve(json(USER)),
    })
    const check = await restoreSession()
    expect(check).toEqual({ state: 'active', user: USER })
    expect(hasAccessToken()).toBe(true)
  })

  it('reports no session when the server refuses the refresh cookie', async () => {
    stubFetch({ '/auth/refresh': () => Promise.resolve(json({ detail: 'no refresh token' }, 401)) })
    expect(await restoreSession()).toEqual({ state: 'none' })
    expect(hasAccessToken()).toBe(false)
  })

  it('reports unknown, not none, while the API is restarting', async () => {
    // The deploy case: nginx is up and the API behind it is not.
    stubFetch({
      '/auth/refresh': () => Promise.resolve(new Response('<html>502</html>', { status: 502 })),
    })
    expect(await restoreSession()).toEqual({ state: 'unknown' })
  })

  it('reports unknown when the request never arrives', async () => {
    // fetch rejects for an offline tab or a dropped connection. Not an answer either.
    stubFetch({ '/auth/refresh': () => Promise.reject(new TypeError('Failed to fetch')) })
    expect(await restoreSession()).toEqual({ state: 'unknown' })
  })

  it('keeps the access token it already had when it could not ask', async () => {
    // Nothing has said this token is bad, so throwing it away would turn a blip into
    // a logout on the next call.
    setAccessToken('tok')
    stubFetch({ '/auth/refresh': () => Promise.resolve(new Response('', { status: 503 })) })
    expect(await restoreSession()).toEqual({ state: 'unknown' })
    expect(hasAccessToken()).toBe(true)
  })

  it('reports unknown when the refresh works and the profile call does not', async () => {
    stubFetch({
      '/auth/refresh': () => Promise.resolve(json({ access_token: 'tok' })),
      '/auth/me': () => Promise.resolve(new Response('', { status: 502 })),
    })
    expect(await restoreSession()).toEqual({ state: 'unknown' })
  })

  it('reports none when the profile call is refused outright', async () => {
    const asked = stubFetch({
      '/auth/refresh': () => Promise.resolve(json({ access_token: 'tok' })),
      '/auth/me': () => Promise.resolve(json({ detail: 'unauthorized' }, 401)),
    })
    expect(await restoreSession()).toEqual({ state: 'none' })
    expect(hasAccessToken()).toBe(false)
    // The 401 retry refreshes once and asks once more before believing it.
    expect(asked.filter((path) => path === '/auth/me')).toHaveLength(2)
  })
})
