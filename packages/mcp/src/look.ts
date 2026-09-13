/**
 * A picture to go with a tool result: what a write just did, or what a preview would do.
 *
 * Attached to writes by default so that looking at the result is the ordinary path
 * rather than an extra call a model has to remember. A diagram that reads fine as nodes
 * and edges can still come out cramped or crossed on the canvas, and the only reliable
 * way to catch that is to look.
 *
 * A preview is drawn from a copy: the plan is applied to a fresh Y.Doc built from the
 * glade's current state, drawn, and thrown away. Nothing is sent, and the copy never has
 * a provider, so it cannot sync. The copy is an owner session only so `applyEdits` will
 * run on it; whether the caller could apply the write for real is decided, and reported,
 * by the preview itself.
 */

import { type GladeBoard, gladeToGraph } from '@meadow/schema'
import * as Y from 'yjs'

import { exportGlade } from '../../../apps/web/src/doc/interchange'
import {
  type DocSession,
  type EditBatch,
  type EditResult,
  applyEdits,
  createDocSession,
} from '../../../apps/web/src/doc/mutations'
import type { Rect } from './route'
import { type Theme, rasterize, renderSnapshot } from './snapshot'
import { VERSION } from './version'

export function previewCopy(
  session: DocSession,
  batch: EditBatch,
): { copy: DocSession; result: EditResult } {
  const doc = new Y.Doc()
  Y.applyUpdate(doc, Y.encodeStateAsUpdate(session.doc))
  const copy = createDocSession(doc, 'owner')
  return { copy, result: applyEdits(copy, batch) }
}

export type LookOptions = {
  ids?: readonly string[]
  region?: Rect
  maxWidth?: number
  theme?: Theme
  includeGraph?: boolean
}

export type Look = {
  image: { type: 'image'; data: string; mimeType: 'image/png' }
  details: {
    width: number
    height: number
    world_bounds: Rect
    pixels_per_unit: number
    drawn: number
    skipped?: number
    hint?: string
    graph?: { nodes: unknown[]; edges: unknown[] }
  }
}

export async function lookAt(
  session: DocSession,
  board: GladeBoard,
  options: LookOptions = {},
): Promise<Look> {
  const file = exportGlade(session, board, { app: `meadow-mcp ${VERSION}` })
  const picture = renderSnapshot(file, {
    ids: options.ids,
    region: options.region,
    maxWidth: options.maxWidth,
    theme: options.theme,
  })
  const png = await rasterize(picture)
  const shown = new Set(picture.ids)
  const graph = options.includeGraph === true ? gladeToGraph(file) : null
  return {
    image: { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
    details: {
      width: picture.width,
      height: picture.height,
      world_bounds: picture.bounds,
      pixels_per_unit: picture.scale,
      drawn: picture.drawn,
      ...(picture.skipped > 0
        ? { skipped: picture.skipped, hint: 'Too many objects; narrow it with region or ids.' }
        : {}),
      ...(graph === null
        ? {}
        : {
            graph: {
              nodes: graph.nodes.filter((node) => shown.has(node.id)),
              edges: graph.edges.filter((edge) => shown.has(edge.id)),
            },
          }),
    },
  }
}
