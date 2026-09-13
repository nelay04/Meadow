/**
 * A glade as a graph: what a language model reasons about, rather than what the canvas
 * stores.
 *
 * The interchange file is lossless, which makes it the wrong thing to hand a model. An
 * arrow there is a box, a flat array of relative points and two binding rows elsewhere
 * in the file; working out that it says "Checkout -> Payment, labelled 'pay'" means
 * joining three structures and reading a head style off a default. This does that join
 * once, in one place, so every tool that describes a board describes it the same way.
 *
 * Lossy on purpose and one-way. Nothing is ever written back from a graph: edits go
 * through `mutations.ts` against the live document, and the ids here are the document's
 * own, so a model can read a graph and then say "update node X".
 */

import type { ArrowHead, ArrowRouting } from './arrows'
import { isArrowLike } from './arrows'
import type { GladeFile, GladeObject, GladeRichNode } from './interchange'
import type { ObjectType } from './objects'

export type GraphNode = {
  id: string
  type: ObjectType
  /** The object's text as plain lines. Empty when it has none. */
  label: string
  x: number
  y: number
  w: number
  h: number
  /** The frame or group this sits in, by id. */
  parent: string | null
  fill?: string
  stroke?: string
}

/** Which way an edge reads, from its heads: `forward` is from -> to. */
export type EdgeDirection = 'forward' | 'back' | 'both' | 'none'

export type GraphEdge = {
  id: string
  type: 'arrow' | 'line'
  /** The object the start is attached to, or null for a free end. */
  from: string | null
  to: string | null
  label: string
  direction: EdgeDirection
  routing: ArrowRouting
}

export type GraphGroup = { id: string; label: string; children: string[] }

export type GladeGraph = {
  title: string
  kind: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  groups: GraphGroup[]
}

/** Block nodes that end a line, as `fragmentToPlainText` has them. */
const LINE_BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'listItem'])

/** Rich text as plain text: one line per block, marks dropped. */
export function richTextToPlain(nodes: readonly GladeRichNode[] | null): string {
  if (nodes === null) return ''
  const lines: string[] = []
  let current = ''

  const walk = (list: readonly GladeRichNode[]): void => {
    for (const node of list) {
      if ('text' in node) {
        for (const run of node.text) current += run.insert
        continue
      }
      if (node.name === 'hardBreak') {
        current += '\n'
        continue
      }
      const isLine = LINE_BLOCKS.has(node.name)
      // A list item holds a paragraph, so the paragraph ends the line and the item
      // does not end a second, empty one.
      const holdsBlocks = node.children.some((child) => 'name' in child && LINE_BLOCKS.has(child.name))
      walk(node.children)
      if (isLine && !holdsBlocks) {
        lines.push(current)
        current = ''
      }
    }
  }

  walk(nodes)
  if (current !== '') lines.push(current)
  return lines.join('\n').replace(/\n+$/, '')
}

function hex(value: unknown): string | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return `#${(value & 0xffffff).toString(16).padStart(6, '0')}`
}

function head(value: unknown, fallback: ArrowHead): ArrowHead {
  return value === 'none' || value === 'triangle' || value === 'open' ? value : fallback
}

export function edgeDirection(object: Pick<GladeObject, 'type' | 'props'>): EdgeDirection {
  const start = head(object.props.startHead, 'none')
  const end = head(object.props.endHead, object.type === 'line' ? 'none' : 'open')
  if (start !== 'none' && end !== 'none') return 'both'
  if (end !== 'none') return 'forward'
  if (start !== 'none') return 'back'
  return 'none'
}

/** Rounded to the unit. Sub-pixel positions are noise to a reader and cost tokens. */
const round = (value: number): number => Math.round(value)

export function gladeToGraph(file: GladeFile): GladeGraph {
  const ends = new Map<string, { start: string | null; end: string | null }>()
  for (const binding of file.bindings) {
    const entry = ends.get(binding.arrowId) ?? { start: null, end: null }
    entry[binding.end] = binding.targetId
    ends.set(binding.arrowId, entry)
  }

  const byId = new Map(file.objects.map((object) => [object.id, object]))
  const nodes: GraphNode[] = []
  const edges: GraphEdge[] = []
  const children = new Map<string, string[]>()

  // In z-order, bottom to top, so the graph lists things in the order the board stacks
  // them - which is usually the order they were drawn.
  const ordered = file.order.flatMap((id) => {
    const object = byId.get(id)
    return object === undefined ? [] : [object]
  })
  const listed = new Set(file.order)
  for (const object of file.objects) if (!listed.has(object.id)) ordered.push(object)

  for (const object of ordered) {
    const label = richTextToPlain(object.text)

    if (isArrowLike(object.type)) {
      const bound = ends.get(object.id)
      // A binding to something no longer on the board is a free end, as it is drawn.
      const target = (id: string | null | undefined): string | null =>
        id !== null && id !== undefined && byId.has(id) ? id : null
      edges.push({
        id: object.id,
        type: object.type === 'line' ? 'line' : 'arrow',
        from: target(bound?.start),
        to: target(bound?.end),
        label,
        direction: edgeDirection(object),
        routing:
          object.props.routing === 'curved' || object.props.routing === 'orthogonal'
            ? object.props.routing
            : 'straight',
      })
      continue
    }

    const node: GraphNode = {
      id: object.id,
      type: object.type,
      label,
      x: round(object.x),
      y: round(object.y),
      w: round(object.w),
      h: round(object.h),
      parent: object.parentId !== null && byId.has(object.parentId) ? object.parentId : null,
    }
    const fill = hex(object.props.fill)
    const stroke = hex(object.props.stroke)
    if (fill !== undefined) node.fill = fill
    if (stroke !== undefined) node.stroke = stroke
    nodes.push(node)

    if (node.parent !== null) {
      const list = children.get(node.parent) ?? []
      list.push(node.id)
      children.set(node.parent, list)
    }
  }

  const labels = new Map(nodes.map((node) => [node.id, node.label]))
  const groups: GraphGroup[] = [...children].map(([id, members]) => ({
    id,
    label: labels.get(id) ?? '',
    children: members,
  }))

  return { title: file.board.title, kind: file.board.kind, nodes, edges, groups }
}
