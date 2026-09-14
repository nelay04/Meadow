/**
 * Where new nodes go when a model does not say.
 *
 * Models are bad at pixels. Asked for coordinates they stack boxes on top of each other
 * or scatter them a screen apart, so any node created without `x` and `y` is placed
 * here instead: a layered layout (ELK's, the one most flowchart tools use)
 * over the new nodes and the edges between them, then moved as a block so it sits
 * beside what is already on the board rather than on top of it.
 */

import ELK from 'elkjs/lib/elk.bundled.js'

import type { DiagramDirection } from './mermaid'

export type LayoutNode = { key: string; w: number; h: number }
export type LayoutEdge = {
  from: string
  to: string
  /** The label's plate, so the gap between two columns is wide enough to show it. */
  label?: { w: number; h: number }
}
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
      'elk.edgeRouting': 'ORTHOGONAL',
      // Room between shapes in a column for the edges that pass them, and between
      // columns for a bend and a label. The canvas draws one bend per edge, so a gap that
      // is too tight turns every edge into a vertical Z instead of a horizontal one.
      'elk.spacing.nodeNode': '70',
      'elk.layered.spacing.nodeNodeBetweenLayers': '130',
      'elk.spacing.edgeNode': '30',
      'elk.spacing.edgeEdge': '18',
      'elk.layered.spacing.edgeNodeBetweenLayers': '40',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '18',
      'elk.spacing.edgeLabel': '6',
      'elk.edgeLabels.placement': 'CENTER',
      'elk.spacing.componentComponent': '100',
      // The order the model listed things in is usually the order it thinks in, so ties
      // keep it rather than being shuffled.
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      // A loop has to be cut somewhere to put nodes in columns. The default greedy cut
      // can pick an edge in the middle of the main flow, which moves everything after it
      // to the start of the diagram and sends long arrows back across it. Cutting the
      // edges that point back up the listed order keeps the flow the model described and
      // leaves the feedback edge ("live updates") as the one that runs backwards.
      'elk.layered.cycleBreaking.strategy': 'MODEL_ORDER',
    },
    children: nodes.map((node) => ({ id: node.key, width: node.w, height: node.h })),
    // Only edges with both ends in the block shape it. An edge to an existing node still
    // gets drawn; it just does not pull the new nodes towards somewhere ELK cannot see.
    edges: edges
      .filter((edge) => keys.has(edge.from) && keys.has(edge.to) && edge.from !== edge.to)
      .map((edge, index) => ({
        id: `e${index}`,
        sources: [edge.from],
        targets: [edge.to],
        ...(edge.label === undefined || edge.label.w === 0
          ? {}
          : { labels: [{ id: `l${index}`, width: edge.label.w, height: edge.label.h }] }),
      })),
  })

  const boxes = new Map(
    (graph.children ?? []).map((child) => [
      child.id,
      { x: child.x ?? 0, y: child.y ?? 0, w: child.width ?? 0, h: child.height ?? 0 },
    ]),
  )
  widenLayers(boxes, edges, direction)

  const placed: Placed = {}
  for (const [key, box] of boxes) {
    placed[key] = { x: Math.round(origin.x + box.x), y: Math.round(origin.y + box.y) }
  }
  return placed
}

type Box = { x: number; y: number; w: number; h: number }

/** The most a gap between two layers is widened by, so one far-flung edge cannot stretch a diagram off the screen. */
const MAX_LAYER_GAP = 340

/**
 * Widen the gap between two layers until the edges crossing it can bend the way they flow.
 *
 * An elbow leaves and enters square to the sides it is attached to, so an edge between
 * two columns that drops a long way needs horizontal room for its stubs, its turn and
 * its label, or its vertical run crowds the shapes beside it. Ports can slide along a
 * side to take up some of the drop; the rest has to be width.
 */
function widenLayers(
  boxes: Map<string, Box>,
  edges: readonly LayoutEdge[],
  direction: DiagramDirection,
): void {
  const across = direction === 'LR' ? 'x' : 'y'
  const along = direction === 'LR' ? 'y' : 'x'
  const size = direction === 'LR' ? 'w' : 'h'
  const breadth = direction === 'LR' ? 'h' : 'w'

  // Layers are the runs of boxes whose extents overlap along the flow.
  const sorted = [...boxes].sort((p, q) => p[1][across] - q[1][across])
  const layerOf = new Map<string, number>()
  const layers: { start: number; end: number }[] = []
  for (const [key, box] of sorted) {
    const last = layers[layers.length - 1]
    if (last !== undefined && box[across] < last.end) {
      last.end = Math.max(last.end, box[across] + box[size])
    } else {
      layers.push({ start: box[across], end: box[across] + box[size] })
    }
    layerOf.set(key, layers.length - 1)
  }

  const extra = new Array<number>(layers.length).fill(0)
  for (const edge of edges) {
    const a = boxes.get(edge.from)
    const b = boxes.get(edge.to)
    if (a === undefined || b === undefined) continue
    const la = layerOf.get(edge.from)!
    const lb = layerOf.get(edge.to)!
    if (Math.abs(la - lb) !== 1) continue
    const gapIndex = Math.max(la, lb)
    const gap = layers[gapIndex].start - layers[gapIndex - 1].end
    const drop =
      Math.abs(a[along] + a[breadth] / 2 - (b[along] + b[breadth] / 2)) -
      0.3 * (a[breadth] + b[breadth])
    // A label sits on the middle of the path, which between two layers is in the gap.
    const label =
      edge.label === undefined || edge.label.w === 0
        ? 0
        : (direction === 'LR' ? edge.label.w : edge.label.h) + 50
    const need = Math.min(MAX_LAYER_GAP, Math.max(drop + 30, label)) - gap
    extra[gapIndex] = Math.max(extra[gapIndex], need)
  }

  let shift = 0
  const shiftOf = extra.map((value) => (shift += Math.max(0, value)))
  for (const [key, box] of boxes) box[across] += shiftOf[layerOf.get(key)!]
}
