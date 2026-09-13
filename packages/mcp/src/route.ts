/**
 * Where each arrow attaches and where it bends, chosen so the drawn result is clean.
 *
 * The canvas draws an orthogonal arrow as one Z between its two endpoints: it leaves
 * along whichever axis the endpoints are further apart on and turns once, at a stored
 * fraction (`elbow`). It does not avoid shapes, and every centre-anchored arrow on a
 * side meets it at the same point. Left alone, a diagram's edges share trunks, stack
 * their labels and run through whatever sits between two columns.
 *
 * The canvas cannot draw a better route, but it can be handed better inputs: which side
 * of each shape an edge uses, where along that side (a binding anchor), and where the Z
 * turns. This picks those. Sides first, then ports spread along each side in the order
 * of what they lead to so neighbours do not cross, then per edge a bend chosen from a
 * handful of candidates. Each candidate is scored on the path `solveArrowEnds` will
 * actually produce, the same function the document's reflow runs, so what is scored
 * here is what gets drawn: a crossed shape, a shared segment, a label on a label.
 */

import {
  type ObjectData,
  type Point,
  objectData,
  pointAlongPath,
  solveArrowEnds,
} from '@meadow/schema'

export type Rect = { x: number; y: number; w: number; h: number }
export type Anchor = { nx: number; ny: number }
export type Side = 'left' | 'right' | 'top' | 'bottom'

export type RouteEdge = {
  key: string
  from: string
  to: string
  /** The label's plate, or zero when it has none. */
  label: { w: number; h: number }
  routing: 'orthogonal' | 'straight'
}

export type Route = {
  routing: 'orthogonal' | 'straight'
  elbow: number
  start: Anchor
  end: Anchor
  /** Absolute points, as drawn. */
  points: number[]
  labelBox: Rect | null
}

export type Obstacles = {
  /** Segments already on the board, as [x0, y0, x1, y1]. */
  segments: number[][]
  labels: Rect[]
}

const GAP = 4
const ELBOWS = [0.5, 0.35, 0.65, 0.25, 0.75, 0.42, 0.58, 0.15, 0.85]

// Costs. Relative sizes are what matter: crossing a shape is never worth a shorter path.
const COST_NODE_HIT = 1000
const COST_WRONG_WAY = 700
const COST_LABEL_ON_NODE = 800
const COST_LABEL_ON_LABEL = 600
const COST_OVERLAP_PER_PX = 4
const COST_CROSSING = 35
const COST_LABEL_ON_LINE = 40
const COST_DIAGONAL = 180
const COST_BEND = 8
const COST_LENGTH = 0.04

export function asObject(id: string, type: string, box: Rect): ObjectData {
  return objectData.parse({ id, type, x: box.x, y: box.y, w: box.w, h: box.h })
}

const centre = (o: ObjectData): Point => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 })

/**
 * A point on the shape's outline on one side, `t` of the way along it (0..1), as an
 * anchor. On a rectangle that is the box edge; on a diamond or an ellipse the box edge
 * is air, and an anchor there would leave the arrow stopping short of the shape.
 */
export function sideAnchor(o: ObjectData, side: Side, t: number): Anchor {
  const vertical = side === 'left' || side === 'right'
  const sign = side === 'right' || side === 'bottom' ? 1 : -1
  // Offset from the side's middle, -0.5..0.5 of the side's length.
  const u = t - 0.5
  let reach = 0.5
  switch (o.type) {
    case 'diamond':
      reach = 0.5 - Math.abs(u)
      break
    case 'ellipse':
    case 'polygon':
      reach = 0.5 * Math.sqrt(Math.max(0, 1 - (2 * u) ** 2))
      break
    case 'cylinder':
      if (!vertical) reach = 0.5 - 0.1 * (1 - Math.sqrt(Math.max(0, 1 - (2 * u) ** 2)))
      break
    case 'parallelogram':
      // The slanted pair, at its average reach: close enough for a gap of four pixels.
      if (vertical) reach = 0.5 - (Math.min(o.w, o.h) * 0.3) / o.w / 2
      break
    case 'trapezoid':
      // Narrower at the top, so a port higher up the side sits further in.
      if (vertical) reach = 0.5 - ((Math.min(o.w, o.h) * 0.2) / o.w) * (1 - t)
      break
    case 'triangle':
      // The apex is at the top, so the slanted sides reach further out lower down.
      if (vertical) reach = 0.5 * t
      break
  }
  return vertical ? { nx: 0.5 + sign * reach, ny: t } : { nx: t, ny: 0.5 + sign * reach }
}

/** How far along a side ports may be spread, per shape: corners of a diamond are no place to land. */
function spreadRange(type: string): [number, number] {
  switch (type) {
    case 'diamond':
    case 'triangle':
      return [0.38, 0.62]
    case 'ellipse':
    case 'polygon':
      return [0.28, 0.72]
    default:
      return [0.18, 0.82]
  }
}

const outward: Record<Side, Point> = {
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
  top: { x: 0, y: -1 },
  bottom: { x: 0, y: 1 },
}

function facingSides(a: ObjectData, b: ObjectData, axis: 'x' | 'y'): [Side, Side] {
  const ca = centre(a)
  const cb = centre(b)
  if (axis === 'x') return cb.x >= ca.x ? ['right', 'left'] : ['left', 'right']
  return cb.y >= ca.y ? ['bottom', 'top'] : ['top', 'bottom']
}

/** The space between two boxes along an axis; negative when they overlap on it. */
function clearance(a: ObjectData, b: ObjectData, axis: 'x' | 'y'): number {
  return axis === 'x'
    ? Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w))
    : Math.max(b.y - (a.y + a.h), a.y - (b.y + b.h))
}

// --- geometry ----------------------------------------------------------------------------

export function segmentsOf(points: readonly number[]): number[][] {
  const out: number[][] = []
  for (let i = 0; i + 3 < points.length; i += 2) {
    out.push([points[i], points[i + 1], points[i + 2], points[i + 3]])
  }
  return out
}

const inflate = (r: Rect, by: number): Rect => ({
  x: r.x - by,
  y: r.y - by,
  w: r.w + by * 2,
  h: r.h + by * 2,
})

export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

/** Does a segment pass through a rectangle's interior (Liang-Barsky clip)? */
export function segmentHitsRect(s: readonly number[], r: Rect): boolean {
  const [x0, y0, x1, y1] = s
  const dx = x1 - x0
  const dy = y1 - y0
  let t0 = 0
  let t1 = 1
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q > 0
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
    return true
  }
  if (
    clip(-dx, x0 - r.x) &&
    clip(dx, r.x + r.w - x0) &&
    clip(-dy, y0 - r.y) &&
    clip(dy, r.y + r.h - y0)
  ) {
    return t1 - t0 > 1e-6 && Math.hypot(dx, dy) * (t1 - t0) > 1
  }
  return false
}

/** Length two axis-aligned segments run on top of each other. */
export function overlapLength(a: readonly number[], b: readonly number[], tolerance = 5): number {
  const aH = Math.abs(a[1] - a[3]) < 0.5
  const bH = Math.abs(b[1] - b[3]) < 0.5
  const aV = Math.abs(a[0] - a[2]) < 0.5
  const bV = Math.abs(b[0] - b[2]) < 0.5
  if (aH && bH && Math.abs(a[1] - b[1]) <= tolerance) {
    const lo = Math.max(Math.min(a[0], a[2]), Math.min(b[0], b[2]))
    const hi = Math.min(Math.max(a[0], a[2]), Math.max(b[0], b[2]))
    return Math.max(0, hi - lo)
  }
  if (aV && bV && Math.abs(a[0] - b[0]) <= tolerance) {
    const lo = Math.max(Math.min(a[1], a[3]), Math.min(b[1], b[3]))
    const hi = Math.min(Math.max(a[1], a[3]), Math.max(b[1], b[3]))
    return Math.max(0, hi - lo)
  }
  return 0
}

export function segmentsCross(a: readonly number[], b: readonly number[]): boolean {
  const d = (a[2] - a[0]) * (b[3] - b[1]) - (a[3] - a[1]) * (b[2] - b[0])
  if (Math.abs(d) < 1e-9) return false
  const t = ((b[0] - a[0]) * (b[3] - b[1]) - (b[1] - a[1]) * (b[2] - b[0])) / d
  const u = ((b[0] - a[0]) * (a[3] - a[1]) - (b[1] - a[1]) * (a[2] - a[0])) / d
  return t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98
}

export function labelBoxOf(
  points: readonly number[],
  label: { w: number; h: number },
): Rect | null {
  if (label.w === 0) return null
  const mid = pointAlongPath(points, 0.5)
  return { x: mid.x - label.w / 2, y: mid.y - label.h / 2, w: label.w, h: label.h }
}

// --- scoring ---------------------------------------------------------------------------

type Candidate = {
  routing: 'orthogonal' | 'straight'
  elbow: number
  start: Anchor
  end: Anchor
  startSide: Side
  endSide: Side
}

function simulate(a: ObjectData, b: ObjectData, candidate: Candidate): number[] {
  return solveArrowEnds(
    [a.x, a.y, b.x, b.y],
    a,
    { anchor: candidate.start, gap: GAP },
    b,
    { anchor: candidate.end, gap: GAP },
    candidate.routing,
    candidate.elbow,
  )
}

function score(
  points: readonly number[],
  candidate: Candidate,
  edge: RouteEdge,
  a: ObjectData,
  b: ObjectData,
  nodes: readonly ObjectData[],
  placed: Obstacles,
  preferOrthogonal: boolean,
): number {
  const segments = segmentsOf(points)
  let cost = 0
  const boxOf = (o: ObjectData): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h })

  segments.forEach((s, index) => {
    for (const node of nodes) {
      if (node.id === a.id || node.id === b.id) continue
      if (segmentHitsRect(s, inflate(boxOf(node), 6))) cost += COST_NODE_HIT
    }
    // Back through its own ends: a segment after the first inside the start shape, or one
    // before the last inside the end shape.
    if (index > 0 && segmentHitsRect(s, inflate(boxOf(a), -1))) cost += COST_NODE_HIT
    if (index < segments.length - 1 && segmentHitsRect(s, inflate(boxOf(b), -1)))
      cost += COST_NODE_HIT
    for (const other of placed.segments) {
      cost += overlapLength(s, other) * COST_OVERLAP_PER_PX
      if (segmentsCross(s, other)) cost += COST_CROSSING
    }
    cost += Math.hypot(s[2] - s[0], s[3] - s[1]) * COST_LENGTH
  })
  cost += (segments.length - 1) * COST_BEND

  // Leaving a side it is not facing: an elbow that runs along its own shape's edge.
  const first = segments[0]
  const last = segments[segments.length - 1]
  const out = outward[candidate.startSide]
  const into = outward[candidate.endSide]
  if ((first[2] - first[0]) * out.x + (first[3] - first[1]) * out.y <= 0) cost += COST_WRONG_WAY
  if ((last[2] - last[0]) * -into.x + (last[3] - last[1]) * -into.y <= 0) cost += COST_WRONG_WAY

  const diagonal = segments.some((s) => Math.abs(s[0] - s[2]) > 1 && Math.abs(s[1] - s[3]) > 1)
  if (diagonal && preferOrthogonal) cost += COST_DIAGONAL

  const labelBox = labelBoxOf(points, edge.label)
  if (labelBox !== null) {
    for (const node of nodes) {
      if (rectsOverlap(labelBox, inflate(boxOf(node), 4))) cost += COST_LABEL_ON_NODE
    }
    for (const other of placed.labels) {
      if (rectsOverlap(labelBox, inflate(other, 3))) cost += COST_LABEL_ON_LABEL
    }
    for (const other of placed.segments) {
      if (segmentHitsRect(other, labelBox)) cost += COST_LABEL_ON_LINE
    }
  }
  return cost
}

// --- the router ------------------------------------------------------------------------

/**
 * Routes for a set of edges. `nodes` is every shape the routes must respect, the edges'
 * ends included; `obstacles` are lines and labels already on the board that stay put.
 */
export function routeEdges(
  nodes: ReadonlyMap<string, ObjectData>,
  edges: readonly RouteEdge[],
  obstacles: Obstacles = { segments: [], labels: [] },
): Map<string, Route> {
  const list = [...nodes.values()]
  const routes = new Map<string, Route>()
  const usable = edges.filter(
    (edge) => edge.from !== edge.to && nodes.has(edge.from) && nodes.has(edge.to),
  )

  // Relevant obstacles only: a board with thousands of shapes should not cost thousands
  // of checks per candidate for edges drawn in one corner of it.
  const near = (edge: RouteEdge): ObjectData[] => {
    const a = nodes.get(edge.from)!
    const b = nodes.get(edge.to)!
    const margin = 400
    const area: Rect = {
      x: Math.min(a.x, b.x) - margin,
      y: Math.min(a.y, b.y) - margin,
      w: Math.max(a.x + a.w, b.x + b.w) - Math.min(a.x, b.x) + margin * 2,
      h: Math.max(a.y + a.h, b.y + b.h) - Math.min(a.y, b.y) + margin * 2,
    }
    return list.filter((node) => rectsOverlap(area, node))
  }

  // Shortest first: they have the fewest ways to go, so they choose before the long ones.
  const order = [...usable].sort((p, q) => span(p) - span(q))
  function span(edge: RouteEdge): number {
    const a = centre(nodes.get(edge.from)!)
    const b = centre(nodes.get(edge.to)!)
    return Math.abs(a.x - b.x) + Math.abs(a.y - b.y)
  }

  // 1. Sides, and roughly where on each side. The canvas turns a Z along whichever axis
  // its endpoints are further apart on, so a pair of sides only draws as meant when the
  // ports sit where that axis wins: sliding them towards each other along their sides
  // is often what turns a would-be diagonal into a clean elbow.
  const sides = new Map<string, [Side, Side]>()
  const wanted = new Map<string, number>()
  {
    const trial: Obstacles = { segments: [...obstacles.segments], labels: [...obstacles.labels] }
    for (const edge of order) {
      const a = nodes.get(edge.from)!
      const b = nodes.get(edge.to)!
      const local = near(edge)
      const axes: ('x' | 'y')[] =
        clearance(a, b, 'x') >= clearance(a, b, 'y') ? ['x', 'y'] : ['y', 'x']
      type Best = { cost: number; pair: [Side, Side]; ts: [number, number]; points: number[] }
      let best: Best | null = null
      axes.forEach((axis, rank) => {
        const pair = facingSides(a, b, axis)
        const [loA, hiA] = spreadRange(a.type)
        const [loB, hiB] = spreadRange(b.type)
        for (const ta of [0.5, loA, hiA]) {
          for (const tb of [0.5, loB, hiB]) {
            for (const elbow of ELBOWS.slice(0, 5)) {
              const candidate: Candidate = {
                routing: edge.routing,
                elbow,
                start: sideAnchor(a, pair[0], ta),
                end: sideAnchor(b, pair[1], tb),
                startSide: pair[0],
                endSide: pair[1],
              }
              const points = simulate(a, b, candidate)
              const offCentre = (Math.abs(ta - 0.5) + Math.abs(tb - 0.5)) * 20
              const cost =
                score(points, candidate, edge, a, b, local, trial, edge.routing === 'orthogonal') +
                rank * 60 +
                offCentre
              if (best === null || cost < best.cost) best = { cost, pair, ts: [ta, tb], points }
            }
          }
        }
      })
      const chosen = best as Best | null
      if (chosen === null) continue
      sides.set(edge.key, chosen.pair)
      wanted.set(`${edge.key}|start`, chosen.ts[0])
      wanted.set(`${edge.key}|end`, chosen.ts[1])
      trial.segments.push(...segmentsOf(chosen.points))
      const label = labelBoxOf(chosen.points, edge.label)
      if (label !== null) trial.labels.push(label)
    }
  }

  // 2. Ports. Every end on the same side of the same shape gets its own place on it,
  // ordered by where the other end is so neighbouring edges do not cross, and centred on
  // where they wanted to be, spaced enough to read apart.
  const ports = new Map<string, Anchor>()
  const portAt = new Map<string, { slot: string; t: number }>()
  const slotTs = new Map<string, number[]>()
  const bySide = new Map<
    string,
    { key: string; end: 'start' | 'end'; along: number; want: number }[]
  >()
  for (const edge of usable) {
    const pair = sides.get(edge.key)!
    for (const end of ['start', 'end'] as const) {
      const self = nodes.get(end === 'start' ? edge.from : edge.to)!
      const other = centre(nodes.get(end === 'start' ? edge.to : edge.from)!)
      const side = end === 'start' ? pair[0] : pair[1]
      const along = side === 'left' || side === 'right' ? other.y : other.x
      const slot = `${self.id}|${side}`
      const want = wanted.get(`${edge.key}|${end}`) ?? 0.5
      bySide.set(slot, [...(bySide.get(slot) ?? []), { key: edge.key, end, along, want }])
    }
  }
  for (const [slot, ends] of bySide) {
    const [id, side] = slot.split('|') as [string, Side]
    const self = nodes.get(id)!
    const [lo, hi] = spreadRange(self.type)
    ends.sort((p, q) => p.along - q.along || p.want - q.want || p.key.localeCompare(q.key))
    const length = side === 'left' || side === 'right' ? self.h : self.w
    // At least 16 units apart where the side allows it, and never more than the side has.
    const step =
      ends.length === 1 ? 0 : Math.min((hi - lo) / (ends.length - 1), Math.max(0.2, 16 / length))
    const mean = ends.reduce((sum, entry) => sum + entry.want, 0) / ends.length
    const first = Math.min(
      Math.max(mean - (step * (ends.length - 1)) / 2, lo),
      hi - step * (ends.length - 1),
    )
    ends.forEach((entry, index) => {
      const t = first + step * index
      ports.set(`${entry.key}|${entry.end}`, sideAnchor(self, side, t))
      portAt.set(`${entry.key}|${entry.end}`, { slot, t })
    })
    slotTs.set(
      slot,
      ends.map((_, index) => first + step * index),
    )
  }

  // 3. Bends, against everything routed so far.
  const placed: Obstacles = { segments: [...obstacles.segments], labels: [...obstacles.labels] }
  for (const edge of order) {
    const a = nodes.get(edge.from)!
    const b = nodes.get(edge.to)!
    const local = near(edge)
    const pair = sides.get(edge.key)!
    const base = {
      start: ports.get(`${edge.key}|start`)!,
      end: ports.get(`${edge.key}|end`)!,
      startSide: pair[0],
      endSide: pair[1],
    }
    // Where each port may move to if its slot leads into something: towards either end of
    // its side, as long as it stays clear of the other ports there.
    const moves = (end: 'start' | 'end'): Anchor[] => {
      const at = portAt.get(`${edge.key}|${end}`)!
      const self = nodes.get(end === 'start' ? edge.from : edge.to)!
      const side = end === 'start' ? pair[0] : pair[1]
      const [lo, hi] = spreadRange(self.type)
      const others = (slotTs.get(at.slot) ?? []).filter((t) => t !== at.t)
      return [at.t, lo, hi, (at.t + lo) / 2, (at.t + hi) / 2]
        .filter((t, index) => index === 0 || others.every((other) => Math.abs(other - t) >= 0.12))
        .map((t) => sideAnchor(self, side, t))
    }
    const candidates: Candidate[] = []
    moves('start').forEach((start, i) =>
      moves('end').forEach((end, j) => {
        for (const elbow of i + j === 0 ? ELBOWS : ELBOWS.slice(0, 5)) {
          candidates.push({ ...base, start, end, routing: edge.routing, elbow })
        }
      }),
    )
    if (edge.routing === 'orthogonal') candidates.push({ ...base, routing: 'straight', elbow: 0.5 })

    let best: { cost: number; candidate: Candidate; points: number[] } | null = null
    for (const candidate of candidates) {
      const points = simulate(a, b, candidate)
      const cost = score(
        points,
        candidate,
        edge,
        a,
        b,
        local,
        placed,
        edge.routing === 'orthogonal',
      )
      const same = (p: Anchor, q: Anchor): boolean => p.nx === q.nx && p.ny === q.ny
      const moved = same(candidate.start, base.start) && same(candidate.end, base.end) ? 0 : 25
      if (best === null || cost + moved < best.cost)
        best = { cost: cost + moved, candidate, points }
    }
    const { candidate, points } = best!
    const labelBox = labelBoxOf(points, edge.label)
    routes.set(edge.key, {
      routing: candidate.routing,
      elbow: candidate.elbow,
      start: candidate.start,
      end: candidate.end,
      points,
      labelBox,
    })
    placed.segments.push(...segmentsOf(points))
    if (labelBox !== null) placed.labels.push(labelBox)
  }
  return routes
}
