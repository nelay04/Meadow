/**
 * Glade files, between the document and the person holding them.
 *
 * The format and the codec know nothing about browsers (see `doc/interchange.ts`). This
 * is the half that does: saving a file, reading one somebody picked, and carrying a
 * parsed file from the board list, where a new board is made for it, to the board view,
 * where it is written into that board's document.
 */

import {
  type GladeFile,
  type GladeParse,
  type GladeReport,
  GLADE_MAX_BYTES,
  GLADE_MEDIA_TYPE,
  parseGladeFile,
} from '@meadow/schema'

import { exportGlade, gladeFilename, serialiseGlade } from '../doc/interchange'
import type { DocSession } from '../doc/mutations'

/** Save the whole glade as a file. */
export function downloadGlade(session: DocSession, board: { title: string; kind: string }): void {
  const file = exportGlade(session, board, { app: `meadow-web ${import.meta.env.MEADOW_VERSION}` })
  const blob = new Blob([serialiseGlade(file)], { type: GLADE_MEDIA_TYPE })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = gladeFilename(board.title)
  document.body.append(link)
  link.click()
  link.remove()
  // Deferred: revoking in the same task can cancel the download in some browsers.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

/** Read and validate a file somebody picked. Never throws; a refusal says why. */
export async function readGladeFile(file: File): Promise<GladeParse> {
  if (file.size > GLADE_MAX_BYTES) {
    return {
      ok: false,
      error: `That file is ${Math.ceil(file.size / 1024 / 1024)} MiB, more than the ${GLADE_MAX_BYTES / 1024 / 1024} MiB a glade import may be.`,
    }
  }
  try {
    return parseGladeFile(await file.text())
  } catch {
    return { ok: false, error: 'That file could not be read.' }
  }
}

/** What an import had to leave out, as a sentence, or null when it left nothing out. */
export function describeReport(report: GladeReport): string | null {
  const parts: string[] = []
  const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`
  if (report.droppedObjects > 0) parts.push(count(report.droppedObjects, 'object', 'objects'))
  if (report.droppedBindings > 0) {
    parts.push(count(report.droppedBindings, 'arrow attachment', 'arrow attachments'))
  }
  if (report.droppedMeta > 0) parts.push(count(report.droppedMeta, 'setting', 'settings'))
  const skipped = parts.length === 0 ? null : `skipped ${parts.join(', ')} it could not read`
  const freed =
    report.freedBindings > 0
      ? `left ${count(report.freedBindings, 'arrow end', 'arrow ends')} unattached`
      : null
  const said = [skipped, freed].filter((part) => part !== null)
  return said.length === 0 ? null : `The import ${said.join(' and ')}.`
}

/*
 * A parsed file waiting for its board to open.
 *
 * In memory, keyed by board id, and taken exactly once. The board list creates the board
 * and navigates; the board view writes the file once its document has synced with the
 * server. Memory is enough because both are the same page: the app is hash-routed, so
 * nothing between the two reloads it. A reload in between loses the import and leaves an
 * empty board, which is a board the person can delete, not a broken one.
 */
const pending = new Map<string, { file: GladeFile; report: GladeReport }>()

export function stashImport(boardId: string, file: GladeFile, report: GladeReport): void {
  pending.set(boardId, { file, report })
}

export function hasPendingImport(boardId: string): boolean {
  return pending.has(boardId)
}

export function takeImport(boardId: string): { file: GladeFile; report: GladeReport } | null {
  const entry = pending.get(boardId) ?? null
  pending.delete(boardId)
  return entry
}
