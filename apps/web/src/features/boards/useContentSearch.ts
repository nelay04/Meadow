import { useEffect, useState } from 'react'

import { type BoardKind, searchBoards } from '../../lib/api'

/** Below this the server answers with nothing, so the request is not made. */
const MIN_CHARS = 2
/** Long enough to skip the keystrokes in the middle of a word, short enough to feel live. */
const DEBOUNCE_MS = 120
/** Answers kept for the page's life, so backspacing over a query is free. */
const CACHE_LIMIT = 64

const cache = new Map<string, ReadonlyMap<string, string>>()
const EMPTY: ReadonlyMap<string, string> = new Map()

/**
 * Boards whose contents match `query`, as id -> snippet.
 *
 * Titles are matched by the caller, synchronously, from the list it already holds; this
 * is only the half that has to ask the server. The previous answer is kept on screen
 * until the next one lands, so the grid does not blink empty between keystrokes, and a
 * request overtaken by a newer query is aborted rather than left to race it.
 */
export function useContentSearch(query: string, kind: BoardKind | null): ReadonlyMap<string, string> {
  const needle = query.trim()
  const key = `${kind ?? '*'}:${needle.toLowerCase()}`
  const [hits, setHits] = useState<{ key: string; value: ReadonlyMap<string, string> }>({
    key: '',
    value: EMPTY,
  })

  useEffect(() => {
    if (needle.length < MIN_CHARS) return
    const cached = cache.get(key)
    if (cached !== undefined) {
      setHits({ key, value: cached })
      return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchBoards(needle, kind, controller.signal)
        .then((found) => {
          const value = new Map(found.map((hit) => [hit.id, hit.snippet]))
          if (cache.size >= CACHE_LIMIT) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          cache.set(key, value)
          setHits({ key, value })
        })
        .catch(() => {
          // Quiet. An aborted request is the ordinary case, and a failed one leaves the
          // title matches standing, which is still a useful answer.
        })
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, needle, kind])

  if (needle.length < MIN_CHARS) return EMPTY
  return hits.value
}
