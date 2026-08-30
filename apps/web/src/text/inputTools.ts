/**
 * Candidates for a roman word, from Google's input service.
 *
 * This is the same endpoint the page at google.co.in/inputtools/try uses, and asking it
 * is the only way the suggestions here can be the ones a Bengali typist already knows:
 * ranking "amar" as আমার before অমর takes a dictionary and a frequency model, and no
 * transliteration rule can do it. `bengaliPhonetic.ts` answers when this cannot be
 * reached, correctly but unranked.
 *
 * What leaves this machine, and it is worth being plain about it in a private notebook:
 * the roman letters of the word being typed, and nothing else. Not the page, not the
 * Bengali already committed to it, not the title of the lea. The option is off until
 * somebody turns it on, and turning it off stops the requests.
 *
 * Every answer is cached for the session, so holding a key down or walking back through
 * a word with backspace re-asks nothing, and an in-flight request is aborted the moment
 * the word changes.
 */

import { localCandidates } from './bengaliPhonetic'

const ENDPOINT = 'https://inputtools.google.com/request'
/** Google's own code for Bengali phonetic transliteration. */
const LANGUAGE = 'bn-t-i0-und'
const WANTED = 6
/** Long enough to cross a slow connection, short enough that the popup is never late. */
const TIMEOUT_MS = 2_500

const cache = new Map<string, string[]>()
/** Bounded, because a long session types a lot of words and this is only a convenience. */
const CACHE_LIMIT = 500

let online = true

type Answer = { candidates: string[]; source: 'google' | 'local' }

/*
 * The response is a positional array, not an object:
 *
 *   ["SUCCESS", [["amar", ["আমার", "আমাৰ", ...], [], {...}]]]
 *
 * so it is read defensively. A shape we do not recognise is a failure, not a crash.
 */
function parse(payload: unknown): string[] | null {
  if (!Array.isArray(payload) || payload[0] !== 'SUCCESS') return null
  const first = Array.isArray(payload[1]) ? payload[1][0] : undefined
  const words = Array.isArray(first) ? first[1] : undefined
  if (!Array.isArray(words)) return null
  const out = words.filter((word): word is string => typeof word === 'string')
  return out.length === 0 ? null : out
}

function remember(roman: string, candidates: string[]): void {
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(roman, candidates)
}

/**
 * The list, with the roman word itself always last.
 *
 * Google returns transliterations only; the input tools page appends the untransliterated
 * word as the final choice, and it matters more here than there - it is how you write an
 * English word in the middle of a Bengali sentence without reaching for the toggle.
 */
function withRoman(roman: string, candidates: string[]): string[] {
  const out = candidates.filter((word) => word !== roman).slice(0, WANTED - 1)
  out.push(roman)
  return out
}

export function cachedCandidates(roman: string): string[] | null {
  return cache.get(roman) ?? null
}

/** Whether the last request reached the service. Drives the offline note in the popup. */
export function isOnline(): boolean {
  return online
}

export async function fetchCandidates(roman: string, signal?: AbortSignal): Promise<Answer> {
  const hit = cache.get(roman)
  if (hit !== undefined) return { candidates: hit, source: online ? 'google' : 'local' }

  const query = new URLSearchParams({
    text: roman,
    itc: LANGUAGE,
    num: String(WANTED),
    cp: '0',
    cs: '1',
    ie: 'utf-8',
    oe: 'utf-8',
    app: 'meadow',
  })

  // Its own timer, and joined to the caller's signal: the caller aborts when the word
  // changes, the timer aborts when the network stalls, and either has to end the wait.
  const timer = new AbortController()
  const stop = window.setTimeout(() => timer.abort(), TIMEOUT_MS)
  const onAbort = (): void => timer.abort()
  signal?.addEventListener('abort', onAbort, { once: true })

  try {
    const response = await fetch(`${ENDPOINT}?${query.toString()}`, {
      signal: timer.signal,
      // No cookies. The service does not need to know who is asking.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    })
    if (!response.ok) throw new Error(String(response.status))

    const parsed = parse(await response.json())
    if (parsed === null) throw new Error('unrecognised response')

    online = true
    const candidates = withRoman(roman, parsed)
    remember(roman, candidates)
    return { candidates, source: 'google' }
  } catch (error) {
    // An abort is the caller changing its mind, not the service being down, so it must
    // not flip the offline flag or poison the cache with a local answer.
    if (signal?.aborted === true) throw error
    online = false
    return { candidates: localCandidates(roman, WANTED), source: 'local' }
  } finally {
    window.clearTimeout(stop)
    signal?.removeEventListener('abort', onAbort)
  }
}
