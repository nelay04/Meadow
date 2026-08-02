/**
 * Reading the document from React.
 *
 * `useSyncExternalStore`, never `useState`. Copying Y data into React state creates a
 * second copy that drifts the moment a remote update arrives, and no amount of
 * `useEffect` fixes that reliably. The Y.Doc stays the single source of truth and
 * React subscribes to it.
 *
 * The snapshot is cached and rebuilt only when the map actually changes.
 * `getSnapshot` must return a referentially stable value between changes, or React
 * re-renders forever.
 */

import { useMemo, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

import type { DocSession } from './mutations'
import type { CanvasObject } from './schema'

function readAll(objects: Y.Map<Y.Map<unknown>>): CanvasObject[] {
  const out: CanvasObject[] = []
  for (const [id, object] of objects.entries()) {
    out.push({
      id,
      type: object.get('type') as CanvasObject['type'],
      x: Number(object.get('x') ?? 0),
      y: Number(object.get('y') ?? 0),
      w: Number(object.get('w') ?? 0),
      h: Number(object.get('h') ?? 0),
      rotation: Number(object.get('rotation') ?? 0),
      opacity: Number(object.get('opacity') ?? 1),
      locked: Boolean(object.get('locked') ?? false),
      parentId: (object.get('parentId') as string | null) ?? null,
    })
  }
  return out
}

function createObjectStore(session: DocSession) {
  let snapshot = readAll(session.objects)
  const listeners = new Set<() => void>()

  const onChange = (): void => {
    snapshot = readAll(session.objects)
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void): () => void {
      // observeDeep, not observe: a nested Y.Map field change (a move) does not fire
      // the top-level map's observer.
      if (listeners.size === 0) session.objects.observeDeep(onChange)
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) session.objects.unobserveDeep(onChange)
      }
    },
    getSnapshot: (): CanvasObject[] => snapshot,
  }
}

export function useObjects(session: DocSession): readonly CanvasObject[] {
  const store = useMemo(() => createObjectStore(session), [session])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}
