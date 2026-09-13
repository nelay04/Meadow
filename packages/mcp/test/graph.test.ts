import { gladeToGraph, richTextToPlain } from '@meadow/schema'
import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { exportGlade } from '../../../apps/web/src/doc/interchange'
import { applyEdits, createDocSession } from '../../../apps/web/src/doc/mutations'
import { textToRich } from '../src/text'

function board() {
  const session = createDocSession(new Y.Doc(), 'owner')
  const { ids } = applyEdits(session, {
    create: [
      {
        ref: 'frame',
        object: { type: 'rect', x: -50, y: -50, w: 900, h: 400 },
        text: textToRich('Checkout'),
      },
      {
        ref: 'cart',
        object: {
          type: 'rect',
          x: 0,
          y: 0,
          w: 120,
          h: 60,
          parentId: 'frame',
          props: { fill: 0xf4d35e },
        },
        text: textToRich('Cart'),
      },
      {
        ref: 'pay',
        object: { type: 'diamond', x: 400, y: 0, w: 120, h: 80, parentId: 'frame' },
        text: textToRich('Paid?'),
      },
      { ref: 'next', object: { type: 'arrow' }, text: textToRich('pay', false) },
      { ref: 'both', object: { type: 'arrow', props: { startHead: 'open' } } },
      { ref: 'plain', object: { type: 'line' } },
      { ref: 'loose', object: { type: 'arrow', x: 0, y: 300, props: { points: [0, 0, 100, 0] } } },
    ],
    connect: [
      { arrow: 'next', end: 'start', target: 'cart' },
      { arrow: 'next', end: 'end', target: 'pay' },
      { arrow: 'both', end: 'start', target: 'pay' },
      { arrow: 'both', end: 'end', target: 'cart' },
      { arrow: 'plain', end: 'start', target: 'cart' },
      { arrow: 'plain', end: 'end', target: 'pay' },
      { arrow: 'loose', end: 'start', target: 'pay' },
    ],
  })
  return {
    session,
    ids,
    file: exportGlade(session, { title: 'Shop', kind: 'glade' }, { app: 'test' }),
  }
}

describe('gladeToGraph', () => {
  it('separates nodes from edges and keeps the board ids', () => {
    const { ids, file } = board()
    const graph = gladeToGraph(file)
    expect(graph.title).toBe('Shop')
    expect(graph.nodes.map((node) => node.id)).toEqual([ids.frame, ids.cart, ids.pay])
    expect(graph.edges.map((edge) => edge.id)).toEqual([ids.next, ids.both, ids.plain, ids.loose])
  })

  it('reads labels, colours and frame membership', () => {
    const { ids, file } = board()
    const graph = gladeToGraph(file)
    const cart = graph.nodes.find((node) => node.id === ids.cart)!
    expect(cart).toMatchObject({ label: 'Cart', type: 'rect', parent: ids.frame, fill: '#f4d35e' })
    expect(graph.groups).toEqual([
      { id: ids.frame, label: 'Checkout', children: [ids.cart, ids.pay] },
    ])
  })

  it('reads what each edge connects and which way it points', () => {
    const { ids, file } = board()
    const edges = Object.fromEntries(gladeToGraph(file).edges.map((edge) => [edge.id, edge]))
    expect(edges[ids.next]).toMatchObject({
      from: ids.cart,
      to: ids.pay,
      label: 'pay',
      direction: 'forward',
    })
    expect(edges[ids.both]).toMatchObject({ from: ids.pay, to: ids.cart, direction: 'both' })
    expect(edges[ids.plain]).toMatchObject({ type: 'line', direction: 'none' })
    expect(edges[ids.loose]).toMatchObject({ from: ids.pay, to: null })
  })

  it('treats a binding to a missing object as a free end', () => {
    const { ids, file } = board()
    const without = { ...file, objects: file.objects.filter((object) => object.id !== ids.pay) }
    const edge = gladeToGraph(without).edges.find((entry) => entry.id === ids.next)!
    expect(edge.to).toBeNull()
  })
})

describe('richTextToPlain', () => {
  it('writes one line per block, including list items', () => {
    expect(richTextToPlain(textToRich('# Title\nfirst **bold**\n- a\n- b'))).toBe(
      'Title\nfirst bold\na\nb',
    )
    expect(richTextToPlain(null)).toBe('')
  })
})
