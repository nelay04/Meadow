/**
 * Mermaid flowcharts, both ways.
 *
 * Out: a glade graph as a flowchart. Lossy and cheap - no positions, no colours - and
 * worth having because every model reads Mermaid fluently and it costs a tenth of the
 * tokens the JSON graph does. Free-floating arrows have nothing to connect in Mermaid and
 * are listed as a comment rather than dropped silently.
 *
 * In: the subset of flowchart syntax models actually write - node shapes, labelled and
 * chained edges, arrow and line styles - turned into a diagram spec that `apply_diagram`
 * places. `subgraph`, `style`, `classDef`, `click` and the like are skipped: they are
 * presentation, and a spec that silently half-applied them would be worse.
 */

import type { EdgeDirection, GladeGraph, GraphNode, ObjectType } from '@meadow/schema'

export type SpecNodeType =
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'parallelogram'
  | 'triangle'
  | 'trapezoid'
  | 'polygon'
  | 'cylinder'
  | 'sticky'
  | 'text'

export type SpecNode = { key: string; label?: string; type?: SpecNodeType }
export type SpecEdge = {
  from: string
  to: string
  label?: string
  direction?: EdgeDirection
  type?: 'arrow' | 'line'
}
export type DiagramDirection = 'LR' | 'TB'
export type DiagramSpec = { direction?: DiagramDirection; nodes: SpecNode[]; edges: SpecEdge[] }

export class MermaidError extends Error {}

// --- out ------------------------------------------------------------------------------

const SHAPE_OUT: Partial<Record<ObjectType, [string, string]>> = {
  rect: ['[', ']'],
  sticky: ['[', ']'],
  text: ['[', ']'],
  ellipse: ['((', '))'],
  diamond: ['{', '}'],
  parallelogram: ['[/', '/]'],
  trapezoid: ['[/', '\\]'],
  cylinder: ['[(', ')]'],
  polygon: ['{{', '}}'],
  triangle: ['>', ']'],
}

function quote(label: string): string {
  // Mermaid's own escapes. A bare quote ends the label; a newline ends the statement.
  const escaped = label.replace(/"/g, '#quot;').replace(/\n/g, '<br/>')
  return `"${escaped}"`
}

/** A Mermaid id for a Meadow id. Meadow's are alphanumeric already; this is the guard. */
function safeId(id: string): string {
  const cleaned = id.replace(/[^A-Za-z0-9_]/g, '_')
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `n_${cleaned}`
}

function nodeLine(node: GraphNode): string {
  const [open, close] = SHAPE_OUT[node.type] ?? ['[', ']']
  const label = node.label === '' ? node.type : node.label
  return `  ${safeId(node.id)}${open}${quote(label)}${close}`
}

export function graphToMermaid(graph: GladeGraph, direction: DiagramDirection = 'LR'): string {
  const lines = [`flowchart ${direction}`]
  if (graph.title !== '') lines.unshift(`%% ${graph.title.replace(/\n/g, ' ')}`)

  const drawn = graph.nodes.filter((node) => node.type !== 'freedraw')
  const present = new Set(drawn.map((node) => node.id))
  for (const node of drawn) lines.push(nodeLine(node))

  const loose: string[] = []
  for (const edge of graph.edges) {
    if (
      edge.from === null ||
      edge.to === null ||
      !present.has(edge.from) ||
      !present.has(edge.to)
    ) {
      loose.push(edge.label === '' ? edge.id : `${edge.id} "${edge.label}"`)
      continue
    }
    let from = edge.from
    let to = edge.to
    let link = '---'
    if (edge.direction === 'forward') link = '-->'
    else if (edge.direction === 'both') link = '<-->'
    else if (edge.direction === 'back') {
      // Mermaid has no back-arrow, so the edge is written the way it reads.
      ;[from, to] = [to, from]
      link = '-->'
    }
    const label = edge.label === '' ? '' : `|${quote(edge.label)}|`
    lines.push(`  ${safeId(from)} ${link}${label} ${safeId(to)}`)
  }

  const groups = graph.groups.filter((group) => present.has(group.id))
  for (const group of groups) {
    lines.push(`  %% ${safeId(group.id)} contains ${group.children.map(safeId).join(', ')}`)
  }
  if (loose.length > 0) lines.push(`  %% arrows with a free end: ${loose.join(', ')}`)
  return `${lines.join('\n')}\n`
}

// --- in -------------------------------------------------------------------------------

/** Longest delimiters first, so `((` is not read as `(`. */
const SHAPE_IN: [string, string, SpecNodeType][] = [
  ['(((', ')))', 'ellipse'],
  ['((', '))', 'ellipse'],
  ['([', '])', 'ellipse'],
  ['[(', ')]', 'cylinder'],
  ['[[', ']]', 'rect'],
  ['{{', '}}', 'polygon'],
  ['[/', '/]', 'parallelogram'],
  ['[\\', '\\]', 'parallelogram'],
  ['[/', '\\]', 'trapezoid'],
  ['[\\', '/]', 'trapezoid'],
  ['[', ']', 'rect'],
  ['(', ')', 'rect'],
  ['{', '}', 'diamond'],
  ['>', ']', 'rect'],
]

const LINK = /^\s*(<?(?:-{2,}|={2,}|-\.+-)[>ox]?|~~~)\s*(?:\|([^|]*)\|)?\s*/
const LINK_WITH_TEXT = /^\s*(<?)(--|==|-\.)\s*([^->=.|][^|]*?)\s*(-->|==>|\.->|---|===|\.-)\s*/

function unquote(value: string): string {
  const trimmed = value.trim()
  const inner =
    trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
      ? trimmed.slice(1, -1)
      : trimmed
  return inner
    .replace(/#quot;/g, '"')
    .replace(/<br\s*\/?>/gi, '\n')
    .trim()
}

type Parsed = { node: SpecNode; rest: string }

function readNode(source: string): Parsed | null {
  // Single hyphens only, so `A-->B` written without spaces is `A` and a link.
  const match = /^\s*([A-Za-z0-9_]+(?:-[A-Za-z0-9_]+)*)/.exec(source)
  if (match === null) return null
  const key = match[1]
  let rest = source.slice(match[0].length)

  for (const [open, close, type] of SHAPE_IN) {
    if (!rest.startsWith(open)) continue
    // A quoted label may hold the closing delimiter, so quotes are skipped first.
    const body = rest.slice(open.length)
    let end: number
    if (body.trimStart().startsWith('"')) {
      const quoteStart = body.indexOf('"')
      const quoteEnd = body.indexOf('"', quoteStart + 1)
      end = quoteEnd === -1 ? -1 : body.indexOf(close, quoteEnd + 1)
    } else {
      end = body.indexOf(close)
    }
    if (end === -1) continue
    const label = unquote(body.slice(0, end))
    rest = body.slice(end + close.length)
    return { node: { key, label, type }, rest }
  }
  return { node: { key }, rest }
}

function linkDirection(token: string): { direction: EdgeDirection; type: 'arrow' | 'line' } {
  const back = token.startsWith('<')
  const forward = token.endsWith('>')
  if (back && forward) return { direction: 'both', type: 'arrow' }
  if (forward) return { direction: 'forward', type: 'arrow' }
  if (back) return { direction: 'back', type: 'arrow' }
  return { direction: 'none', type: 'line' }
}

function readLink(source: string): { edge: Omit<SpecEdge, 'from' | 'to'>; rest: string } | null {
  const withText = LINK_WITH_TEXT.exec(source)
  if (withText !== null) {
    const token = `${withText[1]}${withText[4]}`
    const { direction, type } = linkDirection(token)
    return {
      edge: { label: unquote(withText[3]), direction, type },
      rest: source.slice(withText[0].length),
    }
  }
  const match = LINK.exec(source)
  if (match === null) return null
  const { direction, type } = linkDirection(match[1])
  const label = match[2] === undefined ? undefined : unquote(match[2])
  return {
    edge: { ...(label === undefined || label === '' ? {} : { label }), direction, type },
    rest: source.slice(match[0].length),
  }
}

const SKIPPED = /^(subgraph|end|style|classDef|class|click|linkStyle|direction|accTitle|accDescr)\b/

export function parseMermaid(source: string): DiagramSpec {
  // Newlines only. Mermaid also allows `;` between statements, but its own quote escape
  // is `#quot;`, so a split on it would cut labels apart; a trailing one is stripped.
  const lines = source.replace(/\r\n?/g, '\n').split('\n')
  const nodes = new Map<string, SpecNode>()
  const edges: SpecEdge[] = []
  let direction: DiagramDirection | undefined
  let sawHeader = false

  const remember = (node: SpecNode): void => {
    const existing = nodes.get(node.key)
    if (existing === undefined) {
      nodes.set(node.key, { ...node })
      return
    }
    // A later mention with a label or shape fills in an earlier bare one.
    if (node.label !== undefined) existing.label = node.label
    if (node.type !== undefined) existing.type = node.type
  }

  for (const raw of lines) {
    const line = raw.replace(/%%.*$/, '').trim().replace(/;$/, '').trim()
    if (line === '') continue

    const header = /^(flowchart|graph)\b\s*(LR|RL|TB|TD|BT)?/i.exec(line)
    if (header !== null && !sawHeader) {
      sawHeader = true
      const value = (header[2] ?? 'TB').toUpperCase()
      direction = value === 'LR' || value === 'RL' ? 'LR' : 'TB'
      continue
    }
    if (SKIPPED.test(line)) continue

    const first = readNode(line)
    if (first === null) throw new MermaidError(`could not read a node at: ${line}`)
    remember(first.node)

    let from = first.node.key
    let rest = first.rest
    while (rest.trim() !== '') {
      const link = readLink(rest)
      if (link === null) throw new MermaidError(`could not read an edge at: ${rest.trim()}`)
      const next = readNode(link.rest)
      if (next === null) throw new MermaidError(`an edge has no target at: ${line}`)
      remember(next.node)
      edges.push({ from, to: next.node.key, ...link.edge })
      from = next.node.key
      rest = next.rest
    }
  }

  if (nodes.size === 0) throw new MermaidError('the diagram has no nodes')
  return { ...(direction === undefined ? {} : { direction }), nodes: [...nodes.values()], edges }
}
