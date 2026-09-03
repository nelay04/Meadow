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
import {
  type ArrowRouting,
  type FreedrawTip,
  MAX_POLYGON_SIDES,
  MIN_POLYGON_SIDES,
  type PenAssist,
  TIP_PROFILES,
  tipTakesAssist,
} from '@meadow/schema'
import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { PAGE_LINES_STEP } from '../../canvas/engine'

import type { Wanderer } from '../../canvas/overlay/wandererLayer'
import type { ToolId } from '../../canvas/tools/types'
import { TEXT_MARKS, type TextMark } from '../../doc/richText'
import {
  IconArrow,
  IconAssistNone,
  IconAssistShapes,
  IconAssistTidy,
  IconBack,
  IconBold,
  IconCheck,
  IconChevronDown,
  IconCircle,
  IconCrown,
  IconCursor,
  IconCylinder,
  IconDiamond,
  IconDuplicate,
  IconFit,
  IconEye,
  IconGlobe,
  IconGridLines,
  IconHand,
  IconItalic,
  IconLock,
  IconLine,
  IconMinus,
  IconMore,
  IconNibBrush,
  IconNibChisel,
  IconNibFelt,
  IconNibHighlighter,
  IconNibRound,
  IconPanel,
  IconParallelogram,
  IconPen,
  IconPencil,
  IconPlus,
  IconPolygon,
  IconRouteCurved,
  IconRouteElbow,
  IconRouteStraight,
  IconShapes,
  IconShare,
  IconSquare,
  IconStrike,
  IconSticky,
  IconText,
  IconTrapezoid,
  IconTriangle,
  IconUnderline,
  IconTrash,
  IconUnlock,
} from '../../ui/icons'
import { Avatar } from '../../ui/Avatar'
import { useToast } from '../../ui/Toaster'
import { createDocSession, roleCanWrite } from '../../doc/mutations'
import type { BoardKind, BoardRole, ShareMode } from '../../lib/api'
import * as api from '../../lib/api'
import { clearShareToken, shareToken } from '../../lib/shareLink'
import { boardKind, boardPath } from '../boards/kinds'
import { type PresenceHandle, colorFor, trackPresence } from '../../sync/awareness'
import { type BoardConnection, type ConnectionState, connectBoard } from '../../sync/provider'
import { useAuth } from '../auth/AuthContext'
import { guestIdentity } from '../auth/guest'
import { ShareDialog } from './ShareDialog'
import {
  PAPER_EVENT,
  type Paper,
  readPaperPreference,
  writePaperPreference,
} from '../../ui/paper'
import { LeaDate } from './LeaDate'
import { LeaPages } from './LeaPages'
import { toggleInputLanguage } from '../../text/imeStore'
import { inputLanguage } from '../../text/inputLanguages'
import { InputLanguage } from './InputLanguage'
import { BoardGrid } from './BoardGrid'
import { LeaPaper } from './LeaPaper'
import { useCanvas } from './useCanvas'

type Props = {
  boardId: string
  onBack: () => void
}

type ToolSpec = { id: ToolId; label: string; hint: string; Icon: typeof IconCursor }

const TOOLS: ToolSpec[] = [
  { id: 'select', label: 'Select', hint: 'V', Icon: IconCursor },
  { id: 'hand', label: 'Pan', hint: 'H', Icon: IconHand },
  { id: 'text', label: 'Text', hint: 'T', Icon: IconText },
  { id: 'sticky', label: 'Sticky', hint: 'S', Icon: IconSticky },
  { id: 'arrow', label: 'Arrow', hint: 'A', Icon: IconArrow },
  { id: 'line', label: 'Line', hint: 'L', Icon: IconLine },
  { id: 'pen', label: 'Pen', hint: 'P', Icon: IconPen },
]

/**
 * The shapes, behind one button on the rail.
 *
 * They are four tools, not four options on a tool - each draws a different object -
 * but they are one decision, and a rail that spends four of its ten slots asking it
 * reads as a longer list of things to consider than it is. So they collapse the way
 * the connectors do: one button, and the family behind it. The difference from the
 * arrow's flyout is only that picking here changes the tool rather than a setting on
 * one, which is why the button wears the chosen shape's face while it is armed.
 *
 * Still `ToolId`s and still filtered by the kind's own list, so a surface that offers
 * no shapes simply has no button here rather than one that opens onto nothing.
 */
const SHAPES: ToolSpec[] = [
  { id: 'rect', label: 'Rectangle', hint: 'R', Icon: IconSquare },
  { id: 'ellipse', label: 'Ellipse', hint: 'O', Icon: IconCircle },
  { id: 'diamond', label: 'Diamond', hint: 'D', Icon: IconDiamond },
  { id: 'parallelogram', label: 'Parallelogram', hint: 'G', Icon: IconParallelogram },
  { id: 'triangle', label: 'Triangle', hint: 'J', Icon: IconTriangle },
  { id: 'trapezoid', label: 'Trapezoid', hint: 'Z', Icon: IconTrapezoid },
  { id: 'polygon', label: 'Polygon', hint: 'N', Icon: IconPolygon },
  { id: 'cylinder', label: 'Cylinder', hint: 'Y', Icon: IconCylinder },
]

const SHAPE_TOOLS: ReadonlySet<ToolId> = new Set(SHAPES.map((shape) => shape.id))

function isShapeTool(id: ToolId): boolean {
  return SHAPE_TOOLS.has(id)
}

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
 * The nibs, in the order they sit in the flyout.
 *
 * Ordered by how much the nib does to the line rather than alphabetically: an even
 * ballpoint, then a fineliner, then a cut nib, then a brush, then the marker that is
 * not for writing with at all. Somebody scanning the row is looking for "more
 * expressive than the last one", and that is the axis.
 */
const TIPS: { id: FreedrawTip; label: string; Icon: typeof IconCursor }[] = [
  { id: 'round', label: 'Ballpoint', Icon: IconNibRound },
  { id: 'felt', label: 'Fineliner', Icon: IconNibFelt },
  { id: 'chisel', label: 'Calligraphy', Icon: IconNibChisel },
  { id: 'brush', label: 'Brush', Icon: IconNibBrush },
  { id: 'highlighter', label: 'Highlighter', Icon: IconNibHighlighter },
]

/**
 * What the pen is allowed to do to a stroke once it is finished.
 *
 * Three settings and not a checkbox, because the two that do something are different
 * promises rather than two strengths of one. Both replace the stroke with the object it
 * was: *Tidy up* leaves that object looking like the mark it replaced, in the pen's own
 * colour and weight, so a sketch stops being crooked and stays a sketch. *Snap to
 * shapes* gives it the styling the rail gives, so what comes out is the board's own
 * rectangle and is not distinguishable from one drawn with the shape tool. A single
 * toggle would have to pick one of those and call it "smart".
 *
 * Offered only on the nibs that take it, which is why this row can be absent. The order
 * is how much is at stake: nothing, then the mark, then the object.
 */
const ASSISTS: { id: PenAssist; label: string; Icon: typeof IconCursor }[] = [
  { id: 'off', label: 'Freehand', Icon: IconAssistNone },
  { id: 'tidy', label: 'Tidy up', Icon: IconAssistTidy },
  { id: 'shapes', label: 'Snap to shapes', Icon: IconAssistShapes },
]

/**
 * Nib widths, in world units before the tip applies its own scale.
 *
 * Four, and named rather than a slider. A slider over a continuous range sounds more
 * capable and is worse here: nobody wants 3.4 rather than 3, everybody wants to get
 * back to the width they were using a minute ago, and four fixed stops make that a
 * click instead of an aim.
 */
const PEN_SIZES: { value: number; label: string }[] = [
  { value: 1.5, label: 'Fine' },
  { value: 3, label: 'Medium' },
  { value: 5.5, label: 'Broad' },
  { value: 9, label: 'Heavy' },
]

/**
 * The ink colours, with the theme's own first.
 *
 * `null` is not a missing colour, it is a real choice and the default one: a stroke
 * with no colour of its own is painted in the surface's ink, so it is dark on a light
 * board and light on a dark one. Every other swatch is a colour the author meant, and
 * it stays that colour in both themes. The six are picked to stay legible against both
 * grounds, which rules out anything very dark or very pale.
 */
const PEN_COLORS: { value: number | null; label: string; css: string }[] = [
  { value: null, label: 'Ink', css: 'var(--canvas-ink)' },
  { value: 0xe0524f, label: 'Red', css: '#e0524f' },
  { value: 0xe0913a, label: 'Amber', css: '#e0913a' },
  { value: 0xf2c94c, label: 'Yellow', css: '#f2c94c' },
  { value: 0x3f9f6a, label: 'Green', css: '#3f9f6a' },
  { value: 0x3f86f0, label: 'Blue', css: '#3f86f0' },
  { value: 0x8b5cf0, label: 'Violet', css: '#8b5cf0' },
]

/**
 * The tools whose rail button carries a flyout.
 *
 * A set rather than a check per call site, so a tool cannot end up with a menu the
 * open/close logic does not know about.
 */
const TOOLS_WITH_MENU: ReadonlySet<ToolId> = new Set<ToolId>(['arrow', 'pen'])

/**
 * Which flyout a tool belongs to, or none.
 *
 * The shapes share one, which is the whole point of collapsing them: switching from
 * the rectangle to the diamond is a move inside the menu rather than out of it, so
 * the menu must not be told it has changed subject.
 */
type RailMenu = ToolId | 'shapes'

function menuFor(tool: ToolId): RailMenu | null {
  if (isShapeTool(tool)) return 'shapes'
  return TOOLS_WITH_MENU.has(tool) ? tool : null
}

/** A quarter of a right angle, the step the nib angle is offered in. */
const ANGLE_STEP = Math.PI / 7

/**
 * How a cut nib is held, offered only when the nib is actually cut.
 *
 * Relative to the tip's own natural angle rather than absolute, because "flat" means
 * something different for a calligraphy pen and a highlighter: one is held for
 * writing and the other for sweeping across a line of it. The stored value is the
 * absolute angle either way, so nothing downstream has to know this row exists.
 */
const NIB_ANGLES: { offset: number; label: string }[] = [
  { offset: -ANGLE_STEP, label: 'Steep' },
  { offset: 0, label: 'Standard' },
  { offset: ANGLE_STEP, label: 'Flat' },
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

/*
 * Whether the page list is open, remembered across visits.
 *
 * A preference of this browser rather than of the diary: it is about how much room you
 * have on this screen, which is not something to write into a document everyone else
 * opens. Same shape as the grid toggle, and the same reason for the try/catch - Safari
 * in private mode throws on `localStorage`, and a sidebar is not worth a blank screen.
 */
const PAGES_KEY = 'meadow.pages'

function readPagesPreference(): boolean {
  try {
    return localStorage.getItem(PAGES_KEY) !== 'off'
  } catch {
    return true
  }
}

function writePagesPreference(open: boolean): void {
  try {
    localStorage.setItem(PAGES_KEY, open ? 'on' : 'off')
  } catch {
    // It still holds for this session.
  }
}

/** One avatar per person, however many tabs they have open. */
/**
 * One person in the presence row.
 *
 * The self face and a peer's face differ in where their fields come from and in
 * nothing else, so they are flattened to one shape and rendered by one branch. The
 * alternative is the card markup written twice, which is how the two halves of a row
 * drift apart.
 */
type Face = {
  key: string
  name: string
  avatarUrl: string | null
  color: number
  role: BoardRole | null
  canWrite: boolean
  you: boolean
}

/** Sentence case for a card, from the lowercase word the wire carries. */
function roleLabel(face: Face): string {
  if (face.role === null) return face.canWrite ? 'Can edit' : 'View only'
  return face.role[0].toUpperCase() + face.role.slice(1)
}

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
  /*
   * The owner's lock, as the server last reported it.
   *
   * A different feature from `locked` above, sharing only its consequence. This one is
   * on the board, everybody on it sees the same value, and only the owner lifts it. It
   * arrives with the connection and nowhere else - the owner's press evicts every
   * socket, each client reconnects and is told the new answer at the mint - so nothing
   * here polls for it and nothing trusts a peer's word about it.
   */
  const [boardLocked, setBoardLocked] = useState(false)
  /** Who the board is open to, so the bar can say when it is out in the world. */
  const [shareMode, setShareMode] = useState<ShareMode>('restricted')
  const [shareOpen, setShareOpen] = useState(false)
  /*
   * The overflow menu.
   *
   * The bar had grown to nine controls, and at that length nobody reads it - it becomes
   * a texture you scan past. Four things stayed out because they are used mid-thought,
   * with a hand already on the canvas: the zoom readout, Fit, the input language, and
   * the lock. Everything else is a setting you change once and forget, and a setting
   * you change once belongs behind a click.
   */
  const [moreOpen, setMoreOpen] = useState(false)
  const moreRoot = useRef<HTMLDivElement>(null)
  /*
   * The owner's lock menu.
   *
   * Only an owner has two locks to choose between, so only an owner opens anything:
   * everybody else's button is the lock itself. See the bar.
   */
  const [lockMenuOpen, setLockMenuOpen] = useState(false)
  const lockRoot = useRef<HTMLDivElement>(null)
  const [detail, setDetail] = useState('')
  /** Whether the diary's page list is beside the paper. Only a lea has one. */
  const [pagesOpen, setPagesOpen] = useState(readPagesPreference)
  /** The text-size menu, the same `.menu` popup as the paper picker rather than a native `<select>`. */
  const [sizeMenuOpen, setSizeMenuOpen] = useState(false)
  const sizeMenuRoot = useRef<HTMLDivElement>(null)
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
  const session = useMemo(
    () => createDocSession(doc, role, locked, boardLocked),
    [doc, role, locked, boardLocked],
  )

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

  // Whether the focus that just happened selected the placeholder name, so the mouseup
  // that follows a click-to-focus can be kept from collapsing that selection.
  const justSelected = useRef(false)

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

  /*
   * Which tool's flyout is open, or null.
   *
   * It used to be derived from the active tool, which meant it could never close: the
   * pen stays in your hand across strokes by design, so a menu tied to "the pen is
   * active" sat over the canvas for the rest of the session. A flyout is a question
   * being asked, and it should go away once it has been answered or once you have
   * moved on to the thing it was asking about.
   */
  const [railMenu, setRailMenu] = useState<RailMenu | null>(null)

  /*
   * Which shape the rail's shape button is holding.
   *
   * Remembered rather than derived from the active tool, because the shape tools hand
   * back to select the moment they have drawn something: derived, the button would
   * forget you had chosen the diamond every single time you used it. Seeded with the
   * first of the four; `armedShape` below is what corrects that on a kind that does
   * not offer it, so this never has to know which kinds exist.
   */
  const [shape, setShape] = useState<ToolId>(SHAPES[0].id)

  const spec = boardKind(kind)
  const noun = spec.label.toLowerCase()
  // The rail, cut to what this kind offers. `TOOLS` and `SHAPES` between them stay the
  // single ordered list of every tool; a kind never adds one, so a tool can never
  // appear here without a label, a shortcut and an icon.
  const tools = TOOLS.filter((tool) => spec.tools.includes(tool.id))
  const shapes = SHAPES.filter((entry) => spec.tools.includes(entry.id))
  // What the shape button draws and what it looks like. Falls back to the first shape
  // this kind offers if the remembered one is not among them.
  const armedShape = shapes.find((entry) => entry.id === shape) ?? shapes[0]

  /*
   * What the lock button says.
   *
   * An owner's button opens a menu rather than doing one thing, so theirs reports state
   * and the menu states the actions. Everybody else's is a single lock and says what
   * pressing it will do - except the last case, which is the one that matters: a
   * non-owner on a locked board sees a lock they cannot lift, and the sentence has to
   * say who can, otherwise the button reads as broken rather than as held.
   */
  const lockHint =
    role === 'owner'
      ? boardLocked
        ? locked
          ? `Locked for everyone, and in this tab`
          : `Locked for everyone`
        : locked
          ? `Locked in this tab`
          : `Lock this ${noun}`
      : boardLocked
        ? `The owner has locked this ${noun}`
        : locked
          ? `Unlock this ${noun} in this tab`
          : `Lock this ${noun} against edits, in this tab`

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

  // What the arrow button draws with, for the same reason the shape button knows its
  // shape: the choice is made in the flyout and shows nowhere else until an arrow
  // exists.
  const armedRouting =
    ROUTINGS.find((routing) => routing.id === canvas.arrowRouting) ?? ROUTINGS[0]

  /*
   * The flyout opens when its tool becomes the active one, however that happened.
   *
   * Keyed on the tool rather than on the click, so the keyboard shortcut and the rail
   * button behave the same: pressing P should put the nibs in front of you exactly as
   * pressing the button does. It does not re-run while the tool stays put, which is
   * what lets the dismissals below stick.
   */
  const activeTool = canvas.tool
  const openMenu = useRef<RailMenu | null>(null)
  useEffect(() => {
    const next = menuFor(activeTool)
    // Only when the flyout being asked for is a different one. Picking the ellipse out
    // of the shape menu is still the shape menu, and reopening it on top of the choice
    // that just closed it would make the menu impossible to answer.
    if (next === openMenu.current) return
    openMenu.current = next
    setRailMenu(next)
  }, [activeTool])

  // The rail's shape button follows the keyboard too: pressing D is choosing the
  // diamond, and a button still showing a rectangle after it would be lying.
  useEffect(() => {
    if (isShapeTool(activeTool)) setShape(activeTool)
  }, [activeTool])

  useEffect(() => {
    if (!moreOpen) return
    const onDown = (event: PointerEvent) => {
      if (!moreRoot.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMoreOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [moreOpen])

  useEffect(() => {
    if (!lockMenuOpen) return
    const onDown = (event: PointerEvent) => {
      if (!lockRoot.current?.contains(event.target as Node)) setLockMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLockMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [lockMenuOpen])

  /**
   * The per-tab lock: this tab, this session, nobody else told.
   *
   * A guard against your own hands. It is state and nothing else, so it takes effect
   * on the press with nothing to wait for.
   */
  const toggleTabLock = useCallback(() => setLocked((on) => !on), [])

  /**
   * The owner's lock: a fact about the board that everybody on it sees and obeys.
   *
   * Applied from the server's own answer rather than from the click. The PATCH returns
   * the row it just wrote, so `board.is_locked` is the committed truth and setting it
   * here cannot invent a state the server disagrees with - while a rejected request
   * leaves the flag exactly where it was.
   *
   * That answer used to be waited for on the reconnect instead: the server evicts every
   * socket on the board, each client re-mints, and the mint reports the lock. Everybody
   * else still learns it that way, and it is the only way they could. But it left the
   * person who pressed the button watching an unchanged bar for a whole eviction and
   * reconnect - and if the eviction did not reach them at all, until they reloaded.
   * The one client that already has the server's answer in its hand should use it.
   */
  const setBoardLockTo = useCallback(
    (next: boolean) => {
      setLockMenuOpen(false)
      void api
        .setBoardLock(boardId, next)
        .then((board) => setBoardLocked(board.is_locked))
        .catch((error: unknown) => {
          toast.error(
            error instanceof Error ? error.message : `Could not lock this ${noun}.`,
          )
        })
    },
    [boardId, noun, toast],
  )

  /**
   * What the lock button does when there is nothing to choose.
   *
   * Everybody but the owner has exactly one lock, so their press is that lock. An owner
   * has two and gets the menu instead - see the bar.
   */
  const toggleLock = useCallback(() => {
    if (role !== 'owner') {
      toggleTabLock()
      return
    }
    setLockMenuOpen((open) => !open)
  }, [role, toggleTabLock])

  useEffect(() => {
    if (!sizeMenuOpen) return
    const onDown = (event: PointerEvent) => {
      if (!sizeMenuRoot.current?.contains(event.target as Node)) setSizeMenuOpen(false)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSizeMenuOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [sizeMenuOpen])

  /**
   * Put the flyout away.
   *
   * Called from the canvas, because starting to draw is the clearest possible signal
   * that you are done choosing what to draw with.
   */
  const dismissRailMenu = useCallback(() => setRailMenu(null), [])

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
    let cancelled = false

    /*
     * Correct the address bar if the link disagreed with the board.
     *
     * The kind is in the path so a URL says what it opens, but the path cannot be the
     * authority on it: an old `#/glade/...` link, or one typed by hand, has to open the
     * right board anyway. `replaceState` rather than assigning to `location.hash`, so
     * this does not add a history entry the back button then has to be pressed twice to
     * get past - and it preserves the query string, which is where a share token lives.
     */
    const settle = (board: { title: string; kind: BoardKind; role: BoardRole; is_locked: boolean }) => {
      if (cancelled) return
      setTitle(board.title)
      savedTitle.current = board.title
      setKind(board.kind)
      setRole(board.role)
      setBoardLocked(board.is_locked)
      const path = boardPath(board.kind, boardId)
      if (location.hash !== path) {
        history.replaceState(null, '', `${location.pathname}${location.search}${path}`)
      }
    }

    /*
     * Two ways to learn about a board, tried in that order.
     *
     * The members-only route first, because a member should see their own role rather
     * than the link's - an owner who opens their own share link is still the owner. Its
     * 403 is not an error here: it is how a signed-in stranger and an anonymous visitor
     * both find out they should be asking the public route instead. Only when *that*
     * fails too is there nothing to show.
     */
    void api
      .getBoard(boardId)
      .then((board) => {
        settle(board)
        setShareMode(board.share_mode)
      })
      .catch(() => {
        const token = shareToken()
        if (token === null) {
          if (!cancelled) setTitle('(unavailable)')
          return
        }
        return api
          .getSharedBoard(token)
          .then((board) => {
            settle({ ...board, role: board.role })
            setShareMode('public')
          })
          .catch(() => {
            // The link was rotated, or the board is no longer public. Forget it, so
            // every later request stops presenting a credential the server keeps
            // refusing.
            clearShareToken()
            if (!cancelled) setTitle('(unavailable)')
          })
      })

    return () => {
      cancelled = true
    }
  }, [boardId])

  useEffect(() => {
    // Offline persistence. Edits made while disconnected survive a reload and replay
    // on reconnect.
    const idb = new IndexeddbPersistence(`meadow-${boardId}`, doc)

    const link = connectBoard({
      boardId,
      doc,
      linkToken: shareToken(),
      authenticated: user !== null,
      onState: (next, message) => {
        setState(next)
        setDetail(message ?? '')
      },
      // The server answers role and lock together at every mint, so a lock taken while
      // this page was open arrives here, on the reconnect the eviction caused.
      onAccess: (access) => {
        setRole(access.role)
        setBoardLocked(access.locked)
      },
    })
    connection.current = link
    // Either source of truth will do: the local copy is the same document, and a lea
    // opened offline should still open into writing.
    const onSync = (isSynced: boolean) => {
      if (isSynced) setDocReady(true)
    }
    link.provider.on('sync', onSync)
    void idb.whenSynced.then(() => setDocReady(true))

    /*
     * Presence is bound to the provider's awareness, not to the doc, so it comes and
     * goes with the connection.
     *
     * A visitor on a public link has no account and still gets a face. Leaving them out
     * would make a shared board feel empty to the people who own it while somebody was
     * plainly moving things around on it, and would leave the visitor's own cursor
     * unexplained to everyone else. The identity is made on this side and claims
     * nothing - see `features/auth/guest.ts`.
     */
    const guest = guestIdentity()
    const me =
      user === null
        ? { id: guest.id, name: guest.name, avatarUrl: null, role }
        : { id: user.id, name: user.display_name, avatarUrl: user.avatar_url, role }
    const handle = trackPresence(link.provider.awareness, me, applyWanderers)
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

  // The role and the owner's lock are the server's answers; the third is this tab's
  // own. All three have to hold, and the same expression drives the session, so the
  // toolbar can never offer something the mutation layer would refuse.
  const canWrite = roleCanWrite(role) && !locked && !boardLocked

  /*
   * The presence row, as one list.
   *
   * Deduplicated by name and colour: one person with two tabs open is two wanderers on
   * the canvas but one face here.
   */
  const guest = guestIdentity()
  // A link visitor is in this row too, under the name their own tab gave them. The
  // alternative was a board that shows one face while two cursors move on it.
  const me = user ?? { id: guest.id, display_name: guest.name, avatar_url: null }
  const faces: Face[] = [
    {
      key: 'you',
      name: me.display_name,
      avatarUrl: me.avatar_url ?? null,
      color: colorFor(me.id),
      role,
      canWrite: roleCanWrite(role),
      you: true,
    },
    ...dedupe(wanderers).map((wanderer) => ({
      key: `peer-${wanderer.clientId}`,
      name: wanderer.name,
      avatarUrl: wanderer.avatarUrl,
      color: wanderer.color,
      role: wanderer.role,
      canWrite: wanderer.canWrite,
      you: false,
    })),
  ]

  /*
   * Which face has its card open, by key.
   *
   * A click rather than a hover, because the row is small, the circles overlap, and a
   * card that appears as the pointer crosses the row on its way to the zoom control is
   * a card nobody asked for. One at a time: two open cards would overlap each other.
   */
  const [openFace, setOpenFace] = useState<string | null>(null)
  const facesRow = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (openFace === null) return

    // `pointerdown` rather than `click`, so the card is gone before whatever was
    // clicked underneath it happens. Clicks inside the row are left alone: that is the
    // same-face toggle and the switch to another face, both handled by the button.
    const onDown = (event: PointerEvent) => {
      if (facesRow.current?.contains(event.target as Node) === true) return
      setOpenFace(null)
    }
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpenFace(null)
    }

    window.addEventListener('pointerdown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('pointerdown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [openFace])

  /*
   * The stock this page is on: the reader's own default, and nothing else.
   *
   * It is this browser's setting rather than the document's, so it is read here and
   * re-read whenever anything moves it - the profile, this lea's own menu, or another
   * tab - the same shape the theme uses.
   *
   * The document's own `pagePaper` is deliberately not consulted. Leas written before
   * the two controls were merged may still carry a stock in `meta`, and reading it here
   * is what made the menu and the profile disagree: the profile moved the preference
   * while the page kept rendering the document's older opinion, which no reader could
   * see or clear. Nothing reads it now, and a writer picking a paper drains it.
   */
  const [paperPreference, setPaperPreference] = useState<Paper>(readPaperPreference)
  useEffect(() => {
    const onPaper = () => setPaperPreference(readPaperPreference())
    window.addEventListener(PAPER_EVENT, onPaper)
    return () => window.removeEventListener(PAPER_EVENT, onPaper)
  }, [])
  const paper = paperPreference

  // One choice, written to the preference every surface reads, and the document's old
  // opinion dropped so it cannot outvote it. The clear is a no-op for a viewer, whose
  // own paper still changes.
  const setPaper = useCallback(
    (next: Paper) => {
      writePaperPreference(next)
      canvas.setPaper('')
    },
    [canvas.setPaper],
  )

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
    presence.current?.setRole(role)
  }, [role])

  /*
   * Ctrl+G switches the keyboard, from anywhere on the board.
   *
   * The same chord Google's input tools use, because somebody who types Bengali on the
   * web already presses it without thinking. It takes the browser's find-again binding,
   * which is the lesser loss on a canvas that has no find. Captured on the window rather
   * than on the editor: the switch is worth making before you start typing, not only
   * once a caret is already in a line.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return
      if (event.altKey || event.shiftKey || event.key.toLowerCase() !== 'g') return
      event.preventDefault()
      const on = inputLanguage(toggleInputLanguage())
      toast.info(
        on === null
          ? 'Phonetic typing off.'
          : `Phonetic ${on.label} on. Type ${on.sample[0]}, choose ${on.sample[1]}.`,
      )
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toast])

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
  // Read inside the capture timer, which must not restart every time an object is
  // added or removed.
  const emptyRef = useRef(empty)
  emptyRef.current = empty
  const docReadyRef = useRef(docReady)
  docReadyRef.current = docReady
  /*
   * Once per board, not once per empty document.
   *
   * `empty` is derived from the object count, and the writing row is created when the
   * caret goes into it and thrown away again when it is left with nothing on it. So
   * without this latch the effect is a loop: opening the row makes the board non-empty,
   * clicking the title bar blurs the editor, the empty row is discarded, the board is
   * empty again and the caret is pulled straight back onto the page. That is the blink,
   * and it is why it only happened on a lea you had not typed into yet.
   */
  const openedInto = useRef('')
  useEffect(() => {
    if (spec.column === null || !docReady || !canWrite || !empty) return
    if (openedInto.current === boardId) return
    openedInto.current = boardId

    // The engine learns about the document through its own observer, which may not
    // have run yet. One frame is enough, and failing quietly is correct: the page is
    // still perfectly usable, it just did not focus itself.
    const frame = requestAnimationFrame(() => {
      openIntoWriting(0)
    })
    return () => cancelAnimationFrame(frame)
  }, [boardId, spec.column, docReady, canWrite, empty, openIntoWriting])

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
    // A link visitor is skipped even when they may write. The preview exists for the
    // board list, they have no board list, and every attempt would be an unauthenticated
    // PUT that 401s and drags a refresh attempt along behind it - twice a minute, for a
    // picture nobody would ever be shown.
    if (!canWrite || user === null) return

    let disposed = false

    const capture = async (): Promise<void> => {
      const engine = canvas.engine
      if (engine === null || disposed) return
      try {
        // An emptied board has nothing to render, and leaving the last capture in
        // place would keep the list advertising objects the board no longer has. Only
        // once the document has actually synced: "empty" before that is just unloaded.
        if (emptyRef.current && docReadyRef.current) {
          await api.deleteThumbnail(boardId)
          return
        }
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
  }, [boardId, canWrite, canvas.engine, user])

  /*
   * Clearing the board clears its preview, straight away.
   *
   * The capture timer below would get there eventually, but "eventually" is up to two
   * minutes, and going back to the list right after deleting everything is exactly
   * when a stale picture is most obviously wrong.
   */
  useEffect(() => {
    if (!canWrite || user === null || !docReady || !empty) return
    void api.deleteThumbnail(boardId).catch(() => {
      // Cosmetic, like the capture itself.
    })
  }, [boardId, canWrite, docReady, empty, user])

  return (
    <main className={`board board-${spec.id}`}>
      <header className="board-bar">
        {/* A link visitor has no glades to go back to, so the button offers them the
            app itself. Same destination either way; the sentence is the only thing that
            would be wrong. */}
        <button
          type="button"
          className="icon ghost"
          onClick={onBack}
          title={user === null ? 'Go to Meadow' : 'Back to your glades'}
          aria-label={user === null ? 'Go to Meadow' : 'Back to your glades'}
        >
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
            if (event.target.value.startsWith('Untitled ') || event.target.value === 'Untitled') {
              event.target.select()
              justSelected.current = true
            }
          }}
          onMouseUp={(event) => {
            /*
             * A click that lands on an unfocused input fires focus on mousedown and
             * then collapses the selection on mouseup, so the select() above only
             * survived while the default name was one short word you were unlikely to
             * click twice. The generated names are a whole phrase now, and the caret
             * landed wherever the pointer was: swallowing this one mouseup keeps the
             * select-all. A second click, once the flag is down, places the caret.
             */
            if (justSelected.current) {
              justSelected.current = false
              event.preventDefault()
            }
          }}
          onBlur={() => {
            justSelected.current = false
            void commitTitle()
          }}
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

        {/* Presence. A face each, the badge saying who may write, a crown on whoever
            owns the glade, and the name behind it one click away. */}
        <div className="wanderers" aria-label="People here" ref={facesRow}>
          {faces.map((face) => (
            <span className="face" key={face.key}>
              <Avatar
                className={face.you ? 'avatar avatar-self' : 'avatar'}
                name={face.name}
                url={face.avatarUrl}
                style={{ background: `#${face.color.toString(16).padStart(6, '0')}` }}
                title={face.name}
                onClick={() => setOpenFace((open) => (open === face.key ? null : face.key))}
              >
                {/* Tilted, and sitting on the rim rather than beside the circle: a
                    crown worn at an angle reads as one at a glance, and a level one at
                    this size reads as a smudge. */}
                {face.role === 'owner' && (
                  <span className="crown" aria-hidden="true">
                    <IconCrown size={11} />
                  </span>
                )}
                {/* Which of the people in a room can actually change it is the one
                    thing about presence that changes how you behave, and a list of
                    identical circles does not say it. */}
                <span
                  className={`badge ${face.canWrite ? 'editor' : 'viewer'}`}
                  aria-hidden="true"
                >
                  {face.canWrite ? <IconPencil size={10} /> : <IconEye size={10} />}
                </span>
              </Avatar>

              {openFace === face.key && (
                <span className="face-card" role="status">
                  <span className="who">
                    {face.name}
                    {face.you && <span className="you"> (you)</span>}
                  </span>
                  <span className={`role role-${face.role ?? (face.canWrite ? 'editor' : 'viewer')}`}>
                    {roleLabel(face)}
                  </span>
                </span>
              )}
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

        {/*
          The keyboard, not the document.

          Offered on every kind rather than only on a diary: a glade's stickies and text
          objects take the same editor, and somebody who writes in another script does
          not stop at the edge of the paper. It is the person's own setting - see
          `text/imeStore.ts` - so it follows them from board to board and nobody else on
          this lea sees it change.

          One of the four that stayed out of the menu, because it is switched
          mid-sentence: a control you reach for while already typing cannot cost a click
          to find.
        */}
        <InputLanguage />

        {/*
          The lock. Also out of the menu, for the opposite reason to the language
          picker: it is not used often, but when it is used it is used *now* - you are
          about to present, or somebody is about to nudge a shape you spent an hour on
          - and a safety control behind a menu is a safety control nobody reaches in
          time.

          Two locks, and they are not two strengths of one thing. The tab lock guards
          your own hands and is told to nobody; the board lock stops everybody on the
          board, including the owner who pressed it. Everybody but the owner holds only
          the first, so their button *is* that lock and stays one press. An owner holds
          both, and a button that silently picked the heavier one for them was the wrong
          answer: locking the board in front of four other people is not the same act as
          stopping your own cursor, and the control has to let them say which. So an
          owner gets the two named, and nothing happens until one is chosen.

          Both are offered to whoever could otherwise write, and to nobody else:
          offering a lock to a viewer is offering to turn off something they never had.
        */}
        {(roleCanWrite(role) || boardLocked) && (
          <div className="dropdown board-lock" ref={lockRoot}>
            <button
              type="button"
              className={locked || boardLocked ? 'icon ghost active' : 'icon ghost'}
              // A menu button reports whether the menu is open; a lock button reports
              // whether it is locked. Two different questions, so only the one that
              // applies to this button is answered.
              {...(role === 'owner'
                ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': lockMenuOpen }
                : { 'aria-pressed': locked || boardLocked })}
              disabled={boardLocked && role !== 'owner'}
              onClick={toggleLock}
              title={lockHint}
              aria-label={lockHint}
            >
              {locked || boardLocked ? <IconLock /> : <IconUnlock />}
            </button>

            {role === 'owner' && lockMenuOpen && (
              <div className="menu menu-compact" role="menu" aria-label="Lock">
                {/* This tab first. It is the smaller of the two and the one you can
                    take back on your own, so it is the safer thing to land on. */}
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={locked}
                  className={locked ? 'menu-item checked' : 'menu-item'}
                  onClick={() => {
                    setLockMenuOpen(false)
                    toggleTabLock()
                  }}
                >
                  <span className="menu-label">
                    {locked ? 'Unlock for me' : 'Lock for me'}
                  </span>
                  {locked && <IconCheck size={15} />}
                </button>

                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={boardLocked}
                  className={boardLocked ? 'menu-item checked' : 'menu-item'}
                  onClick={() => setBoardLockTo(!boardLocked)}
                >
                  <span className="menu-label">
                    {boardLocked ? 'Unlock for everyone' : 'Lock for everyone'}
                  </span>
                  {boardLocked && <IconCheck size={15} />}
                </button>

                {/* Said once, under both, because the difference between them is the
                    only thing anybody needs to know here and neither label can carry
                    it alone. */}
                <p className="menu-note">
                  Locking for everyone stops all edits on this {noun} until you unlock
                  it.
                </p>
              </div>
            )}
          </div>
        )}

        {/*
          Everything else, behind one button.

          What is in here is not a leftovers drawer: it is every control that is a
          *setting*. You choose your grid, or your stationery, or whether the page list
          is open, once - and then you are working, and a bar still advertising those
          choices is nine things to read past every time you look for the zoom. Sharing
          lives here too. It is the most consequential thing on this bar and among the
          rarest, and those two facts point the same way: a decision about who else can
          be here should cost a deliberate click rather than sitting one stray press
          away from the canvas.
        */}
        <div className="dropdown board-more" ref={moreRoot}>
          <button
            type="button"
            className={moreOpen ? 'icon ghost active' : 'icon ghost'}
            aria-haspopup="menu"
            aria-expanded={moreOpen}
            onClick={() => setMoreOpen((open) => !open)}
            title="More"
            aria-label="More"
          >
            <IconMore />
          </button>

          {moreOpen && (
            <div className="menu" role="menu" aria-label="More">
              {/* Owner only, because every control behind it decides who else may be
                  here. An editor is not entitled to widen their own grant. */}
              {role === 'owner' && (
                <button
                  type="button"
                  role="menuitem"
                  className="menu-item"
                  onClick={() => {
                    setMoreOpen(false)
                    setShareOpen(true)
                  }}
                >
                  <IconShare size={16} />
                  <span>Share…</span>
                  {shareMode === 'public' && (
                    <span className="menu-badge" title="Anyone with the link can open this">
                      <IconGlobe size={12} />
                      Public
                    </span>
                  )}
                </button>
              )}

              {/* Both of these belong to a diary and to nothing else: a glade has no
                  pages to list and no stationery to choose. */}
              {spec.column !== null && (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={pagesOpen}
                  className={pagesOpen ? 'menu-item checked' : 'menu-item'}
                  onClick={() =>
                    setPagesOpen((open) => {
                      writePagesPreference(!open)
                      return !open
                    })
                  }
                >
                  <IconPanel size={16} />
                  <span>{pagesOpen ? 'Hide the pages' : 'Show the pages'}</span>
                </button>
              )}

              {spec.column !== null && (
                <LeaPaper value={paperPreference} onChange={setPaper} />
              )}

              {/*
                A glade picks its paper out of three; a lea only says whether its rules
                show.

                The difference is not a shortcut. A diary's ruling is the leading its
                writing sits on, so there is no dot lattice to offer there - a writing
                line with its middle rubbed out is not a writing line - and a picker of
                one real choice is worse than the toggle it replaced.
              */}
              {spec.column === null ? (
                <BoardGrid
                  value={canvas.gridVisible ? canvas.gridPattern : 'none'}
                  onChange={(choice) => {
                    if (choice === 'none') {
                      if (canvas.gridVisible) canvas.toggleGrid()
                      return
                    }
                    canvas.setGridPattern(choice)
                    if (!canvas.gridVisible) canvas.toggleGrid()
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={canvas.gridVisible}
                  className={canvas.gridVisible ? 'menu-item checked' : 'menu-item'}
                  onClick={canvas.toggleGrid}
                >
                  <IconGridLines size={16} />
                  <span>{canvas.gridVisible ? 'Hide the rules' : 'Show the rules'}</span>
                </button>
              )}
            </div>
          )}
        </div>
      </header>

      {/* `with-pages` only while the list is actually standing beside the canvas: it is
          what everything centred on the paper subtracts to stay centred on it. */}
      <div className={spec.column !== null && pagesOpen ? 'board-body with-pages' : 'board-body'}>
        {/* The rail floats over the canvas rather than taking a column out of it.
            ARCHITECTURE 1: the drawing surface is the product. */}
        <nav className="toolbar" aria-label="Tools">
          {tools.map((tool) => {
            const active = canvas.tool === tool.id
            /*
             * The arrow wears the shape it will draw, on the same terms as the shape
             * button below.
             *
             * A routing is chosen before the arrow exists and never applied to one
             * already drawn, so between choosing it and using it the rail is the only
             * place it is written down - and a button showing a plain diagonal while
             * the elbow is armed is the rail declining to say what it is about to do.
             * It reverts when the tool does: the arrow hands back to select once it
             * has drawn something, and nothing is armed then.
             */
            const armed = tool.id === 'arrow' && active
            const Icon = armed ? armedRouting.Icon : tool.Icon
            const label = armed ? `${tool.label}: ${armedRouting.label}` : tool.label

            return (
            <div key={tool.id} className="tool-slot">
              <button
                type="button"
                aria-label={`${label} (${tool.hint})`}
                aria-pressed={active}
                // `has-more` is the folded corner, and it belongs to every button with
                // a flyout rather than only to the shapes': what it says is that there
                // is something behind this button, which is as true of the nibs as it
                // is of the four shapes.
                className={`tool${TOOLS_WITH_MENU.has(tool.id) ? ' has-more' : ''}${
                  active ? ' active' : ''
                }`}
                // Pan stays available to a viewer. Only the creation tools are gated.
                disabled={!canWrite && tool.id !== 'select' && tool.id !== 'hand'}
                onClick={() => {
                  // Pressing the button of the tool already in your hand is how you get
                  // its flyout back after it has been dismissed, and how you put it
                  // away without drawing. Anything else is an ordinary tool switch, and
                  // the effect above opens the new tool's menu if it has one.
                  if (active) {
                    setRailMenu((open) =>
                      open === tool.id || !TOOLS_WITH_MENU.has(tool.id) ? null : tool.id,
                    )
                    return
                  }
                  canvas.setTool(tool.id)
                }}
              >
                <Icon size={19} />
                <Tip label={label} hint={tool.hint} />
              </button>

              {/*
                The connector shapes, as a flyout beside the tool that draws them.
                Only while that tool is the active one, because it is an option on the
                tool rather than a second row of tools: it says what the next arrow
                will look like, and it never touches an arrow that already exists.
              */}
              {tool.id === 'arrow' && railMenu === 'arrow' && canWrite && (
                <div className="tool-submenu" role="group" aria-label="Arrow shape">
                  {ROUTINGS.map((routing) => (
                    <button
                      key={routing.id}
                      type="button"
                      aria-label={routing.label}
                      aria-pressed={canvas.arrowRouting === routing.id}
                      className={canvas.arrowRouting === routing.id ? 'tool active' : 'tool'}
                      // Closed on the choice, not on the next click elsewhere. There
                      // is exactly one thing to pick here and picking it is the whole
                      // errand, so leaving the menu up afterwards is just something
                      // else standing over the canvas.
                      onClick={() => {
                        canvas.setArrowRouting(routing.id)
                        setRailMenu(null)
                      }}
                    >
                      <routing.Icon size={18} />
                      <Tip label={routing.label} />
                    </button>
                  ))}
                </div>
              )}

              {/*
                The nib, on the same terms as the connector shapes above: an option on
                the tool, chosen before the stroke and never applied to one already
                drawn. It is a column rather than a row because there are four things
                to choose and a row of nineteen buttons beside the rail is not a
                flyout, it is a second toolbar.
              */}
              {tool.id === 'pen' && railMenu === 'pen' && canWrite && (
                <div className="tool-submenu pen-menu" role="group" aria-label="Pen">
                  <div className="pen-row" role="group" aria-label="Nib">
                    {TIPS.map((nib) => (
                      <button
                        key={nib.id}
                        type="button"
                        aria-label={nib.label}
                        aria-pressed={canvas.pen.tip === nib.id}
                        className={canvas.pen.tip === nib.id ? 'tool active' : 'tool'}
                        // The angle goes with the nib. A highlighter held at a
                        // calligraphy pen's angle lays its blade along the sweep and
                        // leaves nothing behind it, which reads as a broken tool
                        // rather than as a setting.
                        onClick={() =>
                          canvas.setPen({ tip: nib.id, angle: TIP_PROFILES[nib.id].angle })
                        }
                      >
                        <nib.Icon size={18} />
                        <Tip label={nib.label} />
                      </button>
                    ))}
                  </div>

                  <div className="pen-row" role="group" aria-label="Nib width">
                    {PEN_SIZES.map((size) => (
                      <button
                        key={size.label}
                        type="button"
                        aria-label={size.label}
                        aria-pressed={canvas.pen.size === size.value}
                        className={canvas.pen.size === size.value ? 'tool active' : 'tool'}
                        onClick={() => canvas.setPen({ size: size.value })}
                      >
                        {/* The button shows the width rather than naming it. A row of
                            growing dots is read without being read. */}
                        <span
                          className="pen-dot"
                          style={{
                            width: `${Math.round(4 + size.value)}px`,
                            height: `${Math.round(4 + size.value)}px`,
                          }}
                        />
                        <Tip label={size.label} />
                      </button>
                    ))}
                  </div>

                  {TIP_PROFILES[canvas.pen.tip].bladed && (
                    <div className="pen-row" role="group" aria-label="Nib angle">
                      {NIB_ANGLES.map((choice) => {
                        const value = TIP_PROFILES[canvas.pen.tip].angle + choice.offset
                        const held = Math.abs(canvas.pen.angle - value) < 0.01
                        return (
                          <button
                            key={choice.label}
                            type="button"
                            aria-label={`${choice.label} nib angle`}
                            aria-pressed={held}
                            className={held ? 'tool active' : 'tool'}
                            onClick={() => canvas.setPen({ angle: value })}
                          >
                            <span
                              className="pen-nib"
                              style={{ transform: `rotate(${value}rad)` }}
                            />
                            <Tip label={choice.label} />
                          </button>
                        )
                      })}
                    </div>
                  )}

                  <div className="pen-row" role="group" aria-label="Ink colour">
                    {PEN_COLORS.map((swatch) => (
                      <button
                        key={swatch.label}
                        type="button"
                        aria-label={swatch.label}
                        aria-pressed={canvas.pen.color === swatch.value}
                        className={canvas.pen.color === swatch.value ? 'tool active' : 'tool'}
                        onClick={() => canvas.setPen({ color: swatch.value })}
                      >
                        <span className="pen-swatch" style={{ background: swatch.css }} />
                        <Tip label={swatch.label} />
                      </button>
                    ))}
                  </div>

                  {/*
                    Last in the flyout, under a rule, because it is the only row here
                    that is not about the mark. The four above choose what the ink looks
                    like; this one chooses whether the stroke survives as ink at all,
                    and grouping it with the nibs would hide that.

                    Absent on the three nibs that do not take it, the way the angle row
                    is absent on a nib that is not cut. A row of controls that are
                    present and inert is a row of questions about why they are inert.
                  */}
                  {tipTakesAssist(canvas.pen.tip) && (
                    <div className="pen-row" role="group" aria-label="Pen assist">
                      {ASSISTS.map((assist) => (
                        <button
                          key={assist.id}
                          type="button"
                          aria-label={assist.label}
                          aria-pressed={canvas.pen.assist === assist.id}
                          className={canvas.pen.assist === assist.id ? 'tool active' : 'tool'}
                          onClick={() => canvas.setPen({ assist: assist.id })}
                        >
                          <assist.Icon size={18} />
                          <Tip label={assist.label} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            )
          })}

          {/*
            The shape family, as one slot.

            The button is the shape it is holding: while a shape tool is armed it wears
            that shape's icon and the rail's active colour, so what the next drag will
            draw is readable without opening anything. Once the shape has been used the
            tool hands back to select and the button goes back to the family mark,
            which is the honest state - nothing is armed, and a button still lit would
            be pointing at a tool that is no longer in your hand.
          */}
          {shapes.length > 0 && (
            <div className="tool-slot">
              <button
                type="button"
                // Named for the family first and the armed shape second, so the name
                // a screen reader reads out is the same button every time and the
                // flyout's own "Rectangle" is the only thing called that.
                aria-label={isShapeTool(canvas.tool) ? `Shapes: ${armedShape.label}` : 'Shapes'}
                aria-pressed={isShapeTool(canvas.tool)}
                aria-expanded={railMenu === 'shapes'}
                className={isShapeTool(canvas.tool) ? 'tool has-more active' : 'tool has-more'}
                disabled={!canWrite}
                onClick={() => {
                  // Same bargain as the tools above: pressing the button of the thing
                  // already in your hand opens or puts away its menu, and pressing it
                  // otherwise arms the shape you last chose.
                  if (isShapeTool(canvas.tool)) {
                    setRailMenu((open) => (open === 'shapes' ? null : 'shapes'))
                    return
                  }
                  canvas.setTool(armedShape.id)
                }}
              >
                {isShapeTool(canvas.tool) ? <armedShape.Icon size={19} /> : <IconShapes size={19} />}
                <Tip
                  label={isShapeTool(canvas.tool) ? armedShape.label : 'Shapes'}
                  hint={isShapeTool(canvas.tool) ? armedShape.hint : undefined}
                />
              </button>

              {railMenu === 'shapes' && canWrite && (
                <div className="tool-submenu shape-menu" role="group" aria-label="Shape">
                  {/*
                    A grid rather than the single row this was while there were four of
                    them. Eight buttons in a line beside the rail is wider than the rail
                    is tall, and a flyout that long stops reading as one decision.
                  */}
                  <div className="shape-grid">
                    {shapes.map((entry) => (
                      <button
                        key={entry.id}
                        type="button"
                        aria-label={`${entry.label} (${entry.hint})`}
                        // The live tool, not the remembered one. A shape stays marked as
                        // chosen for as long as it is actually in your hand, and stops
                        // being marked the moment it has been used and put down.
                        aria-pressed={canvas.tool === entry.id}
                        className={canvas.tool === entry.id ? 'tool active' : 'tool'}
                        onClick={() => {
                          setShape(entry.id)
                          canvas.setTool(entry.id)
                          // The polygon is the one shape with something left to say
                          // after it has been picked, so its own row stays open.
                          if (entry.id !== 'polygon') setRailMenu(null)
                        }}
                      >
                        <entry.Icon size={18} />
                        <Tip label={entry.label} hint={entry.hint} />
                      </button>
                    ))}
                  </div>

                  {/*
                    How many sides, under a rule, and only while the polygon is the shape
                    in hand.

                    A stepper rather than ten buttons: the counts are a range and not a
                    set of alternatives, and nobody picks nine out of a row - they go one
                    up from eight. The number itself is the readout, so the row says what
                    the next polygon will be without a label.

                    It reshapes the selection as well as arming the tool. A count is the
                    polygon rather than a mode it was drawn in, and a hexagon that can
                    only become an octagon by being deleted and drawn again is a shape
                    with a typo in it.
                  */}
                  {canvas.tool === 'polygon' && (
                    <div className="shape-row" role="group" aria-label="Sides">
                      <button
                        type="button"
                        className="tool"
                        aria-label="Fewer sides"
                        disabled={canvas.polygonSides <= MIN_POLYGON_SIDES}
                        onClick={() => canvas.setPolygonSides(canvas.polygonSides - 1)}
                      >
                        <IconMinus size={16} />
                      </button>
                      <output className="shape-sides" aria-live="polite">
                        {canvas.polygonSides}
                      </output>
                      <button
                        type="button"
                        className="tool"
                        aria-label="More sides"
                        disabled={canvas.polygonSides >= MAX_POLYGON_SIDES}
                        onClick={() => canvas.setPolygonSides(canvas.polygonSides + 1)}
                      >
                        <IconPlus size={16} />
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          <hr />

          <button
            type="button"
            className="tool"
            aria-label="Duplicate selection"
            disabled={!canWrite || canvas.selection.length === 0}
            onClick={canvas.duplicateSelection}
          >
            <IconDuplicate size={19} />
            <Tip label="Duplicate" hint="Ctrl+D" />
          </button>

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
        {/*
          Touching the canvas puts the rail's flyout away.

          On capture, so it lands before the engine's own pointer handling and works
          whether the press starts a stroke, a shape or a marquee. The pen keeps a menu
          open across a whole session otherwise, since the pen stays in your hand after
          a stroke and nothing else was ever going to close it.
        */}
        <div
          className="canvas-host"
          ref={canvas.containerRef}
          data-paper={paper}
          onPointerDownCapture={dismissRailMenu}
        >
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
              onClick={() => {
                const added = canvas.addLines()
                if (added > 0) toast.success(`Added ${added} more line${added === 1 ? '' : 's'}.`)
              }}
            >
              <span>Add {PAGE_LINES_STEP} lines</span>
            </button>
          )}
        </div>

        {/*
          The diary's pages, beside the one being written.

          A column of the body rather than something floating over the canvas, so the
          paper re-centres in what is left instead of being covered by the list: the
          camera fences a lea to a fixed measure and centres it in the host, and the
          host is what narrows. Below a narrow window it goes back to floating, because
          there is no room left to take.
        */}
        {/*
          The way back to a list you have closed.
          The bar has the same toggle, but a button in a row of eight icons is not what
          somebody looks at when they wonder where their pages went. This is on the edge
          the list came off, it carries the count so it says what is behind it, and it
          exists only while the list is closed.
        */}
        {spec.column !== null && !pagesOpen && (
          <button
            type="button"
            className="lea-pages-tab"
            title="Show the pages"
            aria-label="Show the pages"
            onClick={() => {
              writePagesPreference(true)
              setPagesOpen(true)
            }}
          >
            <IconPanel size={17} />
            <span className="lea-pages-tab-count">{canvas.pages.length}</span>
          </button>
        )}

        {spec.column !== null && pagesOpen && (
          <LeaPages
            pages={canvas.pages}
            index={canvas.pageIndex}
            editable={canWrite}
            onTurn={canvas.turnToPage}
            onAdd={() => {
              const created = canvas.addPage()
              if (created >= 0) toast.success(`Started page ${created + 1}.`)
            }}
            onRemove={(index) => {
              // Torn out, not achieved: the news is that writing is gone, so it reads
              // in the same colour a failure would. Same choice as the boards list.
              if (canvas.removePage(index)) toast.error(`Tore out page ${index + 1}.`)
            }}
            onCollapse={() => {
              writePagesPreference(false)
              setPagesOpen(false)
            }}
          />
        )}

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
                <div className="dropdown text-size" ref={sizeMenuRoot}>
                  <button
                    type="button"
                    className="dropdown-button"
                    aria-label="Text size"
                    aria-haspopup="listbox"
                    aria-expanded={sizeMenuOpen}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => setSizeMenuOpen((shown) => !shown)}
                  >
                    {canvas.textSize ?? 'Mixed'}
                    <IconChevronDown size={14} />
                  </button>

                  {sizeMenuOpen && (
                    <div className="menu menu-compact" role="listbox" aria-label="Text size">
                      {TEXT_SIZES.map((size) => (
                        <button
                          key={size}
                          type="button"
                          role="option"
                          aria-selected={size === canvas.textSize}
                          className={size === canvas.textSize ? 'menu-item selected' : 'menu-item'}
                          onMouseDown={(event) => event.preventDefault()}
                          onClick={() => {
                            setSizeMenuOpen(false)
                            canvas.setTextSize(size)
                          }}
                        >
                          <span className="menu-label">{size}</span>
                          {size === canvas.textSize && <IconCheck size={15} />}
                        </button>
                      ))}
                    </div>
                  )}
                </div>

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

        {/*
          One banner, and the order is the order of what the reader can do about it.

          Your own tab lock first even when the owner's is also on: it has an Unlock
          button right there, and telling somebody to wait for the owner while their own
          toggle is down would send them off to wait for nothing. The owner's lock names
          the owner, because the reader cannot lift it and needs to know who can - a
          notice that only says "locked" reads as a fault. The role notice is last,
          because it is the one that does not change.
        */}
        <div className="board-notices">
          {locked ? (
            <p className="banner">
              This {noun} is locked in this tab.
              <button type="button" className="link" onClick={() => setLocked(false)}>
                Unlock
              </button>
            </p>
          ) : boardLocked ? (
            <p className="banner">
              {role === 'owner'
                ? `You have locked this ${noun}. Nobody can edit it until you unlock it.`
                : `The owner has locked this ${noun} against edits.`}
              {role === 'owner' && (
                <button type="button" className="link" onClick={toggleLock}>
                  Unlock
                </button>
              )}
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

      {shareOpen && (
        <ShareDialog
          boardId={boardId}
          title={title}
          noun={noun}
          onClose={() => setShareOpen(false)}
          // The dialog and this view show the same two facts, so the dialog hands them
          // back rather than each side fetching. The lock still arrives properly through
          // the reconnect the server's eviction causes; this only saves the owner
          // watching their own button lag behind their own click.
          onChanged={(state) => {
            setShareMode(state.mode)
            setBoardLocked(state.is_locked)
          }}
        />
      )}

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
