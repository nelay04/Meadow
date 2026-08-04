/**
 * Reading the document from React.
 *
 * `useSyncExternalStore`, never `useState`. Copying Y data into React state creates a
 * second copy that drifts the moment a remote update arrives, and no amount of
 * `useEffect` fixes that reliably. The Y.Doc stays the single source of truth and
 * React subscribes to it.
 *
 * The snapshot is cached and rebuilt only when the map actually changes. `getSnapshot`
 * must return a referentially stable value between changes, or React re-renders
 * forever.
 *
 * The canvas does NOT read through this hook. It maintains its own cache from the same
 * observers, because a React render per pointermove would not hold 60fps. This is for
 * chrome around the canvas: counts, inspectors, and the object list.
 */

import { type ObjectData, readObject } from '@meadow/schema'
import { useMemo, useSyncExternalStore } from 'react'
import type * as Y from 'yjs'

import type { DocSession } from './mutations'

/** In z-order, so a list reads top to bottom the way the canvas paints. */
function readAll(session: DocSession): ObjectData[] {
  const out: ObjectData[] = []
  const seen = new Set<string>()

  for (const id of session.order.toArray()) {
    const map = session.objects.get(id)
    if (map === undefined || seen.has(id)) continue
    seen.add(id)
    out.push(readObject(map))
  }

  // Anything missing from `order` still exists and must not vanish from the UI.
  for (const [id, map] of session.objects.entries()) {
    if (!seen.has(id)) out.push(readObject(map))
  }

  return out
}

function createObjectStore(session: DocSession) {
  let snapshot = readAll(session)
  const listeners = new Set<() => void>()

  const onChange = (): void => {
    snapshot = readAll(session)
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void): () => void {
      if (listeners.size === 0) {
        // observeDeep, not observe: a nested Y.Map field change (a move) does not fire
        // the top-level map's observer.
        session.objects.observeDeep(onChange)
        session.order.observe(onChange)
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          session.objects.unobserveDeep(onChange)
          session.order.unobserve(onChange)
        }
      }
    },
    getSnapshot: (): ObjectData[] => snapshot,
  }
}

export function useObjects(session: DocSession): readonly ObjectData[] {
  const store = useMemo(() => createObjectStore(session), [session])
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

/** Count only, for chrome that does not need the objects themselves. */
export function useObjectCount(session: DocSession): number {
  return useObjects(session).length
}

export type { Y }
