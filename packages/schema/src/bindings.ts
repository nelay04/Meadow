/**
 * Arrow-to-object attachments. ARCHITECTURE 4.
 *
 * Arrows store a binding rather than absolute endpoints, so an arrow follows its
 * target when the target moves. `targetId: null` is a free-floating endpoint, which
 * is also what a binding becomes when its target is deleted - the arrow survives with
 * a loose end rather than vanishing.
 *
 * Bindings are M4 work. The schema is here now because ARCHITECTURE 4 is locked and
 * adding a root to a live document later is the expensive kind of change.
 */

import * as Y from 'yjs'
import { z } from 'zod'

export const bindingEnd = z.enum(['start', 'end'])
export type BindingEnd = z.infer<typeof bindingEnd>

export const bindingData = z.object({
  id: z.string().min(1),
  arrowId: z.string().min(1),
  end: bindingEnd,
  targetId: z.string().nullable().default(null),
  // Normalised 0..1 within the target's bounds, so the anchor survives a resize.
  anchor: z.object({ nx: z.number(), ny: z.number() }).default({ nx: 0.5, ny: 0.5 }),
  // Standoff from the target edge, in world px.
  gap: z.number().default(4),
})

export type BindingData = z.infer<typeof bindingData>

export function createBindingMap(data: BindingData): Y.Map<unknown> {
  const map = new Y.Map<unknown>()
  map.set('id', data.id)
  map.set('arrowId', data.arrowId)
  map.set('end', data.end)
  map.set('targetId', data.targetId)
  map.set('anchorX', data.anchor.nx)
  map.set('anchorY', data.anchor.ny)
  map.set('gap', data.gap)
  return map
}

export function readBinding(map: Y.Map<unknown>): BindingData {
  return {
    id: String(map.get('id') ?? ''),
    arrowId: String(map.get('arrowId') ?? ''),
    end: (map.get('end') ?? 'start') as BindingEnd,
    targetId: (map.get('targetId') as string | null) ?? null,
    anchor: { nx: Number(map.get('anchorX') ?? 0.5), ny: Number(map.get('anchorY') ?? 0.5) },
    gap: Number(map.get('gap') ?? 4),
  }
}
