/**
 * The `preview` guarantee: a previewed write changes nothing.
 *
 * The server's instructions promise every assistant that "preview: true" on any write
 * shows what would change without changing the glade. Nothing held that promise, and its
 * failure is the quiet kind: a model asks for the safe option, gets a plan back that
 * reads exactly like a preview, and the glade has already been written to. Nobody is
 * told. These tests are the only thing standing between that promise and a real board.
 *
 * Two halves, because there are two ways to break it.
 *
 * The first is the write path itself. Every `edit`-based tool plans a batch and, when a
 * preview was asked for, hands it to `previewCopy` instead of `applyEdits`. So the
 * guarantee for all of them reduces to one property of that seam, asserted here over
 * every shape of batch the tools can produce: the glade's bytes are identical afterwards.
 * Each case also asserts the batch was not a no-op, because byte-identity after doing
 * nothing proves nothing.
 *
 * The second is the argument never arriving. A write tool that simply forgets to declare
 * `preview` strips it as an unknown key and applies the write, which is the same silent
 * failure by a different route and is invisible to any test of the write path. So the
 * tool list is read back off a connected server and checked.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { type DocSession, type EditBatch, applyEdits, createDocSession } from '@meadow/document-core'

import type { MeadowApi, TokenInfo } from '../src/api'
import { previewCopy } from '../src/look'
import { parseMermaid } from '../src/mermaid'
import { planCreate, planDiagram, planRemove, planUpdate } from '../src/plan'
import { createServer } from '../src/server'
import { textToRich } from '../src/text'
import { planTidy } from '../src/tidy'

/** Two shapes and the arrow between them: enough for every plan builder to have work to do. */
async function seeded(): Promise<DocSession & { alpha: string; beta: string }> {
  const session = createDocSession(new Y.Doc(), 'owner')
  const { ids } = applyEdits(
    session,
    await planCreate(
      session,
      [
        { ref: 'a', label: 'Alpha' },
        { ref: 'b', label: 'Beta' },
      ],
      [{ ref: 'e', from: 'a', to: 'b' }],
    ),
  )
  return Object.assign(session, { alpha: ids.a!, beta: ids.b! })
}

type Case = {
  what: string
  batch: (session: DocSession & { alpha: string; beta: string }) => Promise<EditBatch>
}

// One per write tool that goes through `edit`, planned exactly as the tool plans it.
const cases: Case[] = [
  {
    what: 'create_nodes',
    batch: (session) => planCreate(session, [{ ref: 'c', label: 'Gamma' }], []),
  },
  {
    what: 'connect',
    batch: (session) => planCreate(session, [], [{ from: session.beta, to: session.alpha }]),
  },
  {
    what: 'update_objects',
    batch: async (session) => planUpdate(session, [{ id: session.alpha, x: 900, label: 'Moved' }]),
  },
  {
    what: 'delete_objects',
    batch: async (session) => planRemove(session, [session.beta]),
  },
  {
    what: 'set_text',
    batch: async (session) => ({
      update: [{ id: session.alpha, patch: {}, text: textToRich('Rewritten') }],
    }),
  },
  {
    what: 'apply_diagram',
    batch: async (session) =>
      (await planDiagram(session, parseMermaid('flowchart LR\n  Alpha --> Delta'))).batch,
  },
  {
    what: 'tidy_layout',
    batch: (session) => planTidy(session, { placement: { x: 40, y: 40 } }),
  },
]

describe('a previewed write leaves the glade byte-identical', () => {
  for (const { what, batch } of cases) {
    it(what, async () => {
      const session = await seeded()
      const before = Y.encodeStateAsUpdate(session.doc)
      const objects = session.objects.size

      const { copy, result } = previewCopy(session, await batch(session))

      // The plan had real work in it, so the assertions below mean something.
      const touched =
        Object.keys(result.ids).length + result.updated.length + result.removed.length
      expect(touched, 'the planned batch changed nothing, so this case proves nothing').toBeGreaterThan(0)
      expect(Y.encodeStateAsUpdate(copy.doc)).not.toEqual(before)

      // And the glade itself never moved.
      expect(Y.encodeStateAsUpdate(session.doc)).toEqual(before)
      expect(session.objects.size).toBe(objects)

      copy.doc.destroy()
    })
  }

  it('is still true when the same plan is previewed twice and then applied', async () => {
    const session = await seeded()
    const before = Y.encodeStateAsUpdate(session.doc)
    const batch = await planCreate(session, [{ ref: 'c', label: 'Gamma' }], [])

    for (const _ of [1, 2]) {
      const { copy } = previewCopy(session, batch)
      copy.doc.destroy()
      expect(Y.encodeStateAsUpdate(session.doc)).toEqual(before)
    }

    // Previewing did not consume the plan either: applying it for real still works.
    expect(Object.keys(applyEdits(session, batch).ids)).toHaveLength(1)
    expect(session.objects.size).toBe(4)
  })
})

/*
 * Tools that only read, so `preview` would mean nothing on them. Every other tool taking
 * a glade_id must offer it. Naming the readers rather than the writers makes the check
 * fail closed: a new write tool is caught without anyone remembering to list it, and a
 * new reader has to be added here deliberately.
 *
 * create_glade and import_glade are absent from both sides on purpose. They make the
 * glade they write to, so there is no existing document for a preview to protect.
 */
const READ_ONLY = [
  'get_glade_summary',
  'get_glade_graph',
  'find_objects',
  'get_objects',
  'export_glade',
  'export_mermaid',
  'list_lea_pages',
  'get_glade_snapshot',
  'check_layout',
]

describe('every write tool offers preview', () => {
  it('declares it in the input schema the client is handed', async () => {
    const access: TokenInfo = {
      id: 't',
      name: 'test',
      kind: 'classic',
      expires_at: null,
      can_create_glades: true,
      grants: null,
    }
    // Nothing here reaches the API: listing tools reads what registration already built.
    const { server, close } = createServer({
      api: {} as unknown as MeadowApi,
      idleMs: 1_000,
      access,
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'preview-test', version: '0' })
    await Promise.all([client.connect(clientSide), server.connect(serverSide)])

    try {
      const { tools } = await client.listTools()
      const names = tools.map((tool) => tool.name)
      // A reader renamed or dropped would otherwise leave a stale exemption behind.
      for (const reader of READ_ONLY) expect(names).toContain(reader)

      const writes = tools.filter(
        (tool) =>
          !READ_ONLY.includes(tool.name) &&
          Object.hasOwn(tool.inputSchema.properties ?? {}, 'glade_id'),
      )
      expect(writes.length).toBeGreaterThan(0)
      for (const tool of writes) {
        expect(
          Object.keys(tool.inputSchema.properties ?? {}),
          `${tool.name} takes a glade_id and writes to it, but does not offer preview`,
        ).toContain('preview')
      }
    } finally {
      await client.close()
      close()
    }
  })
})
