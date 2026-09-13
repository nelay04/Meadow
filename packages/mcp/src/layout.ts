/**
 * Where new nodes go when a model does not say.
 *
 * Models are bad at pixels. Asked for coordinates they stack boxes on top of each other
 * or scatter them a screen apart, so any node created without `x` and `y` is placed
 * here instead: a layered layout (ELK's, the one draw.io and most flowchart tools use)
 * over the new nodes and the edges between them, then moved as a block so it sits
 * beside what is already on the board rather than on top of it.
 */

import ELK from 'elkjs/lib/elk.bundled.js'

import type { DiagramDirection } from './mermaid'

export type LayoutNode = { key: string; w: number; h: number }
export type LayoutEdge = { from: string; to: string }
export type Placed = Record<string, { x: number; y: number }>

const elk = new ELK()

export async function layoutBlock(
  nodes: readonly LayoutNode[],
  edges: readonly LayoutEdge[],
  direction: DiagramDirection,
  origin: { x: number; y: number },
): Promise<Placed> {
  if (nodes.length === 0) return {}
  const keys = new Set(nodes.map((node) => node.key))

  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      // No border around the block: `origin` is where its top-left goes, exactly.
      'elk.padding': '[top=0,left=0,bottom=0,right=0]',
      'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN',
      'elk.spacing.nodeNode': '60',
      'elk.layered.spacing.nodeNodeBetweenLayers': '90',
      'elk.spacing.componentComponent': '80',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
    },
    children: nodes.map((node) => ({ id: node.key, width: node.w, height: node.h })),
    // Only edges with both ends in the block shape it. An edge to an existing node still
    // gets drawn; it just does not pull the new nodes towards somewhere ELK cannot see.
    edges: edges
      .filter((edge) => keys.has(edge.from) && keys.has(edge.to) && edge.from !== edge.to)
      .map((edge, index) => ({ id: `e${index}`, sources: [edge.from], targets: [edge.to] })),
  })

  const placed: Placed = {}
  for (const child of graph.children ?? []) {
    placed[child.id] = {
      x: Math.round(origin.x + (child.x ?? 0)),
      y: Math.round(origin.y + (child.y ?? 0)),
    }
  }
  return placed
}
