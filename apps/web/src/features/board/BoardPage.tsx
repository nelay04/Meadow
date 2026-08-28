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
import type { ArrowRouting } from '@meadow/schema'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { PAGE_LINES_STEP } from '../../canvas/engine'

import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { ToolId } from '../../canvas/tools/types'
import { TEXT_MARKS, type TextMark } from '../../doc/richText'
import {
  IconArrow,
  IconBack,
  IconBold,
  IconCircle,
  IconCursor,
  IconDiamond,
  IconFit,
  IconEye,
  IconGridLines,
  IconHand,
  IconItalic,
  IconLock,
  IconLine,
  IconPencil,
  IconRouteCurved,
  IconRouteElbow,
  IconRouteStraight,
  IconSquare,
  IconStrike,
  IconSticky,
  IconText,
  IconUnderline,
  IconTrash,
  IconUnlock,
} from '../../ui/icons'
import { Avatar, initialsOf } from '../../ui/Avatar'
import { useToast } from '../../ui/Toaster'
import { createDocSession, roleCanWrite } from '../../doc/mutations'
import type { BoardKind, BoardRole } from '../../lib/api'
import * as api from '../../lib/api'
import { boardKind, boardPath } from '../boards/kinds'
import { type PresenceHandle, colorFor, trackPresence } from '../../sync/awareness'
import { type BoardConnection, type ConnectionState, connectBoard } from '../../sync/provider'
import { useAuth } from '../auth/AuthContext'
import {
  PAPER_EVENT,
  type Paper,
  readPaperPreference,
  resolvePaper,
} from '../../ui/paper'
import { LeaDate } from './LeaDate'
import { LeaPaper } from './LeaPaper'
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

/**
 * The arrow shapes the picker offers.
 *
 * Three, not more. FigJam has exactly these and there is nothing missing: a straight
 * line, a bow, and a right-angled route. Everything else in a connector is where its
 * ends are attached, which is a drag rather than a mode.
 */
const ROUTINGS: { id: ArrowRouting; label: string; Icon: typeof IconCursor }[] = [
  { id: 'straight', label: 'Straight', Icon: IconRouteStraight },
  { id: 'curved', label: 'Curved', Icon: IconRouteCurved },
  { id: 'orthogonal', label: 'Elbow', Icon: IconRouteElbow },
]

/**
 * The hover label on a rail button: what it does, then how to reach it.
 *
 * `aria-hidden`, because the button already carries the same words in its `aria-label`
 * and a screen reader should not hear them twice. It is a real element rather than a
 * `content: attr()` pseudo-element so the shortcut can be set back from the name.
 */
function Tip({ label, hint }: { label: string; hint?: string }) {
  return (
    <span className="tip" aria-hidden="true">
      {label}
      {hint !== undefined && <span className="key">{hint}</span>}
    </span>
  )
}

/** The formatting buttons, in the order the marks are listed by the serialiser. */
const MARK_BUTTONS: Record<TextMark, { label: string; hint: string; Icon: typeof IconCursor }> = {
  bold: { label: 'Bold', hint: 'Ctrl+B', Icon: IconBold },
  italic: { label: 'Italic', hint: 'Ctrl+I', Icon: IconItalic },
  underline: { label: 'Underline', hint: 'Ctrl+U', Icon: IconUnderline },
  strike: { label: 'Strikethrough', hint: 'Ctrl+Shift+S', Icon: IconStrike },
}

/** Sizes offered in the text bar. Enough of a range to be useful, short enough to scan. */
const TEXT_SIZES = [12, 14, 16, 20, 24, 32, 48, 64]

/** What the status pill says, so a raw state name never reaches the user. */
const CONNECTION_LABEL: Record<ConnectionState, string> = {
  connecting: 'Connecting',
  connected: 'Live',
  disconnected: 'Offline',
  denied: 'No access',
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
  /*
   * What paper this glade is drawn on.
   *
   * Metadata, so it arrives with the title one request after mount and the board opens
   * on graph paper for that moment. That is deliberate: waiting for it would hold the
   * canvas back behind a REST round trip to decide a background, and the surface swap
   * is a class and two style writes rather than a rebuild.
   */
  const [kind, setKind] = useState<BoardKind>('glade')
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
  /*
   * Whether this client has the document, not merely a socket.
   *
   * Only a writing surface cares, and it cares a great deal: it creates its column
   * when the document turns out to be empty, and "empty" before the first sync means
   * every reload of a lea would add another blank paragraph to it.
   */
  const [docReady, setDocReady] = useState(false)
  const connection = useRef<BoardConnection | null>(null)

  const { user } = useAuth()
  const toast = useToast()
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

  /*
   * The last name the server accepted.
   *
   * Held in a ref rather than a second piece of state because nothing renders it: its
   * only jobs are to tell a blur whether anything actually changed, and to give Escape
   * something to put back.
   */
  const savedTitle = useRef('')

  const commitTitle = useCallback(async () => {
    const next = title.trim()
    if (next === savedTitle.current) return
    if (next === '') {
      // A board with no name is a row of blank cards in the list. Refuse quietly and
      // put the old one back rather than saving nothing.
      setTitle(savedTitle.current)
      return
    }

    try {
      const board = await api.renameBoard(boardId, next)
      savedTitle.current = board.title
      setTitle(board.title)
    } catch {
      setTitle(savedTitle.current)
      toast.error('Could not rename this board.')
    }
  }, [boardId, title, toast])

  const spec = boardKind(kind)
  const noun = spec.label.toLowerCase()
  // The rail, cut to what this kind offers. `TOOLS` stays the single ordered list of
  // every tool; a kind never adds one, so a tool can never appear here without a
  // label, a shortcut and an icon.
  const tools = TOOLS.filter((tool) => spec.tools.includes(tool.id))

  const canvas = useCanvas(session, presenceBridge, {
    authorName: user?.display_name ?? '',
    surface: spec.surface,
    tools: spec.tools,
    column: spec.column,
    // A refusal is an event, so it toasts rather than parking a banner over the board.
    // The stack dedupes, which matters here more than anywhere else in the app: this
    // fires from a pointer handler and a two second drag on a read-only glade would
    // otherwise produce a hundred identical cards.
    onRefused: toast.error,
  })

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
        savedTitle.current = board.title
        setKind(board.kind)
        setRole(board.role)

        /*
         * Correct the address bar if the link disagreed with the board.
         *
         * The kind is in the path so a URL says what it opens, but the path cannot be
         * the authority on it: an old `#/glade/...` link, or one typed by hand, has to
         * open the right board anyway. `replaceState` rather than assigning to
         * `location.hash`, so this does not add a history entry the back button then
         * has to be pressed twice to get past.
         */
        const path = boardPath(board.kind, boardId)
        if (location.hash !== path) history.replaceState(null, '', path)
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
    // Either source of truth will do: the local copy is the same document, and a lea
    // opened offline should still open into writing.
    const onSync = (isSynced: boolean) => {
      if (isSynced) setDocReady(true)
    }
    link.provider.on('sync', onSync)
    void idb.whenSynced.then(() => setDocReady(true))

    // Presence is bound to the provider's awareness, not to the doc, so it comes and
    // goes with the connection.
    const handle =
      user === null
        ? null
        : trackPresence(
            link.provider.awareness,
            { id: user.id, name: user.display_name, canWrite: roleCanWrite(role) },
            applyWanderers,
          )
    presence.current = handle

    return () => {
      link.provider.off('sync', onSync)
      setDocReady(false)
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
   * The stock this page is on.
   *
   * Two sources with one answer: the page's own choice, and the reader's default for
   * pages that made none. The default is this browser's rather than the document's, so
   * it is read here and re-read when the profile changes it, the same shape the theme
   * uses.
   */
  const [paperPreference, setPaperPreference] = useState<Paper>(readPaperPreference)
  useEffect(() => {
    const onPaper = () => setPaperPreference(readPaperPreference())
    window.addEventListener(PAPER_EVENT, onPaper)
    return () => window.removeEventListener(PAPER_EVENT, onPaper)
  }, [])
  const paper = resolvePaper(canvas.pagePaper, paperPreference)

  // The stock carries the ink, and WebGL cannot read the cascade. Same call the theme
  // toggle makes, after React has put the attribute on the host.
  useEffect(() => {
    canvas.syncTheme()
  }, [paper, canvas.syncTheme])

  // The role arrives on the handshake, after presence is bound, so it is republished
  // rather than captured. The lock is deliberately not part of it: it is a guard on
  // your own hands, per-tab and never sent to anyone, so a locked tab still shows the
  // editor badge its permissions actually grant.
  useEffect(() => {
    presence.current?.setCanWrite(roleCanWrite(role))
  }, [role])

  /*
   * A new lea opens with the caret on its first line.
   *
   * Only when the page is genuinely empty. Once there is writing on it, forcing a
   * caret somewhere would be the app choosing where you carry on, and on a page where
   * every rule is its own slot that choice is always wrong: you click the line you
   * mean. An empty page has only one line you could mean.
   *
   * Never for a reader. Someone with viewer access opens a lea and reads it; a caret
   * in a page they cannot change is an editor that refuses every keystroke.
   */
  const openIntoWriting = canvas.beginWritingRow
  const empty = canvas.objectCount === 0
  useEffect(() => {
    if (spec.column === null || !docReady || !canWrite || !empty) return

    // The engine learns about the document through its own observer, which may not
    // have run yet. One frame is enough, and failing quietly is correct: the page is
    // still perfectly usable, it just did not focus itself.
    const frame = requestAnimationFrame(() => {
      openIntoWriting(0)
    })
    return () => cancelAnimationFrame(frame)
  }, [spec.column, docReady, canWrite, empty, openIntoWriting])

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
    <main className={`board board-${spec.id}`}>
      <header className="board-bar">
        <button type="button" className="icon ghost" onClick={onBack} title="Back to your glades" aria-label="Back to your glades">
          <IconBack />
        </button>
        {/*
          The name, edited in place.
          There is nowhere else to name a board any more: creating one no longer asks,
          because a form you fill in before you are allowed to start is a toll on the
          thing you actually came to do. This is where you are looking when you decide
          what it is. Editors and above only; a viewer sees the same text and cannot
          type into it.
        */}
        <input
          className="board-name"
          value={title}
          readOnly={!roleCanWrite(role)}
          aria-label="Name"
          size={Math.max(6, title.length)}
          onChange={(event) => setTitle(event.target.value)}
          onFocus={(event) => {
            // An untitled board is named by typing, not by deleting the placeholder
            // word first. Anything the user chose themselves is left alone.
            if (event.target.value === 'Untitled') event.target.select()
          }}
          onBlur={() => void commitTitle()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') event.currentTarget.blur()
            if (event.key === 'Escape') {
              setTitle(savedTitle.current)
              event.currentTarget.blur()
            }
          }}
        />
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
            <Avatar
              className="avatar avatar-self"
              name={user.display_name}
              url={user.avatar_url}
              style={{ background: `#${colorFor(user.id).toString(16).padStart(6, '0')}` }}
              title={`${user.display_name} (you, ${roleCanWrite(role) ? 'editor' : 'viewer'})`}
            >
              <span
                className={`badge ${roleCanWrite(role) ? 'editor' : 'viewer'}`}
                aria-hidden="true"
              >
                {roleCanWrite(role) ? <IconPencil size={9} /> : <IconEye size={9} />}
              </span>
            </Avatar>
          )}
          {dedupe(wanderers).map((wanderer) => (
            <span
              key={wanderer.clientId}
              className="avatar"
              style={{ background: `#${wanderer.color.toString(16).padStart(6, '0')}` }}
              title={`${wanderer.name} (${wanderer.canWrite ? 'editor' : 'viewer'})`}
            >
              {initialsOf(wanderer.name)}
              {/* Which of the two people in a room can actually change it is the one
                  thing about presence that changes how you behave, and a list of
                  identical circles does not say it. */}
              <span className={`badge ${wanderer.canWrite ? 'editor' : 'viewer'}`} aria-hidden="true">
                {wanderer.canWrite ? <IconPencil size={9} /> : <IconEye size={9} />}
              </span>
            </span>
          ))}
        </div>

        <span className="divider" />

        {/* A fenced page zooms too, within a narrow band, so the readout and its reset
            belong on both. Not Fit: fitting the content of a page whose width is the
            whole point of the surface is a button that undoes the surface. */}
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
          {spec.column === null && (
            <button type="button" onClick={canvas.zoomToFit} title="Zoom to fit">
              <IconFit size={15} />
              {/* Wrapped so a narrow bar can drop the word and keep the icon. A bare
                  text node has no box to hide. */}
              <span className="label">Fit</span>
            </button>
          )}
        </div>

        {/* Only where there is paper to choose. A glade's surface is the theme's. */}
        {spec.column !== null && (
          <LeaPaper
            value={canvas.pagePaper}
            fallback={paperPreference}
            editable={canWrite}
            onChange={canvas.setPaper}
          />
        )}

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
            title={locked ? `Unlock this ${noun}` : `Lock this ${noun} against edits`}
            aria-label={locked ? `Unlock this ${noun}` : `Lock this ${noun} against edits`}
          >
            {locked ? <IconLock /> : <IconUnlock />}
          </button>
        )}

      </header>

      <div className="board-body">
        {/* The rail floats over the canvas rather than taking a column out of it.
            ARCHITECTURE 1: the drawing surface is the product. */}
        <nav className="toolbar" aria-label="Tools">
          {tools.map((tool) => (
            <div key={tool.id} className="tool-slot">
              <button
                type="button"
                aria-label={`${tool.label} (${tool.hint})`}
                aria-pressed={canvas.tool === tool.id}
                className={canvas.tool === tool.id ? 'tool active' : 'tool'}
                // Pan stays available to a viewer. Only the creation tools are gated.
                disabled={!canWrite && tool.id !== 'select' && tool.id !== 'hand'}
                onClick={() => canvas.setTool(tool.id)}
              >
                <tool.Icon size={19} />
                <Tip label={tool.label} hint={tool.hint} />
              </button>

              {/*
                The connector shapes, as a flyout beside the tool that draws them.
                Only while that tool is the active one, because it is an option on the
                tool rather than a second row of tools: it says what the next arrow
                will look like, and it never touches an arrow that already exists.
              */}
              {tool.id === 'arrow' && canvas.tool === 'arrow' && canWrite && (
                <div className="tool-submenu" role="group" aria-label="Arrow shape">
                  {ROUTINGS.map((routing) => (
                    <button
                      key={routing.id}
                      type="button"
                      aria-label={routing.label}
                      aria-pressed={canvas.arrowRouting === routing.id}
                      className={canvas.arrowRouting === routing.id ? 'tool active' : 'tool'}
                      onClick={() => canvas.setArrowRouting(routing.id)}
                    >
                      <routing.Icon size={18} />
                      <Tip label={routing.label} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}

          <hr />

          <button
            type="button"
            className="tool danger"
            aria-label="Delete selection"
            disabled={!canWrite || canvas.selection.length === 0}
            onClick={canvas.deleteSelection}
          >
            <IconTrash size={19} />
            <Tip label="Delete" hint="Del" />
          </button>
        </nav>

        {/*
          The engine mounts its own canvas here and sizes to this element.

          The two children are the page's own furniture, and they are here rather than
          in the engine because they are DOM with copy and a click on it. Both are
          placed entirely by the custom properties the engine writes on this element,
          so they ride the camera without React being told the camera moved.
        */}
        <div className="canvas-host" ref={canvas.containerRef} data-paper={paper}>
          {spec.column !== null && (
            <div className="lea-header">
              {/* No printed caption: the placeholder already says what the line is
                  for, and a page of stationery that labels every line reads like a
                  form. The date keeps its caption because a bare date needs one. */}
              <div className="lea-field lea-field-subject">
                <span className="lea-field-slot">
                  <input
                    type="text"
                    className="lea-subject"
                    aria-label="Subject of this page"
                    placeholder="What is in your mind today?"
                    maxLength={120}
                    value={canvas.pageSubject}
                    disabled={!canWrite}
                    onChange={(event) => canvas.setSubject(event.target.value)}
                  />
                </span>
              </div>

              <LeaDate
                value={canvas.pageDate}
                editable={canWrite}
                onChange={canvas.setDate}
              />
            </div>
          )}

          {spec.column !== null && (
            <button
              type="button"
              className="lea-add-lines"
              disabled={!canWrite}
              onClick={canvas.addLines}
            >
              <span>Add {PAGE_LINES_STEP} lines</span>
            </button>
          )}
        </div>

        {/*
          The text formatting bar.

          Fixed at the top of the canvas rather than floating over the object being
          edited: a bar that follows the caret covers the line above whatever is being
          typed, which is the line you are looking at. Every button suppresses
          mousedown, because the editor exits on blur and a button that steals focus
          would close the thing it is meant to format.
        */}
        {/* On a writing surface, only while the caret is actually in the page. A greyed
            formatting bar hanging over the paper the rest of the time is a toolbar
            reminding you that you are in an app. */}
        {canWrite && canvas.canFormatText && (spec.column === null || canvas.editingId !== null) && (
          <div className="text-bar" role="group" aria-label="Text formatting">
            {/*
              No size control on a ruled page.
              The ruling is spaced at exactly one line of the page's own type, so a
              size chosen per paragraph is a paragraph that no longer sits on the
              lines - and the whole look of the surface is that it does. Weight and
              slant are free; the measure is the paper's.
            */}
            {spec.column === null && (
              <>
                <label className="text-size">
                  <span className="sr-only">Text size</span>
                  <select
                    value={canvas.textSize ?? ''}
                    onMouseDown={(event) => event.stopPropagation()}
                    onChange={(event) => canvas.setTextSize(Number(event.target.value))}
                  >
                    {canvas.textSize === null && <option value="">Mixed</option>}
                    {TEXT_SIZES.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                </label>

                <hr />
              </>
            )}

            {TEXT_MARKS.map((mark) => {
              const button = MARK_BUTTONS[mark]
              return (
                <button
                  key={mark}
                  type="button"
                  aria-label={button.label}
                  aria-pressed={canvas.activeMarks.includes(mark)}
                  className={canvas.activeMarks.includes(mark) ? 'tool active' : 'tool'}
                  // Keeps the caret. See the note above.
                  onMouseDown={(event) => event.preventDefault()}
                  disabled={canvas.editingId === null}
                  onClick={() => canvas.toggleMark(mark)}
                >
                  <button.Icon size={17} />
                  <Tip label={button.label} hint={button.hint} />
                </button>
              )
            })}
          </div>
        )}

        <div className="board-notices">
          {locked ? (
            <p className="banner">
              This {noun} is locked.
              <button type="button" className="link" onClick={() => setLocked(false)}>
                Unlock
              </button>
            </p>
          ) : (
            !canWrite && (
              <p className="banner">
                You have {role} access to this {noun}. Editing is disabled.
              </p>
            )
          )}
        </div>
      </div>

      <footer className="statusbar">
        {/* A count of objects and a count of selected ones is a canvas talking about
            itself, which is the right readout on a glade and the wrong one on paper:
            the page is not a thing you selected, it is the thing you are writing on. */}
        <span>
          {spec.column !== null ? (
            <span data-testid="object-count">
              {canvas.editingId !== null ? 'Writing' : 'Ready'}
            </span>
          ) : (
            <>
              <span data-testid="object-count">
                {canvas.objectCount} object{canvas.objectCount === 1 ? '' : 's'}
              </span>
              {' \u00b7 '}
              {canvas.selection.length === 0
                ? 'nothing selected'
                : `${canvas.selection.length} selected`}
            </>
          )}
        </span>
        {/*
          * Keyboard and mouse hints, hidden on a touch device rather than reworded.
          * "Ctrl+Wheel to zoom" is not advice a phone can take, and the touch
          * equivalents - tap, drag, pinch - are the ones nobody needs telling.
          */}
        <span className="hints">
          {canvas.editingId !== null ? (
            <>
              Writing <span className="faint">|</span> <kbd>Esc</kbd> to finish
            </>
          ) : spec.column !== null ? (
            // Nothing about zooming or panning sideways: neither is possible here, and
            // a hint for a gesture the surface refuses is worse than no hint.
            <>
              <kbd>Click</kbd> the page to write <span className="faint">|</span>{' '}
              <kbd>Up</kbd>/<kbd>Down</kbd> to move a line <span className="faint">|</span>{' '}
              <kbd>Wheel</kbd> to scroll the page
            </>
          ) : (
            <>
              <kbd>Double-click</kbd> text to edit <span className="faint">|</span>{' '}
              <kbd>Space</kbd> or middle-drag to pan <span className="faint">|</span>{' '}
              <kbd>Ctrl</kbd>+<kbd>Wheel</kbd> to zoom
            </>
          )}
        </span>
      </footer>
    </main>
  )
}
