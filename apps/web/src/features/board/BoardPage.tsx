/**
 * The board view.
 *
 * Still a table of objects, not a canvas - the canvas is M2. What it does exercise is
 * the real CRDT schema, the real provider, and the role-aware write path, so M2
 * replaces the rendering and nothing underneath it.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import {
  ReadOnlyError,
  addObject,
  clearObjects,
  createDocSession,
  deleteObject,
  moveObject,
  roleCanWrite,
} from '../../doc/mutations'
import { OBJECT_TYPES } from '../../doc/schema'
import { useObjects } from '../../doc/useObjects'
import type { BoardRole } from '../../lib/api'
import * as api from '../../lib/api'
import { type BoardConnection, type ConnectionState, connectBoard } from '../../sync/provider'

type Props = {
  boardId: string
  onBack: () => void
}

export default function BoardPage({ boardId, onBack }: Props) {
  const [title, setTitle] = useState('')
  // Seeded from the ws-token mint and refreshed on every reconnect. The server is
  // always the authority; this is what lets the UI stop a write before it happens.
  const [role, setRole] = useState<BoardRole>('viewer')
  const [state, setState] = useState<ConnectionState>('connecting')
  const [detail, setDetail] = useState('')
  const [notice, setNotice] = useState<string | null>(null)
  const [online, setOnline] = useState(true)
  const connection = useRef<BoardConnection | null>(null)

  // One Y.Doc per board, for the lifetime of this view.
  const doc = useMemo(() => new Y.Doc(), [boardId])
  const session = useMemo(() => createDocSession(doc, role), [doc, role])
  const objects = useObjects(session)

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

  const guard = (fn: () => void) => () => {
    try {
      fn()
      setNotice(null)
    } catch (error) {
      // Should be unreachable while the buttons are disabled, but a refused write is
      // still better than a silent one that vanishes on reload.
      if (error instanceof ReadOnlyError) setNotice(error.message)
      else throw error
    }
  }

  // Manual offline toggle, for exercising the offline-edit-and-reconnect path by hand.
  // Reconnecting goes through the provider rather than the raw socket, because a
  // single-use ws-token means every attempt needs a freshly minted one.
  const toggleOffline = () => {
    if (online) connection.current?.disconnect()
    else connection.current?.reconnect()
    setOnline(!online)
  }

  return (
    <main className="board">
      <header>
        <button type="button" className="link" onClick={onBack}>
          &larr; Fields
        </button>
        <h1>{title}</h1>
        <span className={`role role-${role}`}>{role}</span>
        <span className={`dot ${state}`} />
        <span className="muted">{detail === '' ? state : `${state} (${detail})`}</span>
      </header>

      {!canWrite && (
        <p className="banner">
          You have {role} access to this field. Editing is disabled.
        </p>
      )}
      {notice !== null && <p className="error">{notice}</p>}

      <div className="tools">
        <button
          type="button"
          disabled={!canWrite}
          onClick={guard(() =>
            addObject(session, {
              type: OBJECT_TYPES[Math.floor(Math.random() * OBJECT_TYPES.length)],
            }),
          )}
        >
          Add object
        </button>
        <button
          type="button"
          disabled={!canWrite || objects.length === 0}
          onClick={guard(() => {
            const target = objects[Math.floor(Math.random() * objects.length)]
            if (target !== undefined) {
              moveObject(session, target.id, Math.random() * 2000, Math.random() * 2000)
            }
          })}
        >
          Move one
        </button>
        <button
          type="button"
          disabled={!canWrite || objects.length === 0}
          onClick={guard(() => clearObjects(session))}
        >
          Clear
        </button>
        <button type="button" onClick={toggleOffline} className="link">
          {online ? 'Go offline' : 'Go online'}
        </button>
        <span className="muted">
          {objects.length} object{objects.length === 1 ? '' : 's'}
        </span>
      </div>

      <table>
        <thead>
          <tr>
            <th>id</th>
            <th>type</th>
            <th>x</th>
            <th>y</th>
            <th>w</th>
            <th>h</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {objects.length === 0 ? (
            <tr>
              <td colSpan={7} className="empty">
                no objects yet
              </td>
            </tr>
          ) : (
            objects.map((object) => (
              <tr key={object.id} className="mono">
                <td>{object.id}</td>
                <td>{object.type}</td>
                <td>{object.x}</td>
                <td>{object.y}</td>
                <td>{object.w}</td>
                <td>{object.h}</td>
                <td>
                  <button
                    type="button"
                    className="link danger"
                    disabled={!canWrite}
                    onClick={guard(() => deleteObject(session, object.id))}
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  )
}
