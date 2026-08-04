/**
 * The board view: an infinite canvas, per ARCHITECTURE 1.
 *
 * There is no page and no document editor. The canvas fills the view and everything
 * the user makes is an object at an (x, y) on it.
 *
 * React owns the chrome only. Objects are never held in React state: the engine reads
 * the Y.Doc through its own observers, so a drag at 60fps does not re-render this
 * component once.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type { ToolId } from '../../canvas/tools/types'
import { createDocSession, roleCanWrite } from '../../doc/mutations'
import type { BoardRole } from '../../lib/api'
import * as api from '../../lib/api'
import { type BoardConnection, type ConnectionState, connectBoard } from '../../sync/provider'
import { useCanvas } from './useCanvas'

type Props = {
  boardId: string
  onBack: () => void
}

const TOOLS: { id: ToolId; label: string; hint: string }[] = [
  { id: 'select', label: 'Select', hint: 'V' },
  { id: 'hand', label: 'Pan', hint: 'H' },
  { id: 'text', label: 'Text', hint: 'T' },
  { id: 'sticky', label: 'Sticky', hint: 'S' },
  { id: 'rect', label: 'Rectangle', hint: 'R' },
  { id: 'ellipse', label: 'Ellipse', hint: 'O' },
  { id: 'diamond', label: 'Diamond', hint: 'D' },
]

export default function BoardPage({ boardId, onBack }: Props) {
  const [title, setTitle] = useState('')
  // Seeded from the ws-token mint and refreshed on every reconnect. The server is
  // always the authority; this is what lets the UI stop a write before it happens.
  const [role, setRole] = useState<BoardRole>('viewer')
  const [state, setState] = useState<ConnectionState>('connecting')
  const [detail, setDetail] = useState('')
  const connection = useRef<BoardConnection | null>(null)

  // One Y.Doc per board, for the lifetime of this view.
  const doc = useMemo(() => new Y.Doc(), [boardId])
  const session = useMemo(() => createDocSession(doc, role), [doc, role])
  const canvas = useCanvas(session)

  useEffect(() => {
    void api
      .getBoard(boardId)
      .then((board) => {
        setTitle(board.title)
        setRole(board.role)
      })
      .catch(() => setTitle('(unavailable)'))
  }, [boardId])

  useEffect(() => {
    // Offline persistence. Edits made while disconnected survive a reload and replay
    // on reconnect.
    const idb = new IndexeddbPersistence(`meadow-${boardId}`, doc)

    const link = connectBoard({
      boardId,
      doc,
      onState: (next, message) => {
        setState(next)
        setDetail(message ?? '')
      },
      onRole: setRole,
    })
    connection.current = link

    return () => {
      connection.current = null
      link.destroy()
      void idb.destroy()
      doc.destroy()
    }
  }, [boardId, doc])

  const canWrite = roleCanWrite(role)

  return (
    <main className="board">
      <header className="board-bar">
        <button type="button" className="link" onClick={onBack}>
          &larr; Fields
        </button>
        <h1>{title}</h1>
        <span className={`role role-${role}`}>{role}</span>
        <span className={`dot ${state}`} />
        <span className="muted">{detail === '' ? state : `${state} (${detail})`}</span>

        <div className="spacer" />

        <span className="muted mono">{Math.round(canvas.zoom * 100)}%</span>
        <button type="button" className="link" onClick={canvas.resetZoom}>
          100%
        </button>
        <button type="button" className="link" onClick={canvas.zoomToFit}>
          Fit
        </button>
      </header>

      <div className="board-body">
        <nav className="toolbar" aria-label="Tools">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              title={`${tool.label} (${tool.hint})`}
              aria-pressed={canvas.tool === tool.id}
              className={canvas.tool === tool.id ? 'tool active' : 'tool'}
              // Pan stays available to a viewer. Only the creation tools are gated.
              disabled={!canWrite && tool.id !== 'select' && tool.id !== 'hand'}
              onClick={() => canvas.setTool(tool.id)}
            >
              {tool.label}
            </button>
          ))}

          <hr />

          <button
            type="button"
            className="tool"
            disabled={!canWrite || canvas.selection.length === 0}
            onClick={canvas.deleteSelection}
          >
            Delete
          </button>
        </nav>

        {/* The engine mounts its own canvas here and sizes to this element. */}
        <div className="canvas-host" ref={canvas.containerRef} />
      </div>

      {!canWrite && (
        <p className="banner">You have {role} access to this field. Editing is disabled.</p>
      )}
      {canvas.notice !== null && (
        <p className="error" onClick={canvas.dismissNotice}>
          {canvas.notice}
        </p>
      )}

      <footer className="statusbar muted">
        <span>
          <span data-testid="object-count">
            {canvas.objectCount} object{canvas.objectCount === 1 ? '' : 's'}
          </span>
          {' | '}
          {canvas.selection.length === 0
            ? 'nothing selected'
            : `${canvas.selection.length} selected`}
        </span>
        <span className="mono">
          {canvas.editingId === null
            ? 'double-click text to edit, drag to marquee, space or middle-drag to pan, ctrl+wheel to zoom'
            : 'editing text, escape to finish'}
        </span>
      </footer>
    </main>
  )
}
