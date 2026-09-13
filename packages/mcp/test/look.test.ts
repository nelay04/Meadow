import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { applyEdits, createDocSession } from '../../../apps/web/src/doc/mutations'
import { lookAt, previewCopy } from '../src/look'
import { planCreate } from '../src/plan'

describe('previewCopy', () => {
  it('applies a batch to a copy and leaves the glade itself alone', async () => {
    const session = createDocSession(new Y.Doc(), 'owner')
    applyEdits(session, await planCreate(session, [{ ref: 'a', label: 'Kept' }], []))
    const before = Y.encodeStateAsUpdate(session.doc)

    const batch = await planCreate(session, [{ ref: 'b', label: 'Planned' }], [])
    const { copy, result } = previewCopy(session, batch)

    expect(copy.objects.size).toBe(2)
    expect(copy.objects.has(result.ids.b)).toBe(true)
    expect(session.objects.size).toBe(1)
    expect(Y.encodeStateAsUpdate(session.doc)).toEqual(before)
  })

  it('works for a viewer, whose own session could never apply it', async () => {
    const owner = createDocSession(new Y.Doc(), 'owner')
    applyEdits(owner, await planCreate(owner, [{ ref: 'a', label: 'A' }], []))
    const viewer = createDocSession(new Y.Doc(), 'viewer')
    Y.applyUpdate(viewer.doc, Y.encodeStateAsUpdate(owner.doc))
    const { copy } = previewCopy(viewer, await planCreate(viewer, [{ ref: 'b' }], []))
    expect(copy.objects.size).toBe(2)
    expect(viewer.objects.size).toBe(1)
  })
})

describe('lookAt', () => {
  it('draws the named objects as a PNG and says what it drew', async () => {
    const session = createDocSession(new Y.Doc(), 'owner')
    const { ids } = applyEdits(session, await planCreate(session, [{ ref: 'a', label: 'A' }], []))
    const look = await lookAt(
      session,
      { title: 'T', kind: 'glade' },
      { ids: [ids.a], maxWidth: 600 },
    )
    expect(look.image.mimeType).toBe('image/png')
    expect(look.details.drawn).toBe(1)
    expect(look.details.width).toBeLessThanOrEqual(600)
  })
})
