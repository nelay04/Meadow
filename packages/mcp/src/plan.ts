/**
 * Tool input to an `EditBatch`: what a model asked for, as the document write it means.
 *
 * Pure apart from reading the session, so every tool can offer `preview`: the same plan,
 * returned instead of applied. Nothing here writes; `applyEdits` in `mutations.ts` is
 * still the only thing that does.
 */

import {
  type EdgeDirection,
  type ObjectData,
  STICKY_DEFAULT_SIZE,
  TEXT_DEFAULT_SIZE,
  isArrowLike,
  objectBounds,
  readObject,
} from '@meadow/schema'

import type {
  DocSession,
  EditBatch,
  EditConnect,
  EditCreate,
  EditUpdate,
} from '../../../apps/web/src/doc/mutations'
import { fragmentToPlainText } from '../../../apps/web/src/doc/richText'
import { type Placed, layoutBlock } from './layout'
import type { DiagramDirection, DiagramSpec, SpecNodeType } from './mermaid'
import { textToRich } from './text'

/** Per call. A model that means to draw more can call again; one that did not mean to stops. */
export const MAX_OBJECTS_PER_CALL = 500

export class PlanError extends Error {}

export type NodeInput = {
  ref?: string
  type?: SpecNodeType
  label?: string
  x?: number
  y?: number
  w?: number
  h?: number
  fill?: string
  stroke?: string
  text_color?: string
  font_size?: number
  parent?: string
}

export type EdgeInput = {
  ref?: string
  from: string
  to: string
  label?: string
  direction?: EdgeDirection
  routing?: 'straight' | 'curved' | 'orthogonal'
  type?: 'arrow' | 'line'
  stroke?: string
}

export type UpdateInput = {
  id: string
  label?: string
  x?: number
  y?: number
  w?: number
  h?: number
  rotation?: number
  fill?: string
  stroke?: string
  text_color?: string
  font_size?: number
  direction?: EdgeDirection
  routing?: 'straight' | 'curved' | 'orthogonal'
  locked?: boolean
}

const SIZES: Record<SpecNodeType, { w: number; h: number }> = {
  rect: { w: 180, h: 80 },
  ellipse: { w: 150, h: 90 },
  diamond: { w: 170, h: 110 },
  parallelogram: { w: 190, h: 80 },
  triangle: { w: 140, h: 110 },
  trapezoid: { w: 180, h: 80 },
  polygon: { w: 150, h: 110 },
  cylinder: { w: 140, h: 110 },
  sticky: STICKY_DEFAULT_SIZE,
  text: TEXT_DEFAULT_SIZE,
}

export function colour(value: string | undefined, field: string): number | undefined {
  if (value === undefined) return undefined
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim())
  if (match === null)
    throw new PlanError(`${field} must be a hex colour like #1f7a8c, not ${value}`)
  const digits = match[1].length === 3 ? [...match[1]].map((c) => c + c).join('') : match[1]
  return Number.parseInt(digits, 16)
}

function heads(direction: EdgeDirection): { startHead: string; endHead: string } {
  switch (direction) {
    case 'forward':
      return { startHead: 'none', endHead: 'open' }
    case 'back':
      return { startHead: 'open', endHead: 'none' }
    case 'both':
      return { startHead: 'open', endHead: 'open' }
    case 'none':
      return { startHead: 'none', endHead: 'none' }
  }
}

function styleProps(input: {
  type?: string
  fill?: string
  stroke?: string
  text_color?: string
  font_size?: number
}): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  const fill = colour(input.fill, 'fill')
  const stroke = colour(input.stroke, 'stroke')
  const text = colour(input.text_color, 'text_color')
  if (fill !== undefined) props.fill = fill
  if (stroke !== undefined) props.stroke = stroke
  if (text !== undefined) props.color = text
  if (input.font_size !== undefined) props.fontSize = input.font_size
  return props
}

/** The box around everything on the board, or null when it is empty. */
export function contentBounds(
  session: DocSession,
): { minX: number; minY: number; maxX: number; maxY: number } | null {
  let bounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null
  for (const map of session.objects.values()) {
    const box = objectBounds(readObject(map))
    const minX = Math.min(box.minX, box.maxX)
    const maxX = Math.max(box.minX, box.maxX)
    const minY = Math.min(box.minY, box.maxY)
    const maxY = Math.max(box.minY, box.maxY)
    bounds =
      bounds === null
        ? { minX, minY, maxX, maxY }
        : {
            minX: Math.min(bounds.minX, minX),
            minY: Math.min(bounds.minY, minY),
            maxX: Math.max(bounds.maxX, maxX),
            maxY: Math.max(bounds.maxY, maxY),
          }
  }
  return bounds
}

/** Beside the board's content, to the right, top-aligned. The origin on an empty board. */
function besideContent(session: DocSession): { x: number; y: number } {
  const bounds = contentBounds(session)
  return bounds === null
    ? { x: 0, y: 0 }
    : { x: Math.round(bounds.maxX + 160), y: Math.round(bounds.minY) }
}

function checkSize(count: number): void {
  if (count > MAX_OBJECTS_PER_CALL) {
    throw new PlanError(`at most ${MAX_OBJECTS_PER_CALL} objects per call; this asked for ${count}`)
  }
}

function checkNumber(value: number | undefined, field: string): void {
  if (value !== undefined && !Number.isFinite(value))
    throw new PlanError(`${field} must be a number`)
}

/**
 * Nodes and edges to one batch. Nodes without both `x` and `y` are laid out as a block,
 * placed at `placement` or beside the board's content.
 */
export async function planCreate(
  session: DocSession,
  nodes: readonly NodeInput[],
  edges: readonly EdgeInput[],
  options: {
    direction?: DiagramDirection
    placement?: { x: number; y: number }
    /** For edges that do not choose their own. Straight by default. */
    routing?: 'straight' | 'curved' | 'orthogonal'
  } = {},
): Promise<EditBatch> {
  checkSize(nodes.length + edges.length)

  const refs = new Set<string>()
  const refOf = (ref: string | undefined, fallback: string): string => {
    let value = ref ?? fallback
    // A generated ref steps aside for a chosen one; only a chosen ref used twice is an error.
    for (let n = 2; ref === undefined && (refs.has(value) || session.objects.has(value)); n += 1) {
      value = `${fallback}_${n}`
    }
    if (refs.has(value)) throw new PlanError(`ref used twice: ${value}`)
    if (session.objects.has(value)) {
      throw new PlanError(`ref ${value} is already an object id on this glade; pick another ref`)
    }
    refs.add(value)
    return value
  }

  const sized = nodes.map((node, index) => {
    const type = node.type ?? 'rect'
    if (!(type in SIZES)) throw new PlanError(`unknown node type: ${type}`)
    for (const field of ['x', 'y', 'w', 'h', 'font_size'] as const) checkNumber(node[field], field)
    const size = SIZES[type]
    return {
      ...node,
      type,
      ref: refOf(node.ref, `node${index + 1}`),
      w: node.w ?? size.w,
      h: node.h ?? size.h,
    }
  })

  const unplaced = sized.filter((node) => node.x === undefined || node.y === undefined)
  let placed: Placed = {}
  if (unplaced.length > 0) {
    placed = await layoutBlock(
      unplaced.map((node) => ({ key: node.ref, w: node.w, h: node.h })),
      edges.map((edge) => ({ from: edge.from, to: edge.to })),
      options.direction ?? 'LR',
      options.placement ?? besideContent(session),
    )
  }

  const create: EditCreate[] = sized.map((node) => {
    const at =
      node.x !== undefined && node.y !== undefined ? { x: node.x, y: node.y } : placed[node.ref]
    return {
      ref: node.ref,
      object: {
        type: node.type,
        x: at.x,
        y: at.y,
        w: node.w,
        h: node.h,
        ...(node.parent === undefined ? {} : { parentId: node.parent }),
        props: styleProps(node),
      },
      text: node.label === undefined || node.label === '' ? null : textToRich(node.label),
    }
  })

  // Directed pairs already joined, on the board and earlier in this batch. An edge running
  // the other way between the same two shapes would otherwise be drawn exactly on top of
  // the first one, through both shapes, and neither label could be read.
  const joined = new Set<string>()
  const ends = new Map<string, { start: string | null; end: string | null }>()
  for (const map of session.bindings.values()) {
    const arrowId = String(map.get('arrowId'))
    const entry = ends.get(arrowId) ?? { start: null, end: null }
    entry[map.get('end') === 'end' ? 'end' : 'start'] =
      (map.get('targetId') as string | null) ?? null
    ends.set(arrowId, entry)
  }
  for (const { start, end } of ends.values())
    if (start !== null && end !== null) joined.add(`${start}>${end}`)

  const connect: EditConnect[] = []
  edges.forEach((edge, index) => {
    if (edge.from === edge.to) throw new PlanError(`an edge cannot connect ${edge.from} to itself`)
    const ref = refOf(edge.ref, `edge${index + 1}`)
    const type = edge.type ?? 'arrow'
    const direction = edge.direction ?? (type === 'line' ? 'none' : 'forward')
    const stroke = colour(edge.stroke, 'stroke')
    const returning = joined.has(`${edge.to}>${edge.from}`)
    joined.add(`${edge.from}>${edge.to}`)
    // A bow rather than a second straight line: both halves lean the same way, which is a
    // C and not an S, so the return path clears the outgoing one along its whole length.
    const route = edge.routing ?? (returning ? 'curved' : (options.routing ?? 'straight'))
    create.push({
      ref,
      object: {
        type,
        props: {
          ...heads(direction),
          routing: route,
          ...(route === 'curved' && returning ? { curvature: 0.45, curvatureEnd: 0.45 } : {}),
          ...(stroke === undefined ? {} : { stroke }),
        },
      },
      text: edge.label === undefined || edge.label === '' ? null : textToRich(edge.label, false),
    })
    connect.push(
      { arrow: ref, end: 'start', target: edge.from },
      { arrow: ref, end: 'end', target: edge.to },
    )
  })

  return { create, connect }
}

export function planUpdate(session: DocSession, updates: readonly UpdateInput[]): EditBatch {
  checkSize(updates.length)
  const update: EditUpdate[] = updates.map((input) => {
    const map = session.objects.get(input.id)
    if (map === undefined) throw new PlanError(`no object with id ${input.id}`)
    const current = readObject(map)
    for (const field of ['x', 'y', 'w', 'h', 'rotation', 'font_size'] as const)
      checkNumber(input[field], field)

    const patch: Partial<ObjectData> = {}
    if (input.x !== undefined) patch.x = input.x
    if (input.y !== undefined) patch.y = input.y
    if (input.rotation !== undefined) patch.rotation = input.rotation
    if (input.locked !== undefined) patch.locked = input.locked

    const arrow = isArrowLike(current.type)
    if (!arrow) {
      if (input.w !== undefined) patch.w = input.w
      if (input.h !== undefined) patch.h = input.h
    } else if (input.w !== undefined || input.h !== undefined) {
      throw new PlanError(
        `${input.id} is an arrow; its size comes from its ends, so move what it connects instead`,
      )
    }

    const props = styleProps(input)
    if (arrow && input.direction !== undefined) Object.assign(props, heads(input.direction))
    if (arrow && input.routing !== undefined) props.routing = input.routing
    if (Object.keys(props).length > 0) patch.props = props

    return {
      id: input.id,
      patch,
      ...(input.label === undefined ? {} : { text: textToRich(input.label, !arrow) }),
    }
  })
  return { update }
}

export function planRemove(session: DocSession, ids: readonly string[]): EditBatch {
  checkSize(ids.length)
  for (const id of ids) if (!session.objects.has(id)) throw new PlanError(`no object with id ${id}`)
  return { remove: [...new Set(ids)] }
}

// --- apply_diagram ------------------------------------------------------------------------

export type DiagramPlan = {
  batch: EditBatch
  /** Spec key to the id it already had on the board, for nodes that were matched. */
  matched: Record<string, string>
  /** Edges that already existed and were updated rather than drawn again. */
  existingEdges: string[]
}

function label(session: DocSession, id: string): string {
  const map = session.objects.get(id)
  const text = map?.get('text')
  return text === undefined || text === null
    ? ''
    : fragmentToPlainText(text as Parameters<typeof fragmentToPlainText>[0])
}

const norm = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

/**
 * A spec to a batch that adds what is missing and updates what is there.
 *
 * A spec key is matched to an existing object by id first, then by its label when
 * exactly one shape on the board carries that label; anything else is new. An edge
 * already drawn between the same two nodes in the same direction is updated rather than
 * drawn twice. Nothing on the board that the spec does not mention is touched: removing
 * is `delete_objects`, never a side effect of a diagram.
 */
export async function planDiagram(
  session: DocSession,
  spec: DiagramSpec,
  placement?: { x: number; y: number },
): Promise<DiagramPlan> {
  checkSize(spec.nodes.length + spec.edges.length)

  const byLabel = new Map<string, string[]>()
  const bindingsByArrow = new Map<string, { start: string | null; end: string | null }>()
  for (const [id, map] of session.objects.entries()) {
    const type = String(map.get('type'))
    if (type === 'arrow' || type === 'line' || type === 'freedraw') continue
    const key = norm(label(session, id))
    if (key === '') continue
    byLabel.set(key, [...(byLabel.get(key) ?? []), id])
  }
  for (const map of session.bindings.values()) {
    const arrowId = String(map.get('arrowId'))
    const entry = bindingsByArrow.get(arrowId) ?? { start: null, end: null }
    entry[map.get('end') === 'end' ? 'end' : 'start'] =
      (map.get('targetId') as string | null) ?? null
    bindingsByArrow.set(arrowId, entry)
  }

  const matched: Record<string, string> = {}
  const fresh: NodeInput[] = []
  const updates: UpdateInput[] = []
  const seen = new Set<string>()

  for (const node of spec.nodes) {
    if (seen.has(node.key)) throw new PlanError(`node key used twice: ${node.key}`)
    seen.add(node.key)
    const byId = session.objects.has(node.key) ? node.key : undefined
    const candidates = node.label === undefined ? [] : (byLabel.get(norm(node.label)) ?? [])
    const existing = byId ?? (candidates.length === 1 ? candidates[0] : undefined)
    if (existing !== undefined) {
      matched[node.key] = existing
      if (node.label !== undefined && norm(node.label) !== norm(label(session, existing))) {
        updates.push({ id: existing, label: node.label })
      }
      continue
    }
    fresh.push({ ref: node.key, type: node.type, label: node.label ?? node.key })
  }

  const resolve = (key: string): string => {
    if (matched[key] !== undefined) return matched[key]
    if (seen.has(key)) return key
    if (session.objects.has(key)) return key
    // An edge naming a node the spec never declared is a node with that name.
    seen.add(key)
    fresh.push({ ref: key, label: key })
    return key
  }

  const existingEdges: string[] = []
  const newEdges: EdgeInput[] = []
  spec.edges.forEach((edge) => {
    const from = resolve(edge.from)
    const to = resolve(edge.to)
    const already = [...bindingsByArrow].find(([, ends]) => ends.start === from && ends.end === to)
    if (already !== undefined) {
      existingEdges.push(already[0])
      const current = label(session, already[0])
      if (edge.label !== undefined && edge.label !== current)
        updates.push({ id: already[0], label: edge.label })
      return
    }
    newEdges.push({
      from,
      to,
      ...(edge.label === undefined ? {} : { label: edge.label }),
      ...(edge.direction === undefined ? {} : { direction: edge.direction }),
      ...(edge.type === undefined ? {} : { type: edge.type }),
    })
  })

  const created = await planCreate(session, fresh, newEdges, {
    direction: spec.direction ?? 'LR',
    placement,
    routing: 'orthogonal',
  })
  const updated = planUpdate(session, updates)
  return {
    batch: { create: created.create, connect: created.connect, update: updated.update },
    matched,
    existingEdges,
  }
}
