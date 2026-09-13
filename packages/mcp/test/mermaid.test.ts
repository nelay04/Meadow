import { gladeToGraph } from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { exportGlade } from '../../../apps/web/src/doc/interchange'
import { applyEdits, createDocSession } from '../../../apps/web/src/doc/mutations'
import { MermaidError, graphToMermaid, parseMermaid } from '../src/mermaid'
import { textToRich } from '../src/text'

describe('parseMermaid', () => {
  it('reads shapes, labels and chained edges', () => {
    const spec = parseMermaid(`flowchart LR
      %% a comment
      start([Start]) --> cart[Cart]
      cart -->|checkout| paid{"Paid? (yes/no)"}
      paid -- no --> cart
      paid -->|yes| db[(Orders)] --> done((Done))
      style cart fill:#fff
    `)
    expect(spec.direction).toBe('LR')
    expect(spec.nodes).toEqual([
      { key: 'start', label: 'Start', type: 'ellipse' },
      { key: 'cart', label: 'Cart', type: 'rect' },
      { key: 'paid', label: 'Paid? (yes/no)', type: 'diamond' },
      { key: 'db', label: 'Orders', type: 'cylinder' },
      { key: 'done', label: 'Done', type: 'ellipse' },
    ])
    expect(spec.edges).toEqual([
      { from: 'start', to: 'cart', direction: 'forward', type: 'arrow' },
      { from: 'cart', to: 'paid', label: 'checkout', direction: 'forward', type: 'arrow' },
      { from: 'paid', to: 'cart', label: 'no', direction: 'forward', type: 'arrow' },
      { from: 'paid', to: 'db', label: 'yes', direction: 'forward', type: 'arrow' },
      { from: 'db', to: 'done', direction: 'forward', type: 'arrow' },
    ])
  })

  it('reads link styles and bare ids without spaces', () => {
    const spec = parseMermaid('graph TD\nA-->B\nB --- C\nC <--> D\nD -.-> E\nE ==> F;')
    expect(spec.direction).toBe('TB')
    expect(spec.edges.map((edge) => [edge.from, edge.to, edge.direction, edge.type])).toEqual([
      ['A', 'B', 'forward', 'arrow'],
      ['B', 'C', 'none', 'line'],
      ['C', 'D', 'both', 'arrow'],
      ['D', 'E', 'forward', 'arrow'],
      ['E', 'F', 'forward', 'arrow'],
    ])
  })

  it('keeps quotes and line breaks in labels', () => {
    const spec = parseMermaid('flowchart LR\n  a["say #quot;hi#quot;<br/>twice"]')
    expect(spec.nodes[0].label).toBe('say "hi"\ntwice')
  })

  it('refuses what it cannot read', () => {
    expect(() => parseMermaid('flowchart LR\n')).toThrow(MermaidError)
    expect(() => parseMermaid('flowchart LR\n a --> ')).toThrow(MermaidError)
  })
})

describe('graphToMermaid', () => {
  it('writes a flowchart that reads back as the same structure', () => {
    const session = createDocSession(new Y.Doc(), 'owner')
    const { ids } = applyEdits(session, {
      create: [
        { ref: 'a', object: { type: 'rect', x: 0, y: 0 }, text: textToRich('Say "hi"') },
        { ref: 'b', object: { type: 'diamond', x: 300, y: 0 }, text: textToRich('Ok?') },
        {
          ref: 'e',
          object: { type: 'arrow', props: { startHead: 'open', endHead: 'none' } },
          text: textToRich('back', false),
        },
        { ref: 'free', object: { type: 'arrow' } },
      ],
      connect: [
        { arrow: 'e', end: 'start', target: 'a' },
        { arrow: 'e', end: 'end', target: 'b' },
      ],
    })
    const graph = gladeToGraph(exportGlade(session, { title: 'T', kind: 'glade' }, { app: 'test' }))
    const text = graphToMermaid(graph)
    expect(text).toContain('%% arrows with a free end')

    const spec = parseMermaid(text)
    expect(spec.nodes).toEqual([
      { key: ids.a, label: 'Say "hi"', type: 'rect' },
      { key: ids.b, label: 'Ok?', type: 'diamond' },
    ])
    // A back-pointing arrow is written the way it reads.
    expect(spec.edges).toEqual([
      { from: ids.b, to: ids.a, label: 'back', direction: 'forward', type: 'arrow' },
    ])
  })
})
