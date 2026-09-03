/**
 * The reconnect loop, against the real y-websocket.
 *
 * Mocked out: the mint endpoint, and the WebSocket itself. Everything between them is
 * the shipping code, because the bug this file exists for lived entirely in how
 * y-websocket's teardown and ours interleave - a stub of the provider would have had
 * no interleaving to get wrong.
 */

import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ConnectionState } from './provider'

const mintWsToken = vi.fn(async () => ({
  token: 'minted',
  expires_in: 60,
  role: 'editor' as const,
  can_write: true,
  is_locked: false,
}))

vi.mock('../lib/api', () => ({
  ApiError: class ApiError extends Error {
    readonly status: number
    constructor(status: number, message: string) {
      super(message)
      this.status = status
    }
  },
  mintWsToken: (...args: unknown[]) => mintWsToken(...(args as [])),
  mintGuestWsToken: (...args: unknown[]) => mintWsToken(...(args as [])),
}))

/** Every socket the provider has opened, in order. */
const sockets: FakeSocket[] = []

class FakeSocket {
  static readonly OPEN = 1
  readyState = 1
  binaryType = 'arraybuffer'
  onopen: (() => void) | null = null
  onclose: ((event: { code: number }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  onmessage: ((event: unknown) => void) | null = null

  constructor(readonly url: string) {
    sockets.push(this)
    // The provider registers its handlers synchronously after construction.
    setTimeout(() => this.onopen?.(), 0)
  }

  send(): void {}

  close(): void {
    this.readyState = 3
  }
}

const flush = async (): Promise<void> => {
  // Four turns: the mint promise, provider.connect, the queued onopen, and whatever
  // the open handler itself schedules.
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

beforeEach(() => {
  sockets.length = 0
  mintWsToken.mockClear()
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'meadow.test' })
  vi.stubGlobal('window', globalThis)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('connectBoard', () => {
  it('reconnects after the server evicts the socket', async () => {
    const { connectBoard } = await import('./provider')
    const states: ConnectionState[] = []

    const link = connectBoard({
      boardId: 'b1',
      doc: new Y.Doc(),
      linkToken: null,
      authenticated: true,
      onState: (state) => states.push(state),
      onAccess: () => {},
    })

    await flush()
    expect(sockets).toHaveLength(1)
    expect(states).toContain('connected')

    // What an owner's lock does to everybody else's connection: close 4403, and the
    // client is expected to come back with a freshly minted token and be told the new
    // answer. Before the fix this recursed until the stack overflowed, and the
    // provider was left holding a dead socket it would never replace.
    sockets[0].onclose?.({ code: 4403 })

    await vi.waitFor(async () => {
      await flush()
      expect(sockets).toHaveLength(2)
    })
    expect(mintWsToken).toHaveBeenCalledTimes(2)
    link.destroy()
  })

  it('recovers from an ordinary network close too', async () => {
    const { connectBoard } = await import('./provider')
    const link = connectBoard({
      boardId: 'b1',
      doc: new Y.Doc(),
      linkToken: null,
      authenticated: true,
      onState: () => {},
      onAccess: () => {},
    })

    await flush()
    sockets[0].onerror?.({})
    sockets[0].onclose?.({ code: 1006 })

    // The error handler schedules, then the close handler reschedules with the next
    // backoff step, so this is a second or so away rather than immediate.
    await vi.waitFor(
      async () => {
        await flush()
        expect(sockets.length).toBeGreaterThan(1)
      },
      { timeout: 4000 },
    )
    link.destroy()
  })
})
