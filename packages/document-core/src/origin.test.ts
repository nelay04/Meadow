/**
 * The operation id, as it rides the Y.Doc transaction origin.
 *
 * This is the half of the audit trail that has no server to check it. The row in
 * `mcp_events` is only worth having if the id on it is the id the document write
 * actually carried, and the only place that can be observed is here, on the transaction.
 *
 * The undo case is the one that would rot quietly. `Y.UndoManager` matches a
 * non-primitive origin by its constructor, so an origin that stopped being recognised
 * would not fail anything loudly: assistants' writes would simply fall off that peer's
 * undo stack, which is a behaviour change nobody asked for arriving inside an audit
 * feature.
 */

import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'

import { LOCAL_ORIGIN, McpOrigin, applyEdits, createDocSession } from './mutations'

const seed = () => createDocSession(new Y.Doc(), 'owner')

const oneNode = { create: [{ ref: 'a', object: { type: 'rect' as const, x: 0, y: 0, w: 10, h: 10 } }] }

/** Every transaction origin seen on a doc, in order. */
function origins(doc: Y.Doc): unknown[] {
  const seen: unknown[] = []
  doc.on('afterTransaction', (transaction: Y.Transaction) => seen.push(transaction.origin))
  return seen
}

describe('the origin of a write', () => {
  it('is the local one when nobody says otherwise', () => {
    const session = seed()
    const seen = origins(session.doc)
    applyEdits(session, oneNode)
    expect(seen).toContain(LOCAL_ORIGIN)
  })

  it('carries the operation id and the tool when an assistant made it', () => {
    const session = seed()
    const seen = origins(session.doc)
    applyEdits(session, oneNode, new McpOrigin('op-1234', 'create_nodes'))

    const tagged = seen.filter((origin): origin is McpOrigin => origin instanceof McpOrigin)
    expect(tagged, 'no transaction carried an McpOrigin').toHaveLength(1)
    expect(tagged[0]!.operationId).toBe('op-1234')
    expect(tagged[0]!.tool).toBe('create_nodes')
  })

  it('gives each operation its own id', () => {
    const session = seed()
    const seen = origins(session.doc)
    applyEdits(session, oneNode, new McpOrigin('op-one', 'create_nodes'))
    applyEdits(session, oneNode, new McpOrigin('op-two', 'create_nodes'))

    const ids = seen
      .filter((origin): origin is McpOrigin => origin instanceof McpOrigin)
      .map((origin) => origin.operationId)
    expect(ids).toEqual(['op-one', 'op-two'])
  })

  it('stays on the undo stack, exactly as a local write does', () => {
    const session = seed()
    applyEdits(session, oneNode, new McpOrigin('op-1234', 'create_nodes'))
    expect(session.objects.size).toBe(1)

    session.undo.undo()
    expect(session.objects.size, 'an assistant write was not undoable').toBe(0)
  })

  it('does not write anything the local origin would not', () => {
    const plain = seed()
    const tagged = seed()
    applyEdits(plain, oneNode)
    applyEdits(tagged, oneNode, new McpOrigin('op-1234', 'create_nodes'))

    // The id is metadata on the transaction, never content. Two docs written the same
    // way must hold the same objects, or the trail is changing the glade it describes.
    expect(tagged.objects.size).toBe(plain.objects.size)
    expect([...tagged.objects.keys()].length).toBe([...plain.objects.keys()].length)
  })
})
