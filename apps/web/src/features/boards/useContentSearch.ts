import { useEffect, useState } from 'react'

import { type BoardKind, type BoardSearchHit, searchBoards } from '../../lib/api'

/** Below this the server answers with nothing, so the request is not made. */
export const CONTENT_MIN_CHARS = 2
/** Long enough to skip the keystrokes in the middle of a word, short enough to feel live. */
const DEBOUNCE_MS = 120
/** Answers kept so backspacing over a query is free. */
const CACHE_LIMIT = 64
/*
 * How long an answer is trusted without asking again. Short on purpose: an answer is
 * a picture of the index at one moment, and the index moves every time somebody writes
 * on a glade. Kept for the page's life, a search made before an edit reached the index
 * went on answering without it, which read as search missing a glade outright. An
 * older answer is still shown at once while the fresh one is fetched.
 */
const FRESH_MS = 10_000

type Hits = ReadonlyMap<string, BoardSearchHit>

const cache = new Map<string, { hits: Hits; at: number }>()
const EMPTY: Hits = new Map()

export type ContentSearch = {
  /** Board id -> what matched on it, in the server's order (most recently edited first). */
  hits: Hits
  /** An answer for the current query is still on its way. */
  pending: boolean
}

/**
 * Boards whose contents match `query`.
 *
 * Titles are matched by the caller, synchronously, from the list it already holds; this
 * is only the half that has to ask the server. The previous answer is kept on screen
 * until the next one lands, so nothing blinks empty between keystrokes, and a request
 * overtaken by a newer query is aborted rather than left to race it.
 */
export function useContentSearch(query: string, kind: BoardKind | null): ContentSearch {
  const needle = query.trim()
  const key = `${kind ?? '*'}:${needle.toLowerCase()}`
  const [answer, setAnswer] = useState<{ key: string; hits: Hits }>({ key: '', hits: EMPTY })

  useEffect(() => {
    if (needle.length < CONTENT_MIN_CHARS) return
    const cached = cache.get(key)
    if (cached !== undefined) {
      setAnswer({ key, hits: cached.hits })
      if (Date.now() - cached.at < FRESH_MS) return
    }

    const controller = new AbortController()
    const timer = window.setTimeout(() => {
      searchBoards(needle, kind, controller.signal)
        .then((found) => {
          const hits: Hits = new Map(found.map((hit) => [hit.id, hit]))
          if (cache.size >= CACHE_LIMIT) {
            const oldest = cache.keys().next().value
            if (oldest !== undefined) cache.delete(oldest)
          }
          cache.delete(key)
          cache.set(key, { hits, at: Date.now() })
          setAnswer({ key, hits })
        })
        .catch(() => {
          if (controller.signal.aborted) return
          // A failed search leaves the title matches standing, which is still a useful
          // answer. Recorded as empty so the dropdown stops saying it is searching.
          setAnswer({ key, hits: EMPTY })
        })
    }, DEBOUNCE_MS)

    return () => {
      window.clearTimeout(timer)
      controller.abort()
    }
  }, [key, needle, kind])

  if (needle.length < CONTENT_MIN_CHARS) return { hits: EMPTY, pending: false }
  return { hits: answer.hits, pending: answer.key !== key }
}
