/**
 * Two tools for a diagram already on a glade: one that says what is wrong with its
 * layout, and one that fixes it.
 *
 * `checkLayout` reads the document the way a person looks at the canvas: text spilling
 * out of a shape, shapes on top of each other, a line through a shape it does not
 * connect, two lines drawn as one, a label on a label. A model cannot see the canvas, so
 * without this it has no way to know its diagram came out badly.
 *
 * `planTidy` lays a set of shapes out again with the same layered layout and edge router
 * new diagrams get, grows shapes whose text does not fit, and re-attaches their arrows.
 * It is a plan like every other write: nothing is applied here.
 */

import { type ObjectData, isArrowLike, readObject } from '@meadow/schema'

import type {
  DocSession,
  EditBatch,
  EditConnect,
  EditUpdate,
} from '../../../apps/web/src/doc/mutations'
import { fragmentToPlainText } from '../../../apps/web/src/doc/richText'
import { layoutBlock } from './layout'
import type { DiagramDirection, SpecNodeType } from './mermaid'
import { PlanError, arrowEnds, boardNodes, boardObstacles, drawnPoints } from './plan'
import {
  type Rect,
  type RouteEdge,
  asObject,
  labelBoxOf,
  overlapLength,
  rectsOverlap,
  routeEdges,
  segmentHitsRect,
  segmentsOf,
} from './route'
import { MIN_SIZES, edgeLabelSize, fitNodeSize } from './sizing'

const plain = (session: DocSession, id: string): string => {
  const text = session.objects.get(id)?.get('text')
  return text === undefined || text === null
    ? ''
    : fragmentToPlainText(text as Parameters<typeof fragmentToPlainText>[0])
}

const fits = (type: string): type is SpecNodeType =>
  type in MIN_SIZES && type !== 'text' && type !== 'sticky'

const fontSizeOf = (object: ObjectData): number | undefined =>
  typeof object.props.fontSize === 'number' ? object.props.fontSize : undefined

// --- check -----------------------------------------------------------------------------

export type LayoutIssue =
  | {
      kind: 'text_overflow'
      id: string
      label: string
      size: [number, number]
      needs: [number, number]
    }
  | { kind: 'shapes_overlap'; ids: [string, string] }
  | { kind: 'edge_through_shape'; edge: string; shape: string }
  | { kind: 'edges_overlap'; edges: [string, string]; length: number }
  | { kind: 'label_collision'; edge: string; with: string }
  | { kind: 'free_end'; edge: string; end: 'start' | 'end' }

export type LayoutReport = {
  checked: { shapes: number; edges: number }
  counts: Record<LayoutIssue['kind'], number>
  issues: LayoutIssue[]
  truncated: boolean
}

const MAX_ISSUES = 60

export function checkLayout(session: DocSession, ids?: readonly string[]): LayoutReport {
  const only = ids === undefined || ids.length === 0 ? null : new Set(ids)
  const nodes = boardNodes(session)
  const ends = arrowEnds(session)
  const issues: LayoutIssue[] = []
  const counts: LayoutReport['counts'] = {
    text_overflow: 0,
    shapes_overlap: 0,
    edge_through_shape: 0,
    edges_overlap: 0,
    label_collision: 0,
    free_end: 0,
  }
  const add = (issue: LayoutIssue): void => {
    counts[issue.kind] += 1
    if (issues.length < MAX_ISSUES) issues.push(issue)
  }

  const shapes = [...nodes.values()].filter((node) => only === null || only.has(node.id))
  for (const node of shapes) {
    if (!fits(node.type)) continue
    const label = plain(session, node.id)
    if (label.trim() === '') continue
    const needs = fitNodeSize(node.type, label, { fontSize: fontSizeOf(node) })
    // A little slack: the estimate errs large, and a shape a few units short still reads.
    if (needs.w > node.w + 12 || needs.h > node.h + 12) {
      add({
        kind: 'text_overflow',
        id: node.id,
        label: label.split('\n')[0],
        size: [Math.round(node.w), Math.round(node.h)],
        needs: [Math.max(needs.w, Math.round(node.w)), Math.max(needs.h, Math.round(node.h))],
      })
    }
  }
  const box = (o: ObjectData): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h })
  for (let i = 0; i < shapes.length; i += 1) {
    for (let j = i + 1; j < shapes.length; j += 1) {
      const a = shapes[i]
      const b = shapes[j]
      if (a.parentId === b.id || b.parentId === a.id) continue
      if (rectsOverlap(box(a), box(b))) add({ kind: 'shapes_overlap', ids: [a.id, b.id] })
    }
  }

  type Drawn = { id: string; segments: number[][]; label: Rect | null }
  const drawn: Drawn[] = []
  for (const [id, map] of session.objects.entries()) {
    const object = readObject(map)
    if (!isArrowLike(object.type)) continue
    const bound = ends.get(id) ?? { start: null, end: null }
    if (
      only !== null &&
      !only.has(id) &&
      !(bound.start && only.has(bound.start)) &&
      !(bound.end && only.has(bound.end))
    )
      continue
    const points = drawnPoints(object)
    drawn.push({
      id,
      segments: segmentsOf(points),
      label: labelBoxOf(points, edgeLabelSize(plain(session, id))),
    })
    if (bound.start === null) add({ kind: 'free_end', edge: id, end: 'start' })
    if (bound.end === null) add({ kind: 'free_end', edge: id, end: 'end' })

    for (const node of nodes.values()) {
      if (node.id === bound.start || node.id === bound.end) continue
      const inner = { x: node.x + 3, y: node.y + 3, w: node.w - 6, h: node.h - 6 }
      if (segmentsOf(points).some((segment) => segmentHitsRect(segment, inner))) {
        add({ kind: 'edge_through_shape', edge: id, shape: node.id })
      }
    }
  }

  for (let i = 0; i < drawn.length; i += 1) {
    const a = drawn[i]
    for (let j = i + 1; j < drawn.length; j += 1) {
      const b = drawn[j]
      let shared = 0
      for (const sa of a.segments) for (const sb of b.segments) shared += overlapLength(sa, sb, 3)
      if (shared > 20)
        add({ kind: 'edges_overlap', edges: [a.id, b.id], length: Math.round(shared) })
      if (a.label !== null && b.label !== null && rectsOverlap(a.label, b.label)) {
        add({ kind: 'label_collision', edge: a.id, with: b.id })
      }
    }
    if (a.label === null) continue
    for (const node of nodes.values()) {
      if (rectsOverlap(a.label, box(node)))
        add({ kind: 'label_collision', edge: a.id, with: node.id })
    }
  }

  return {
    checked: { shapes: shapes.length, edges: drawn.length },
    counts,
    issues,
    truncated: Object.values(counts).reduce((sum, n) => sum + n, 0) > issues.length,
  }
}

// --- tidy ------------------------------------------------------------------------------

export type TidyOptions = {
  ids?: readonly string[]
  direction?: DiagramDirection
  /** Top-left of the tidied block. Where the shapes already start, by default. */
  placement?: { x: number; y: number }
  /** Re-lay positions. False keeps every shape where it is and only resizes and re-routes. */
  move?: boolean
}

export async function planTidy(session: DocSession, options: TidyOptions = {}): Promise<EditBatch> {
  const all = boardNodes(session)
  const ends = arrowEnds(session)

  // The shapes in scope: those named, or every shape an arrow is attached to.
  let scope: Set<string>
  if (options.ids !== undefined && options.ids.length > 0) {
    scope = new Set()
    for (const id of options.ids) {
      if (!session.objects.has(id)) throw new PlanError(`no object with id ${id}`)
      if (all.has(id)) scope.add(id)
    }
  } else {
    scope = new Set()
    for (const { start, end } of ends.values()) {
      if (start !== null && all.has(start)) scope.add(start)
      if (end !== null && all.has(end)) scope.add(end)
    }
  }
  if (scope.size === 0) throw new PlanError('nothing to tidy: no shapes connected by arrows')

  // Arrows with both ends in scope. Curved ones keep their bow; they are re-attached only.
  const arrows: { id: string; from: string; to: string; routing: string }[] = []
  for (const [id, bound] of ends) {
    if (bound.start === null || bound.end === null) continue
    if (!scope.has(bound.start) || !scope.has(bound.end) || bound.start === bound.end) continue
    const map = session.objects.get(id)
    if (map === undefined) continue
    const object = readObject(map)
    if (!isArrowLike(object.type)) continue
    const routing = typeof object.props.routing === 'string' ? object.props.routing : 'straight'
    arrows.push({ id, from: bound.start, to: bound.end, routing })
  }

  // Sizes: grown to fit, never shrunk. A shape somebody made big on purpose stays big.
  const update: EditUpdate[] = []
  const boxes = new Map<string, Rect>()
  for (const id of scope) {
    const node = all.get(id)!
    let { w, h } = node
    if (fits(node.type) && node.rotation === 0) {
      const needs = fitNodeSize(node.type, plain(session, id), { fontSize: fontSizeOf(node) })
      w = Math.max(w, needs.w)
      h = Math.max(h, needs.h)
    }
    boxes.set(id, { x: node.x, y: node.y, w, h })
  }

  if (options.move !== false) {
    const current = [...scope].map((id) => all.get(id)!)
    const origin = options.placement ?? {
      x: Math.round(Math.min(...current.map((node) => node.x))),
      y: Math.round(Math.min(...current.map((node) => node.y))),
    }
    const placed = await layoutBlock(
      [...boxes].map(([key, box]) => ({ key, w: box.w, h: box.h })),
      arrows.map((arrow) => ({
        from: arrow.from,
        to: arrow.to,
        label: edgeLabelSize(plain(session, arrow.id)),
      })),
      options.direction ?? 'LR',
      origin,
    )
    for (const [id, box] of boxes) Object.assign(box, placed[id])
  }

  for (const [id, box] of boxes) {
    const node = all.get(id)!
    const patch: Partial<ObjectData> = {}
    if (Math.round(node.x) !== box.x) patch.x = box.x
    if (Math.round(node.y) !== box.y) patch.y = box.y
    if (node.w !== box.w) patch.w = box.w
    if (node.h !== box.h) patch.h = box.h
    if (Object.keys(patch).length > 0) update.push({ id, patch })
  }

  // Route against the new geometry: the tidied shapes where they are going, everything
  // else where it is, and arrows outside the set as lines to stay off.
  const geometry = new Map(all)
  for (const [id, box] of boxes)
    geometry.set(id, { ...asObject(id, all.get(id)!.type, box), props: all.get(id)!.props })
  const routed = arrows.filter((arrow) => arrow.routing !== 'curved')
  const toRoute: RouteEdge[] = routed.map((arrow) => ({
    key: arrow.id,
    from: arrow.from,
    to: arrow.to,
    label: edgeLabelSize(plain(session, arrow.id)),
    routing: arrow.routing === 'straight' ? 'straight' : 'orthogonal',
  }))
  const routes = routeEdges(
    geometry,
    toRoute,
    boardObstacles(session, new Set(arrows.map((arrow) => arrow.id))),
  )

  const connect: EditConnect[] = []
  for (const arrow of arrows) {
    const route = routes.get(arrow.id)
    if (route === undefined) {
      // Re-attached at the centre, so a curved arrow aims at the shape's new position.
      connect.push(
        { arrow: arrow.id, end: 'start', target: arrow.from },
        { arrow: arrow.id, end: 'end', target: arrow.to },
      )
      continue
    }
    // The stored waypoints go too. A straight arrow keeps whatever points it has and only
    // moves its ends, so an elbow turned straight would otherwise keep its old corners.
    update.push({
      id: arrow.id,
      patch: { props: { routing: route.routing, elbow: route.elbow, points: [0, 0, 1, 0] } },
    })
    connect.push(
      { arrow: arrow.id, end: 'start', target: arrow.from, anchor: route.start },
      { arrow: arrow.id, end: 'end', target: arrow.to, anchor: route.end },
    )
  }
  return { update, connect }
}
