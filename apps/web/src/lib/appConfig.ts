/**
 * The deployment's own settings, read once and shared.
 *
 * One request for the whole session, because it is one answer for the whole session
 * and several views want it: the trash page says how long things are kept, and a lea
 * sweeps its own page trash against the same window. A module-level store rather than
 * a context so that a hook can be dropped into any of them without a provider around
 * it, and so two components mounting at once make one request between them.
 *
 * Unknown until it has been read, and that is deliberately not "the default". Nothing
 * that deletes may run against a guess: a client that assumed thirty days on a
 * deployment configured for one would empty a trash four weeks early, and a value the
 * server has not confirmed is worth exactly nothing to a sweep. Views that only need
 * to *say* how long the window is fall back to the shipped default and are welcome to.
 */

import { useSyncExternalStore } from 'react'

import * as api from './api'
import type { AppConfig } from './api'

/** What the server ships with, for wording only. Never for deciding to delete. */
export const DEFAULT_TRASH_RETENTION_HOURS = 720

let config: AppConfig | null = null
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function announce(): void {
  for (const listener of listeners) listener()
}

function load(): void {
  if (config !== null || inflight !== null) return
  inflight = api
    .getAppConfig()
    .then((next) => {
      config = next
      announce()
    })
    .catch(() => {
      // Left unknown on purpose. A failed read must not be indistinguishable from a
      // deployment that answered, or the sweep would run on a fabricated window.
    })
    .finally(() => {
      inflight = null
    })
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  load()
  return () => {
    listeners.delete(listener)
  }
}

/** The settings, or null until the server has answered. */
export function readAppConfig(): AppConfig | null {
  return config
}

export { subscribe as subscribeAppConfig }

/**
 * How long anything deleted is kept, in milliseconds, or null while that is unknown.
 *
 * Null is the value a sweep waits for. Zero is a real answer and means a delete is
 * final at once, which is why the two are different things here rather than one
 * falsy number.
 */
export function trashRetentionMs(): number | null {
  if (config === null) return null
  return Math.max(0, config.trash_retention_hours) * 3600 * 1000
}

/**
 * How long anything deleted is kept, in hours, for wording on screen.
 *
 * Falls back to the shipped default while the server has not answered, which is the
 * right trade for a sentence and the wrong one for a deletion - see the note at the
 * top of this file. Nothing that removes anything may use this.
 */
export function useTrashRetentionHours(): number {
  const config = useSyncExternalStore(subscribe, readAppConfig)
  return config === null ? DEFAULT_TRASH_RETENTION_HOURS : Math.max(0, config.trash_retention_hours)
}
