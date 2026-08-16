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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { ToolId } from '../../canvas/tools/types'
import {
  IconArrow,
  IconBack,
  IconCircle,
  IconCursor,
  IconDiamond,
  IconFit,
  IconGridLines,
  IconHand,
  IconLock,
  IconLine,
  IconSquare,
  IconSticky,
  IconText,
  IconTrash,
  IconUnlock,
} from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { createDocSession, roleCanWrite } from '../../doc/mutations'
import type { BoardRole } from '../../lib/api'
import * as api from '../../lib/api'
import { type PresenceHandle, colorFor, trackPresence } from '../../sync/awareness'
import { type BoardConnection, type ConnectionState, connectBoard } from '../../sync/provider'
import { useAuth } from '../auth/AuthContext'
import { useCanvas } from './useCanvas'

type Props = {
  boardId: string
  onBack: () => void
}

const TOOLS: { id: ToolId; label: string; hint: string; Icon: typeof IconCursor }[] = [
  { id: 'select', label: 'Select', hint: 'V', Icon: IconCursor },
  { id: 'hand', label: 'Pan', hint: 'H', Icon: IconHand },
  { id: 'text', label: 'Text', hint: 'T', Icon: IconText },
  { id: 'sticky', label: 'Sticky', hint: 'S', Icon: IconSticky },
  { id: 'arrow', label: 'Arrow', hint: 'A', Icon: IconArrow },
  { id: 'line', label: 'Line', hint: 'L', Icon: IconLine },
  { id: 'rect', label: 'Rectangle', hint: 'R', Icon: IconSquare },
  { id: 'ellipse', label: 'Ellipse', hint: 'O', Icon: IconCircle },
  { id: 'diamond', label: 'Diamond', hint: 'D', Icon: IconDiamond },
]

/** What the status pill says, so a raw state name never reaches the user. */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  disconnected: 'Offline',
  denied: 'No access',
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/** One avatar per person, however many tabs they have open. */
function dedupe(wanderers: readonly Wanderer[]): Wanderer[] {
  const seen = new Set<string>()
  const out: Wanderer[] = []
  for (const wanderer of wanderers) {
    const key = `${wanderer.name}|${wanderer.color}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(wanderer)
  }
  return out
}

export default function BoardPage({ boardId, onBack }: Props) {
  const [title, setTitle] = useState('')
  // Seeded from the ws-token mint and refreshed on every reconnect. The server is
  // always the authority; this is what lets the UI stop a write before it happens.
  const [role, setRole] = useState<BoardRole>('viewer')
  const [state, setState] = useState<ConnectionState>('connecting')
  /*
   * The local edit lock. Deliberately not persisted and not shared: it guards this
   * tab, this session, against its own stray clicks, and a lock that outlived the
   * visit would read as the glade being broken. See `createDocSession`.
   */
  const [locked, setLocked] = useState(false)
  const [detail, setDetail] = useState('')
  const connection = useRef<BoardConnection | null>(null)

  const { user } = useAuth()
  const [wanderers, setWanderers] = useState<Wanderer[]>([])
  const presence = useRef<PresenceHandle | null>(null)

  // One Y.Doc per board, for the lifetime of this view.
  const doc = useMemo(() => new Y.Doc(), [boardId])
  const session = useMemo(() => createDocSession(doc, role, locked), [doc, role, locked])

  // A stable object, so the engine is not rebuilt every render. The handle behind it
  // is swapped when the connection is, and the ref indirection absorbs that.
  const presenceBridge = useMemo(
    () => ({
      onPointer: (point: { x: number; y: number } | null) => presence.current?.setCursor(point),
      onSelection: (ids: readonly string[]) => presence.current?.setSelection(ids),
    }),
    [],
  )

  const canvas = useCanvas(session, presenceBridge)

  // Depends on the callback, not on `canvas`. `useCanvas` returns a fresh object every
  // render, so closing over the whole handle would give this a new identity each time,
  // and the connection effect below would tear down and rebuild the websocket on every
  // React render. `setWanderers` is a stable useCallback; the handle around it is not.
  const push = canvas.setWanderers
  const applyWanderers = useCallback(
    (next: Wanderer[]) => {
      // Both the header avatars and the canvas read the same list, so a name in the
      // header and a cursor on the board can never disagree.
      setWanderers(next)
      push(next)
    },
    [push],
  )

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

    // Presence is bound to the provider's awareness, not to the doc, so it comes and
    // goes with the connection.
    const handle =
      user === null
        ? null
        : trackPresence(
            link.provider.awareness,
            { id: user.id, name: user.display_name },
            applyWanderers,
          )
    presence.current = handle

    return () => {
      connection.current = null
      presence.current = null
      handle?.destroy()
      applyWanderers([])
      link.destroy()
      void idb.destroy()
      doc.destroy()
    }
  }, [boardId, doc, user, applyWanderers])

  // The role half is the server's answer and the lock half is this tab's. Both have
  // to be true, and the same expression drives the session, so the toolbar can never
  // offer something the mutation layer would refuse.
  const canWrite = roleCanWrite(role) && !locked

  /*
   * Capture a preview for the board list.
   *
   * Not on every edit: rendering the whole board uncilled and encoding a webp is far
   * too expensive to do per keystroke, and the list only needs to be roughly current.
   *
   * Not on unmount either, which is the version that looks obvious and does not work.
   * `useCanvas` registers its effect first, so its cleanup destroys the engine before
   * this one runs and the capture would always find it gone. So: once after the board
   * has settled, on a slow timer, and whenever the tab is hidden, all of which happen
   * while the engine is alive.
   */
  useEffect(() => {
    if (!canWrite) return

    let disposed = false

    const capture = async (): Promise<void> => {
      const engine = canvas.engine
      if (engine === null || disposed) return
      try {
        const image = await engine.captureThumbnail()
        if (image !== null && !disposed) await api.putThumbnail(boardId, image)
      } catch {
        // Cosmetic. A board that will not render a preview must not become a board
        // that will not open.
      }
    }

    const settle = window.setTimeout(() => void capture(), 4_000)
    const timer = window.setInterval(() => void capture(), 120_000)
    const onHidden = (): void => {
      if (document.visibilityState === 'hidden') void capture()
    }
    document.addEventListener('visibilitychange', onHidden)

    return () => {
      disposed = true
      window.clearTimeout(settle)
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', onHidden)
    }
  }, [boardId, canWrite, canvas.engine])

  return (
    <main className="board">
      <header className="board-bar">
        <button type="button" className="icon ghost" onClick={onBack} title="Back to your glades" aria-label="Back to your glades">
          <IconBack />
        </button>
        <h1>{title}</h1>
        <span className={`role role-${role}`}>{role}</span>

        {/* Nothing at all while connected. That is the state you are in essentially
            always, and a permanent indicator for it is the app reporting that nothing
            is wrong, forever. The pill appears only when something actually is. */}
        {state !== 'connected' && (
          <span
            className="conn"
            title={detail === '' ? CONNECTION_LABEL[state] : `${CONNECTION_LABEL[state]} (${detail})`}
          >
            <span className={`dot ${state}`} />
            {CONNECTION_LABEL[state]}
          </span>
        )}

        <div className="spacer" />

        {/* Presence avatars. Deduplicated by user id: one person with two tabs open is
            two wanderers on the canvas but one face here. */}
        <div className="wanderers" aria-label="People here">
          {user !== null && (
            <span
              className="avatar avatar-self"
              style={{ background: `#${colorFor(user.id).toString(16).padStart(6, '0')}` }}
              title={`${user.display_name} (you)`}
            >
              {initials(user.display_name)}
            </span>
          )}
          {dedupe(wanderers).map((wanderer) => (
            <span
              key={wanderer.clientId}
              className="avatar"
              style={{ background: `#${wanderer.color.toString(16).padStart(6, '0')}` }}
              title={wanderer.name}
            >
              {initials(wanderer.name)}
            </span>
          ))}
        </div>

        <span className="divider" />

        <div className="zoom" role="group" aria-label="Zoom">
          {/* The readout is the reset button. Showing the current zoom beside a
              button also labelled 100% reads as the same number printed twice. */}
          <button
            type="button"
            className="readout"
            onClick={canvas.resetZoom}
            title="Reset to 100%"
          >
            {Math.round(canvas.zoom * 100)}%
          </button>
          <button type="button" onClick={canvas.zoomToFit} title="Zoom to fit">
            <IconFit size={15} />
            Fit
          </button>
        </div>

        <button
          type="button"
          className={canvas.gridVisible ? 'icon ghost active' : 'icon ghost'}
          aria-pressed={canvas.gridVisible}
          onClick={canvas.toggleGrid}
          title={canvas.gridVisible ? 'Hide grid' : 'Show grid'}
          aria-label={canvas.gridVisible ? 'Hide grid' : 'Show grid'}
        >
          <IconGridLines />
        </button>

        {/* Only for people who could otherwise edit. Offering a lock to a viewer is
            offering to turn off something they never had. */}
        {roleCanWrite(role) && (
          <button
            type="button"
            className={locked ? 'icon ghost active' : 'icon ghost'}
            aria-pressed={locked}
            onClick={() => setLocked((on) => !on)}
            title={locked ? 'Unlock this glade' : 'Lock this glade against edits'}
            aria-label={locked ? 'Unlock this glade' : 'Lock this glade against edits'}
          >
            {locked ? <IconLock /> : <IconUnlock />}
          </button>
        )}

        <ThemeToggle />
      </header>

      <div className="board-body">
        {/* The rail floats over the canvas rather than taking a column out of it.
            ARCHITECTURE 1: the drawing surface is the product. */}
        <nav className="toolbar" aria-label="Tools">
          {TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              data-tip={`${tool.label}  ${tool.hint}`}
              aria-label={`${tool.label} (${tool.hint})`}
              aria-pressed={canvas.tool === tool.id}
              className={canvas.tool === tool.id ? 'tool active' : 'tool'}
              // Pan stays available to a viewer. Only the creation tools are gated.
              disabled={!canWrite && tool.id !== 'select' && tool.id !== 'hand'}
              onClick={() => canvas.setTool(tool.id)}
            >
              <tool.Icon size={19} />
            </button>
          ))}

          <hr />

          <button
            type="button"
            className="tool"
            data-tip="Delete  Del"
            aria-label="Delete selection"
            disabled={!canWrite || canvas.selection.length === 0}
            onClick={canvas.deleteSelection}
          >
            <IconTrash size={19} />
          </button>
        </nav>

        {/* The engine mounts its own canvas here and sizes to this element. */}
        <div className="canvas-host" ref={canvas.containerRef} />

        <div className="board-notices">
          {locked ? (
            <p className="banner">
              This glade is locked.
              <button type="button" className="link" onClick={() => setLocked(false)}>
                Unlock
              </button>
            </p>
          ) : (
            !canWrite && (
              <p className="banner">You have {role} access to this glade. Editing is disabled.</p>
            )
          )}
          {canvas.notice !== null && (
            <p className="error" onClick={canvas.dismissNotice} title="Dismiss">
              {canvas.notice}
            </p>
          )}
        </div>
      </div>

      <footer className="statusbar">
        <span>
          <span data-testid="object-count">
            {canvas.objectCount} object{canvas.objectCount === 1 ? '' : 's'}
          </span>
          {' \u00b7 '}
          {canvas.selection.length === 0
            ? 'nothing selected'
            : `${canvas.selection.length} selected`}
        </span>
        <span>
          {canvas.editingId === null ? (
            <>
              <kbd>Double-click</kbd> text to edit <span className="faint">|</span>{' '}
              <kbd>Space</kbd> or middle-drag to pan <span className="faint">|</span>{' '}
              <kbd>Ctrl</kbd>+<kbd>Wheel</kbd> to zoom
            </>
          ) : (
            <>
              Editing text <span className="faint">|</span> <kbd>Esc</kbd> to finish
            </>
          )}
        </span>
      </footer>
    </main>
  )
}
