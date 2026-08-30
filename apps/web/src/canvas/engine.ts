/**
 * The canvas engine: camera, renderer, spatial index, tools, input.
 *
 * Owns no document state. Every object lives in the Y.Doc; this keeps a read-through
 * cache rebuilt from Y observers, because reading 5,000 Y.Maps per frame is far too
 * slow and because a second mutable copy would drift the moment a peer edits.
 *
 * ARCHITECTURE 5: never render on every state change. Changes mark the scene dirty and
 * exactly one render happens per animation frame. A drag emits a transaction per
 * pointermove, and rendering synchronously on each would triple the frame cost.
 *
 * This module must not import from src/features. The engine stays extractable.
 */

import {
  type ArrowRouting,
  type ArrowRoutingPatch,
  type BindingData,
  type ObjectData,
  DEFAULT_POLYGON_SIDES,
  MAX_POLYGON_SIDES,
  MIN_POLYGON_SIDES,
  TIP_PROFILES,
  absolutePoints,
  arrowPolyline,
  isArrowLike,
  isFreedraw,
  isTextBearing,
  objectBounds,
  resolveArrowProps,
  resolveFreedrawProps,
  resolveTextProps,
  strokeOutline,
  type TextProps,
  textProps,
} from '@meadow/schema'
import { Application, Container, Graphics, Rectangle } from 'pixi.js'

import {
  Camera,
  type Point,
  type ViewTransform,
  type WorldRect,
  projectPoint,
  viewTransform,
} from './camera'
import { TextLayer } from './overlay/textLayer'
import { type Wanderer, type WandererSelection, WandererLayer } from './overlay/wandererLayer'
import { SpatialIndex } from './spatialIndex'
import {
  type CanvasSurface,
  DEFAULT_SURFACE,
  type SurfaceType,
  surfaceClass,
} from './surface'
import { type ArrowDraw, ArrowPass } from './renderers/arrowPass'
import { type InkDraw, InkPass } from './renderers/inkPass'
import { ShapeBatch } from './renderers/shapeBatch'
import type { SnapGuide } from './snapping'
import { measureBaselineOffset, whenFontsReady } from './text/measure'
import { FONT_STACKS } from './text/textStyle'
import {
  BINDING_COLOR,
  GUIDE_COLOR,
  connectorInk,
  MARQUEE_FILL,
  SELECTION_COLOR,
  isDarkSurface,
  readCanvasInk,
  resolveStyle,
  shapeKindFor,
} from './style'
import { HANDLE_SIZE_PX, RESIZE_HANDLES, handlePositions } from './transform'
import { ARROW_HANDLE_RADIUS_PX, arrowHandles } from './arrowHandles'
import {
  CONNECTOR_OFFSET_PX,
  CONNECTOR_RADIUS_PX,
  CONNECTOR_SIDES,
  connectorPoints,
} from './connectors'
import { hitsObject, unionBounds } from './hitTest'
import { createHandTool } from './tools/handTool'
import { createSelectTool } from './tools/selectTool'
import { createShapeTool } from './tools/shapeTool'
import { createArrowTool } from './tools/arrowTool'
import { createPenTool } from './tools/penTool'
import { createTextTool } from './tools/textTool'
import type { TextMark } from '../doc/richText'
import type {
  CanvasPointerEvent,
  PenSettings,
  Tool,
  ToolContext,
  ToolId,
  WetInk,
} from './tools/types'

/**
 * Greedy word wrap for thumbnail text.
 *
 * Not a layout engine and not trying to be: the real wrapping is the browser's, in the
 * DOM overlay. This only has to put roughly the right words on roughly the right lines
 * at a size where a word is a few pixels wide.
 */
function wrapText(context: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const lines: string[] = []

  for (const paragraph of text.split('\n')) {
    if (paragraph === '') {
      lines.push('')
      continue
    }

    let current = ''
    for (const word of paragraph.split(/\s+/)) {
      const candidate = current === '' ? word : `${current} ${word}`
      if (current !== '' && context.measureText(candidate).width > maxWidth) {
        lines.push(current)
        current = word
      } else {
        current = candidate
      }
    }
    if (current !== '') lines.push(current)
  }

  return lines
}

/** A caption box as a comparable string. Rounded: sub-pixel drift is not a change. */
function gapKey(bounds: ArrowDraw['gap']): string {
  if (bounds === null || bounds === undefined) return ''
  return [bounds.minX, bounds.minY, bounds.maxX, bounds.maxY]
    .map((value) => Math.round(value))
    .join(',')
}

/** Minimum instance capacity, so small boards do not reallocate on the first few adds. */
const MIN_BATCH_CAPACITY = 2048

/** Half-length of the ticks that cap a spacing guide, in screen pixels. */
const GUIDE_TICK = 4.5

/**
 * How finely to flatten a curved arrow, given its length on screen.
 *
 * The whole reason a curve is derived rather than stored is that the tessellation can
 * follow the zoom. A fixed count is visibly faceted on a long arrow zoomed in and
 * wasteful on a short one zoomed out; roughly one segment every six screen pixels is
 * below what an edge can show either way. The ceiling is what stops a single arrow
 * spanning a zoomed-in board from recording thousands of line segments per frame.
 */
function curveSegments(points: readonly number[], scale: number): number {
  const last = points.length - 2
  const length = Math.hypot(points[last] - points[0], points[last + 1] - points[1]) * scale
  return Math.max(12, Math.min(160, Math.ceil(length / 6)))
}

/** Grid cell in world units at 1x, and the screen band its spacing is held inside. */
const GRID_BASE_WORLD = 20
const GRID_MIN_PX = 14
const GRID_MAX_PX = 56

/**
 * The ruling on the `ruled` surface: one line every 28 world units.
 *
 * Stepped by two rather than by the grid's four. Graph paper is a ruler and wants a
 * decimal-ish cell; a diary's ruling is a writing line, and halving it is the
 * difference between wide-ruled and narrow-ruled paper rather than a different kind
 * of paper. The band is a little taller than the grid's for the same reason: lines
 * you are meant to write between should not close up to a hatch.
 */
/**
 * The header: paper above the first rule, where the date goes.
 *
 * Real ruled stationery leaves this, and it is not decoration. A page whose first line
 * starts at the top of the window opens with its writing already under the toolbar,
 * and there is nowhere to put the date.
 */
const PAGE_HEADER = 108

/**
 * Air above the header, so the top of the page clears whatever floats over the canvas.
 *
 * Separate from the header rather than folded into it, because they answer different
 * questions: this one is about the chrome of the app, and the header is part of the
 * stationery. Changing the toolbar should move one of them and not the other.
 */
const COLUMN_TOP_MARGIN = PAGE_HEADER + 28

/**
 * Desk left showing above the sheet, in world units.
 *
 * Not part of the page. The fence's top used to be the sheet's own top edge, so
 * scrolling to the start of a page put the paper flush against the app's bar and the
 * two read as one surface - a page tucked under the chrome rather than lying on a
 * desk under it. A few units of desk is what says the sheet has a top edge at all.
 */
const PAGE_TOP_AIR = 20

/**
 * How many rules a page has before anybody adds more, and how many an add adds.
 *
 * A page rather than an endless roll. Writing into something with no bottom is a
 * different feeling from writing into something with an end, and a diary is the second
 * one: the point of a page is that you can fill it.
 */
export const DEFAULT_PAGE_LINES = 25
export const PAGE_LINES_STEP = 10

/**
 * Which band the header's line sits on, counted back from the first rule.
 *
 * Geometry only. What is written there - the subject and the date - is not a row of
 * the page and not an object in the document: each is one value with one right answer,
 * so each is a control on the header and a key in `meta`, rather than something you
 * write and could write twice.
 */
const HEADER_ROW = -2

/** How much of the column's width the date takes, in world units. */
const DATE_WIDTH = 230

/** And the subject, which is a line to write on rather than the whole measure. */
const SUBJECT_WIDTH = 330

/**
 * How far a page may be zoomed, as a multiple of its set size.
 *
 * Narrow on purpose. The measure a writing column is built around is how much text
 * fits on a line, and a wide zoom range makes that depend on the wheel. This is the
 * range in which a page is still the page and merely easier or harder to read.
 */
const PAGE_MIN_ZOOM = 0.5
const PAGE_MAX_ZOOM = 2

/** Paper either side of the writing column, in world units. The page's margins. */
const PAGE_MARGIN = 36

/**
 * From one page of a lea's left edge to the next one's, in world units.
 *
 * A diary's pages are laid out side by side in the same world rather than stacked in
 * the same place, which is what lets a page grow to any length without moving a line
 * of writing on any other page. The camera is fenced to one page at a time, so the
 * desk between them is never on screen; it exists so that a row can be told which page
 * it is on by where it is, and so that nothing dropped a little outside a column can
 * be mistaken for writing on the next one.
 *
 * A constant, and deliberately not `width + gap`. Derived from the measure, every page
 * after the first moves the day the measure changes, and the writing already on them
 * does not: rows are attributed to a page by where they are, so a document written at
 * one width would find its later pages empty at another. The pitch is the archive's
 * shape and the measure is a typographic choice, and only one of them may move. Any
 * column narrower than this leaves desk between the pages, which is all that is asked
 * of it.
 */
const PAGE_PITCH = 2760

/**
 * Where a page's writing lives, in world x.
 *
 * The one function that turns a slot into geometry, exported because the document
 * layer needs the same answer: removing a page removes the objects inside its span,
 * and a second copy of this arithmetic there is a second copy that can drift.
 */
export function pageSpan(column: WritingColumn, slot: number): { left: number; right: number } {
  const left = slot * PAGE_PITCH
  return { left, right: left + column.width }
}

/** The distance from one page's left edge to the next one's. */
export function pageStride(): number {
  return PAGE_PITCH
}

/** How far the ruled lines stop short of the page's edge, in world units. */
const RULE_INSET = 22

/**
 * How far below its rule the writing sits, in world units. Negative lifts it clear.
 *
 * Zero is the typographically correct answer, a baseline exactly on the line, and it
 * is not the floor: this went from three units below the rule - far enough that the
 * rule visibly crossed the feet of the letters - through zero and out the other side.
 * A hair of daylight under the writing is a real look, and the one asked for here.
 *
 * Kept small in either direction. Much past a unit or two the writing stops belonging
 * to a rule at all and starts floating between two of them, which is the thing the
 * whole ruled surface exists to prevent.
 */
const WRITING_DROP = -1

/*
 * How wheel scrolling is eased. See `stepWheel`.
 *
 * The time constant is the whole feel of it. Under about 50ms the smoothing stops
 * being visible and a notch is a jump again; over about 150ms the page keeps moving
 * after you have stopped asking it to, which reads as weight rather than as response.
 * 90ms settles a notch in roughly a fifth of a second, which is fast enough to feel
 * connected to the wheel and slow enough that the ruling never strobes.
 */
const WHEEL_TAU_MS = 90
/* A line, for the browsers that measure the wheel in lines rather than pixels. */
const WHEEL_LINE_PX = 16
/*
 * The most scrolling that can be owed at once. A fast flick can queue thousands of
 * pixels, and without a ceiling the page carries on travelling long after the wheel
 * has stopped - the one thing worse than a jump.
 */
const WHEEL_MAX_PENDING = 1600

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

/**
 * A writing column: how wide the page is, and the type it is ruled for.
 *
 * The metrics rather than the geometry, because the engine needs both and they have to
 * agree exactly: the ruling is spaced at one line of this type, and a row created by
 * clicking on a rule has to be *this* type or its writing lands somewhere else. Two
 * numbers that must agree are one number and a derivation.
 *
 * `width` is world units; the rest are the text object's own props.
 *
 * No padding, and that is load-bearing rather than an omission. A row's box has to be
 * exactly the band it is written on: rows are placed one `fontSize * lineHeight` apart,
 * so a box padded top and bottom is taller than the pitch and overlaps the row below
 * it, and a click meant for the empty rule between two lines lands in the line above
 * instead. The margin beside the writing is the paper's, `PAGE_MARGIN`, not the row's.
 */
export type WritingColumn = {
  width: number
  fontSize: number
  lineHeight: number
}


const RULE_BASE_WORLD = 28
const RULE_MIN_PX = 18
const RULE_MAX_PX = 72

export type EngineHost = {
  /** Ascending z-order of every object id. */
  order(): readonly string[]
  /** Live object lookup. */
  object(id: string): ObjectData | undefined
  allObjects(): Iterable<ObjectData>
  readonly canWrite: boolean
  /** The local person's display name, stamped onto a sticky when one is created. */
  readonly authorName: string
  createObject(input: Partial<ObjectData> & { type: ObjectData['type'] }): string | null
  applyPatches(patches: { id: string; patch: Partial<ObjectData> }[]): void
  deleteObjects(ids: readonly string[]): void
  commit(): void
  undo(): void
  redo(): void
  bringForward(ids: readonly string[]): void
  sendBackward(ids: readonly string[]): void
  bringToFront(ids: readonly string[]): void
  sendToBack(ids: readonly string[]): void
  setArrowPoints(id: string, absolute: readonly number[]): void
  bindArrow(input: Omit<BindingData, 'id'>): void
  setArrowRouting(id: string, patch: ArrowRoutingPatch): void
  /** Static HTML for a text-bearing object, for the idle overlay. */
  textHtml(id: string): string
  /** Plain text for the same object, for thumbnails and anything non-visual. */
  textPlain(id: string): string
  /**
   * Mount a rich-text editor into an overlay element. Returns the teardown, or null
   * when this host cannot edit. The engine never learns what the editor is.
   */
  /**
   * Mount an editor into `element`.
   *
   * `surface` is what the page contributes rather than the object: the ink an object
   * that names no colour is drawn in, the type a ruled page sets over whatever its
   * rows were created with, and where the caret goes when it walks off the top or the
   * bottom. The editor has to agree with the idle text layer on the first two, or text
   * changes appearance the moment you stop typing.
   */
  beginEdit(
    id: string,
    element: HTMLElement,
    onExit: () => void,
    surface: {
      ink: number
      type: SurfaceType | null
      onLeave?: (direction: 'up' | 'down') => boolean
    },
  ): (() => void) | null
  /** Toggle an inline mark in the live editor. No-op when nothing is being edited. */
  toggleTextMark(mark: TextMark): void
}

export type EngineEvents = {
  onSelectionChange?(ids: string[]): void
  /** Fired only when the count changes, never on every geometry edit. */
  onObjectCountChange?(count: number): void
  onToolChange?(tool: ToolId): void
  onCameraChange?(camera: { x: number; y: number; zoom: number }): void
  /** The id of the object currently being text-edited, or null. */
  onEditingChange?(id: string | null): void
  /**
   * The pointer in world coordinates, or null when it leaves the canvas. Fires at the
   * raw event rate; throttling belongs to the consumer, which knows what it costs to
   * publish.
   */
  onPointerWorld?(point: Point | null): void
}

export class CanvasEngine {
  readonly camera = new Camera()
  private readonly index = new SpatialIndex()
  private readonly cache = new Map<string, ObjectData>()
  private readonly selected = new Set<string>()

  private app!: Application
  private world!: Container
  private overlay!: Graphics
  private batch!: ShapeBatch
  private arrows!: ArrowPass
  private ink!: InkPass
  /** The stroke under the pointer, drawn every frame until the pen commits it. */
  private wet!: Graphics
  private textLayer!: TextLayer
  private wanderers!: WandererLayer

  /** Remote presence. Ephemeral, never read from or written to the document. */
  private wandererState: readonly Wanderer[] = []

  /**
   * Auto-height measurements taken during a render, flushed after it.
   *
   * Writing to the document from inside the render walk would fire a Y observer that
   * marks the scene dirty while it is still being drawn. Collecting and flushing keeps
   * the write out of the render, and batches a screenful of text objects into one
   * transaction instead of one each.
   */
  private readonly pendingHeights = new Map<string, number>()

  private editing: { id: string; teardown(): void } | null = null
  private closingEditor = false

  /** Reused across frames so the render walk allocates nothing. */
  private readonly overlayObjects: { object: ObjectData; z: number }[] = []

  /**
   * The caption box each arrow's shaft was last cut around, keyed by arrow id.
   *
   * The gap is measured from a mounted DOM element, and the overlay is synced *after*
   * the scene is painted, so on the frame a caption first appears there is nothing to
   * measure yet. Keeping what was used lets the frame end by checking whether the
   * answer has changed and asking for one more render if it has. Without it the line
   * runs through the words until something unrelated happens to redraw the board.
   */
  private readonly labelGaps = new Map<string, string>()
  private lastTransform: ViewTransform = { tx: 0, ty: 0, scale: 1 }

  private tool!: Tool
  private toolId: ToolId = 'select'
  private readonly context: ToolContext

  private marquee: WorldRect | null = null
  private guides: readonly SnapGuide[] = []
  private hoverTarget: string | null = null
  /** The shape showing connector dots. Hover state, published by the select tool. */
  private connectorHost: string | null = null

  /**
   * The routing new arrows are drawn with, chosen in the tool rail.
   *
   * A property of the *tool*, not of the selection. Picking a shape of connector before
   * drawing one is how every other drawing tool works, and it is the difference between
   * choosing what you are about to make and correcting what you already made.
   */
  private arrowRouting: ArrowRouting = 'straight'
  /** How many sides the polygon tool draws with. See `setPolygonSides`. */
  private polygonSides: number = DEFAULT_POLYGON_SIDES

  /**
   * How the pen is set. Engine state rather than document state: it describes the next
   * stroke, so it belongs with the active tool and not with anything already drawn.
   */
  private pen: PenSettings = {
    tip: 'round',
    size: 3,
    angle: -Math.PI / 7,
    color: null,
    assist: 'off',
  }

  private wetInk: WetInk | null = null

  /** Whether the wet layer currently holds anything, so a still frame does not clear it. */
  private wetDrawn = false

  /**
   * Whether the ink layer's geometry still matches the document.
   *
   * The one piece of bookkeeping the ink pass costs, and the reason it is cheap: the
   * layer is rebuilt when this says so and never merely because a frame was asked for.
   * Set by a change to a `freedraw` object, and by the theme, since a stroke with no
   * colour of its own is painted in the surface's ink.
   */
  private inkDirty = true

  /*
   * Wheel scrolling, eased.
   *
   * A mouse wheel does not send a stream: one notch is a single 100px event, and
   * applying it the moment it arrives moves the page in one jump. On a free canvas
   * that reads as a big surface being shoved; on a lea, where the whole picture is a
   * sheet of paper sliding under a fixed window, it reads as a stutter, because the
   * ruling is a repeating pattern and the eye tracks it.
   *
   * So a wheel event does not move the camera. It adds to a target, and the render
   * loop walks toward that target by a fixed fraction of what is left per unit of
   * time. Exponentially, so it starts at the speed you asked for and settles rather
   * than stopping dead - and against elapsed time rather than per frame, so it takes
   * the same amount of wall clock at 60Hz and at 144.
   *
   * No gain on the delta. Smoothing is about *when* the movement happens, not how much
   * of it there is: multiplying it up as well is how a page ends up outrunning the
   * wheel, which is the other half of scrolling that feels wrong.
   */
  private wheelPending = { x: 0, y: 0 }
  private wheelAt = 0

  private dirty = true
  private frame = 0
  private disposed = false
  private lastCameraVersion = -1
  private spacePanning = false

  /**
   * The theme's default connector colour, cached because it is read for every arrow
   * on every frame and `getComputedStyle` is not a per-frame call.
   */
  private canvasInk = 0x2a3340
  private darkSurface = false

  private resizeObserver: ResizeObserver | null = null

  private gridVisible = true
  private lastGridKey = ''
  private surface: CanvasSurface = DEFAULT_SURFACE
  /*
   * Whether `init` finished.
   *
   * Not the same question as `this.app === undefined`, which is what the theme sync
   * used to ask. The Application object exists one await before the layers that hang
   * off it do, so anything called from a React effect during that window found an app
   * and no text layer. That window is small and entirely reachable: the board view
   * learns the glade's kind from a REST response and applies the surface the moment
   * it lands, which is very often exactly then.
   */
  private ready = false

  /*
   * The tools this board offers, or null for all of them.
   *
   * Held here rather than only in the rail, because the rail is not the only way to
   * reach a tool: every one of them has a single-key shortcut, and a lea that hides
   * the rectangle button while R still draws rectangles has not removed anything. The
   * engine stays generic - it does not know what a lea is - and simply refuses to
   * enter a tool it was not given.
   */
  private available: ReadonlySet<ToolId> | null = null

  /**
   * The world width of the writing column, or null for an unfenced canvas.
   *
   * The engine does not know what a lea is; it knows that some boards are a column
   * you scroll down rather than a plane you fly over, and that is the whole of it.
   */
  private column: WritingColumn | null = null
  /** The measured first-baseline offset of `column`'s type. See `rulePhase`. */
  private columnBaseline = 0
  /** How many rules this page has. Document state, so it arrives from the host. */
  private pageLines = DEFAULT_PAGE_LINES
  /**
   * Which page of the diary is on screen.
   *
   * A slot rather than an index into anything: the engine holds no list of pages and
   * does not know how many there are. It knows which strip of the world it is fenced
   * to, and the view above it decides which strip that is.
   */
  private pageSlot = 0

  /** Rolling render cost, exposed for the perf overlay. */
  private lastRenderMs = 0
  private lastVisible = 0
  private lastReportedCount = -1

  constructor(
    private readonly element: HTMLElement,
    private readonly host: EngineHost,
    private readonly events: EngineEvents = {},
  ) {
    this.context = this.createToolContext()
  }

  async init(): Promise<void> {
    // ARCHITECTURE 1: text metrics feed CRDT bounds, so the first frame must not be
    // measured against fallback faces. Waiting here is the cheapest way to guarantee
    // that; the alternative is every client writing a different height for the same
    // paragraph depending on how fast its fonts arrived.
    await whenFontsReady()
    if (this.disposed) return

    this.app = new Application()
    await this.app.init({
      resizeTo: this.element,
      // Transparent, so the host's CSS surface and its grid show through. The board's
      // background is a theme concern and CSS is where the theme lives; this also
      // keeps the grid out of `captureThumbnail`, which renders the stage and would
      // otherwise put graph paper behind every preview in the list.
      backgroundAlpha: 0,
      // On. The SDF batch antialiases itself in the fragment shader and does not need
      // this, but everything drawn as tessellated geometry does: arrows, lines, the
      // marquee, the selection box and its handles are all `Graphics`, and a
      // tessellated diagonal without multisampling is a staircase. That staircase is
      // the single most obvious difference between this canvas and a polished one.
      //
      // It costs fill rate rather than draw calls, so it does not move the 5k-object
      // budget the batch was built for. `pnpm bench:arrows` is the check if it ever
      // looks like it does.
      antialias: true,
      // The SDF shader is GLSL only for now. A WGSL twin is worth writing once the
      // approach has settled, not before.
      preference: 'webgl',
      autoDensity: true,
      // Render at device pixels, not CSS pixels. Without this a 2x display draws every
      // edge at half the resolution it can show and the result reads as soft and
      // steppy however good the antialiasing is.
      resolution: window.devicePixelRatio || 1,
      autoStart: false,
    })
    if (this.disposed) {
      this.app.destroy(true, { children: true })
      return
    }

    this.canvasInk = readCanvasInk(this.element)
    this.darkSurface = isDarkSurface(this.element)

    this.snapToDevicePixels()
    // The host's position changes with the window, and so does the rounding error.
    this.resizeObserver = new ResizeObserver(() => this.onHostResized())
    this.resizeObserver.observe(document.documentElement)
    // And the host itself, whose size is a different question from its position.
    // What is done about a size change is in `syncHostSize`, not here.
    this.resizeObserver.observe(this.element)

    // The overlay is positioned against this element, so it cannot be static.
    if (getComputedStyle(this.element).position === 'static') {
      this.element.style.position = 'relative'
    }

    this.element.appendChild(this.app.canvas)
    this.app.canvas.style.touchAction = 'none'
    this.app.canvas.style.display = 'block'

    this.textLayer = new TextLayer(this.element, {
      html: (id) => this.host.textHtml(id),
      onMeasured: (id, height) => {
        this.pendingHeights.set(id, height)
      },
    })
    this.textLayer.ink = this.canvasInk
    this.textLayer.columnType = this.surfaceType

    this.world = new Container()
    this.batch = new ShapeBatch(MIN_BATCH_CAPACITY)
    this.arrows = new ArrowPass()
    this.ink = new InkPass()
    this.wet = new Graphics()
    // Order is the z-order between the passes, and it is fixed: connectors draw over
    // shapes, and ink draws over both. Ink is annotation, and annotation that goes
    // under the thing it annotates is not annotation. Wet ink sits above dry so the
    // stroke being drawn is never hidden behind one already finished.
    this.world.addChild(this.batch.view)
    this.world.addChild(this.arrows.view)
    this.world.addChild(this.ink.view)
    this.world.addChild(this.wet)

    this.overlay = new Graphics()

    this.wanderers = new WandererLayer()

    this.app.stage.addChild(this.world)
    this.app.stage.addChild(this.overlay)
    // Above the selection chrome: a remote cursor is the one thing that should never
    // be hidden behind local UI.
    this.app.stage.addChild(this.wanderers.view)

    this.setTool('select')
    this.attachInput()
    this.ready = true
    this.resync()
    this.loop()
  }

  destroy(): void {
    this.disposed = true
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    cancelAnimationFrame(this.frame)
    this.stopEditing()
    this.detachInput()
    this.ready = false
    if (this.textLayer !== undefined) this.textLayer.destroy()
    if (this.wanderers !== undefined) this.wanderers.destroy()
    if (this.arrows !== undefined) this.arrows.destroy()
    if (this.ink !== undefined) this.ink.destroy()
    if (this.app !== undefined) this.app.destroy(true, { children: true })
  }

  // --- public API -------------------------------------------------------------

  get activeTool(): ToolId {
    return this.toolId
  }

  get stats(): { renderMs: number; visible: number; total: number; zoom: number } {
    return {
      renderMs: this.lastRenderMs,
      visible: this.lastVisible,
      total: this.cache.size,
      zoom: this.camera.zoom,
    }
  }

  /**
   * Nudge the host onto whole device pixels.
   *
   * At fractional display scaling - Windows at 125% or 150%, which is most Windows
   * machines - an element whose height is a round number of CSS pixels is a
   * *fractional* number of device pixels, so everything below it starts on a half
   * pixel. Measured on this layout at dpr 1.25: the canvas's top edge lands at 52.5
   * device pixels. The browser cannot blit a bitmap to half a pixel, so it resamples
   * the whole canvas, and the result is a board that is uniformly, slightly soft at
   * every zoom while the DOM chrome beside it stays sharp. DOM text escapes this
   * because the browser rasterises glyphs at their final subpixel position; a canvas
   * is one bitmap and has no such luxury.
   *
   * The correction is a sub-pixel translate on the host. Both layers live inside it -
   * the WebGL canvas and the DOM text overlay - so they move together and the
   * alignment `pnpm smoke:overlay` guards is untouched. Integer ratios need nothing
   * and get nothing.
   */
  /** The host moved or changed size: re-snap, re-size the renderer, and redraw. */
  private onHostResized(): void {
    if (this.disposed) return
    this.snapToDevicePixels()
    this.requestRender()
  }

  private snapToDevicePixels(): void {
    if (this.disposed) return

    const ratio = window.devicePixelRatio || 1

    // Measure without our own correction applied, or each call compounds the last.
    this.element.style.transform = ''
    if (Number.isInteger(ratio)) return

    const rect = this.element.getBoundingClientRect()
    const dx = (Math.round(rect.left * ratio) - rect.left * ratio) / ratio
    const dy = (Math.round(rect.top * ratio) - rect.top * ratio) / ratio

    if (dx === 0 && dy === 0) return
    this.element.style.transform = `translate(${dx}px, ${dy}px)`
  }

  /**
   * Re-read the theme's canvas colour.
   *
   * WebGL cannot see the cascade, so the one surface that is not CSS has to be told.
   * Called by the board view when the theme toggle fires.
   */
  syncTheme(): void {
    if (!this.ready) return
    // Only the ink. The board's surface and its grid are CSS and re-resolve
    // themselves the moment the root's colour-scheme changes.
    this.canvasInk = readCanvasInk(this.element)
    this.darkSurface = isDarkSurface(this.element)
    this.textLayer.ink = this.canvasInk
    // A stroke that never chose a colour is painted in the surface's ink, so the
    // theme changing is a geometry-preserving but colour-changing edit to every one
    // of them, and the only way to repaint a retained layer is to rebuild it.
    this.inkDirty = true
    this.requestRender()
  }

  /** Show or hide the graph paper. Purely cosmetic; nothing else reads it. */
  setGridVisible(visible: boolean): void {
    this.gridVisible = visible
    this.element.classList.toggle('no-grid', !visible)
    if (visible) {
      // The class was toggled off while the camera moved, so the offsets are stale.
      this.lastGridKey = ''
      this.syncGrid(this.lastTransform)
    }
  }

  get gridShown(): boolean {
    return this.gridVisible
  }

  /**
   * Choose the paper.
   *
   * The class is what actually paints it; this method exists because the repeating
   * layers have to be positioned against the camera, and only the engine knows where
   * the camera is. Idempotent, and safe to call before `init`: the class lands on the
   * host either way and the first camera sync writes the offsets.
   */
  setSurface(surface: CanvasSurface): void {
    if (surface === this.surface) return

    this.element.classList.remove(surfaceClass(this.surface))
    this.surface = surface
    this.element.classList.add(surfaceClass(surface))

    // The two surfaces write different numbers of background layers, so the cached
    // key describes a string that is no longer on the element.
    this.lastGridKey = ''
    this.syncGrid(this.lastTransform)
    // The ruled surface paints a warm paper rather than the theme's board colour, and
    // `isDarkSurface` reads that colour back to pick default fills and ink.
    this.syncTheme()
  }

  /**
   * Keep the CSS grid in step with the camera.
   *
   * The cell is chosen in world units so the grid means something - it is a ruler,
   * not a texture - but its *screen* spacing is held in a legible band by stepping
   * the world cell through powers of four. Zoomed far out the cells would otherwise
   * converge into a grey wash; zoomed far in there would be one line on screen.
   *
   * The offset is the camera's own translation modulo the spacing, taken from the
   * same device-pixel-snapped transform the two render layers use, so the grid never
   * shimmers against the shapes sitting on it.
   */
  private syncGrid(transform: ViewTransform): void {
    /*
     * The lea is not governed by this toggle, and must not be. Its custom properties
     * are the page's geometry - where the sheet is, where the header row is, how wide
     * the measure is - and the board view positions the subject and date fields from
     * them. Skipping the sync while the ruling is hidden froze those numbers at
     * whatever the camera was doing when it was hidden, and the header stayed behind
     * while the page moved under it. Hiding the ruling is one line of stylesheet,
     * `.surface-ruled.no-grid::after`, and it is the stylesheet's business alone.
     */
    if (this.surface === 'ruled') {
      this.syncRuling(transform)
      return
    }
    if (!this.gridVisible) return

    let world = GRID_BASE_WORLD
    let minor = world * transform.scale
    while (minor < GRID_MIN_PX) {
      world *= 4
      minor = world * transform.scale
    }
    while (minor > GRID_MAX_PX) {
      world /= 4
      minor = world * transform.scale
    }
    const major = minor * 4

    const phase = (offset: number, size: number): number => ((offset % size) + size) % size
    const minorX = phase(transform.tx, minor)
    const minorY = phase(transform.ty, minor)
    const majorX = phase(transform.tx, major)
    const majorY = phase(transform.ty, major)

    // One string compare instead of four style writes on a frame that did not move.
    const key = `${minor}|${minorX}|${minorY}|${majorX}|${majorY}`
    if (key === this.lastGridKey) return
    this.lastGridKey = key

    const style = this.element.style
    style.backgroundSize = `${major}px ${major}px, ${major}px ${major}px, ${minor}px ${minor}px, ${minor}px ${minor}px`
    style.backgroundPosition = `${majorX}px ${majorY}px, ${majorX}px ${majorY}px, ${minorX}px ${minorY}px, ${minorX}px ${minorY}px`
  }

  /**
   * The ruled surface's writing lines, kept in step with the camera.
   *
   * Horizontal only, and stepped by two so the line height stays in a band you could
   * actually write in at any zoom. The rest of the paper - its mottling, its fibre and
   * the shade at its edges - is not drawn on the page and does not move with it, so it
   * lives on the host's `::before` and is none of this method's business.
   */
  private syncRuling(transform: ViewTransform): void {
    /*
     * On a writing column the ruling is not decoration, it is the type's own leading:
     * one line of paper per line of text, phased so a rule lands where a line of
     * writing ends. Getting this from the column rather than from a constant is what
     * makes the writing sit *on* the lines instead of drifting across them.
     *
     * Elsewhere it is a texture, and it steps through a legible band with the zoom the
     * way the graph paper does.
     */
    const column = this.column
    if (column !== null) {
      const scale = transform.scale
      const rule = this.ruleSpacing * scale

      // Where the sheet is on screen. Computed from the same transform as everything
      // else rather than from the viewport - one source of truth for where the page's
      // own corner landed - so the paper, the ruling and the header cannot disagree.
      const project = (worldY: number): number => worldY * scale + transform.ty
      const columnLeft = this.pageOrigin * scale + transform.tx
      const pageLeft = columnLeft - PAGE_MARGIN * scale
      const pageWidth = (column.width + PAGE_MARGIN * 2) * scale

      // The rule a row is written on, and so the first and the last of them.
      const firstRule = project(this.rulePhase + this.ruleSpacing)
      const ruleSpan = (this.pageLines - 1) * rule

      const pageTop = project(-COLUMN_TOP_MARGIN)
      const pageHeight = (this.pageBottom + COLUMN_TOP_MARGIN * 2) * scale

      const headerTop = project(this.rowTop(HEADER_ROW))

      const key = `page|${rule}|${firstRule}|${pageLeft}|${pageWidth}|${this.pageLines}`
      if (key === this.lastGridKey) return
      this.lastGridKey = key

      /*
       * A dozen custom properties, and CSS draws the paper.
       *
       * Not `background-size` and `background-position` the way the graph paper is
       * done. A page is several layers - stock, pulp, shade, ruling, header - and they
       * move together, so writing the shorthands from here would mean this method
       * knowing how many layers the stylesheet happens to have and in what order.
       * Handing over numbers instead leaves the paper entirely to the stylesheet,
       * which is where it belongs.
       *
       * They are read by more than the stylesheet now: the board view puts the date
       * field and the button that lengthens the page at these coordinates, so the
       * chrome that belongs to the paper lands on the paper without React being told
       * about the camera on every frame.
       */
      const style = this.element.style
      style.setProperty('--lea-page-left', `${pageLeft}px`)
      style.setProperty('--lea-page-width', `${pageWidth}px`)
      style.setProperty('--lea-page-top', `${pageTop}px`)
      style.setProperty('--lea-page-height', `${pageHeight}px`)
      style.setProperty('--lea-rule-inset', `${RULE_INSET * scale}px`)
      style.setProperty('--lea-rule-size', `${rule}px`)
      // The ruling element starts on the first rule, so the pattern needs no phase of
      // its own: the 0.4px is where the gradient puts the line inside its own tile.
      style.setProperty('--lea-rule-top', `${firstRule - 0.4}px`)
      style.setProperty('--lea-rule-height', `${ruleSpan + 1.8}px`)
      style.setProperty('--lea-header-top', `${headerTop}px`)
      style.setProperty(
        '--lea-header-height',
        `${(this.rulePhase + this.ruleSpacing) * scale}px`,
      )
      // The header spans the measure, and the date takes a fixed slice of its right.
      style.setProperty('--lea-column-left', `${columnLeft}px`)
      style.setProperty('--lea-column-width', `${column.width * scale}px`)
      style.setProperty('--lea-subject-width', `${SUBJECT_WIDTH * scale}px`)
      style.setProperty('--lea-date-width', `${DATE_WIDTH * scale}px`)
      // The header is written in the page's own type, so it scales with the page
      // rather than staying a fixed number of CSS pixels as you zoom.
      style.setProperty('--lea-type-size', `${column.fontSize * scale}px`)
      // Below the last rule, where a page run out of lines offers more.
      style.setProperty('--lea-page-end', `${firstRule + ruleSpan}px`)
      return
    }

    let world = RULE_BASE_WORLD
    let rule = world * transform.scale
    while (rule < RULE_MIN_PX) {
      world *= 2
      rule = world * transform.scale
    }
    while (rule > RULE_MAX_PX) {
      world /= 2
      rule = world * transform.scale
    }

    const ruleY = ((transform.ty % rule) + rule) % rule

    const key = `ruled|${rule}|${ruleY}`
    if (key === this.lastGridKey) return
    this.lastGridKey = key

    // One layer, because the ruling is the only part of this paper that moves with
    // the camera. The pulp is on the host's `::before` and never moves.
    const style = this.element.style
    style.backgroundSize = `100% ${rule}px`
    style.backgroundPosition = `0px ${ruleY}px`
  }

  /**
   * Fence the canvas into a writing column of this world width, or null to free it.
   *
   * The zoom is held to a narrow band rather than pinned, and the page has a bottom:
   * `pageLines` rules and then paper stops.
   */
  setColumn(column: WritingColumn | null): void {
    this.column = column
    this.columnBaseline =
      column === null ? 0 : measureBaselineOffset(this.columnProps(column), column.width)
    this.applyFence()
  }

  /**
   * How many rules the page has. Nothing happens below the last one.
   *
   * Document state rather than a setting of the surface, so it arrives the same way
   * the objects do and a peer adding ten lines lengthens the page here too.
   */
  setPageLines(lines: number): void {
    const next = Math.max(1, Math.round(lines))
    if (next === this.pageLines) return
    this.pageLines = next
    this.applyFence()
  }

  /**
   * Turn to another page of the diary.
   *
   * The camera is fenced to one page's strip of the world, so turning a page is a
   * re-fence and a jump to the top of the new one - not a scroll across the desk
   * between them. Landing at the top is the point: you turn to a page to read it from
   * its first line, and keeping the old scroll offset would open page four halfway
   * down because page three happened to be scrolled there.
   */
  setPageSlot(slot: number): void {
    const next = Math.max(0, Math.round(slot))
    if (next === this.pageSlot) return
    // A caret left open on the page being turned away from would keep taking
    // keystrokes into writing nobody can see any more.
    this.stopEditing()
    this.pageSlot = next
    // Scrolling still owed from the wheel belongs to the page it was asked of. Left
    // pending, it lands on the new one and drags it away from its first line.
    this.wheelPending.x = 0
    this.wheelPending.y = 0
    // Nothing on the old page is on the new one, and a selection nobody can see is a
    // delete button that looks armed.
    this.setSelection([])
    this.applyFence()
    this.camera.scrollTo(-COLUMN_TOP_MARGIN - PAGE_TOP_AIR)
    this.requestRender()
  }

  /** World x of the current page's left edge. Zero on an unfenced canvas. */
  private get pageOrigin(): number {
    return this.column === null ? 0 : pageSpan(this.column, this.pageSlot).left
  }

  /** World y of the last rule: where the paper ends. */
  private get pageBottom(): number {
    return this.pageLines * this.ruleSpacing
  }

  private applyFence(): void {
    const column = this.column
    const origin = this.pageOrigin
    this.camera.setFence(
      column === null
        ? null
        : {
            left: origin,
            right: origin + column.width,
            top: -COLUMN_TOP_MARGIN - PAGE_TOP_AIR,
            // Past the last rule by the same air the page opens with, so the end of
            // the paper is something you can see rather than something you hit.
            bottom: this.pageBottom + COLUMN_TOP_MARGIN,
            minZoom: PAGE_MIN_ZOOM,
            maxZoom: PAGE_MAX_ZOOM,
          },
    )
    // The ruling is a function of the type and of where the page ends, so both have to
    // be recomputed rather than left at whatever the last surface asked for.
    this.lastGridKey = ''
    this.syncGrid(this.lastTransform)
    if (this.ready) {
      this.textLayer.columnType = this.surfaceType
      this.textLayer.invalidateAll()
    }
    this.requestRender()
  }

  get writingColumn(): WritingColumn | null {
    return this.column
  }

  /**
   * The type this surface sets over its objects' own, or null on a free canvas.
   *
   * Padding is part of it, and zero: a row's box is its band, and the writing has to
   * start at the top of that band on a row written before this was true as much as on
   * one written after.
   */
  private get surfaceType(): SurfaceType | null {
    const column = this.column
    if (column === null) return null
    return { fontSize: column.fontSize, lineHeight: column.lineHeight, padding: 0 }
  }

  /**
   * The text style a row of this column is written in.
   *
   * The same properties `beginWritingRow` writes onto a new row, resolved through the
   * schema so the face and the alignment are the ones a row will actually be rendered
   * with. Measuring against anything else would phase the rules to type nobody sets.
   */
  private columnProps(column: WritingColumn): TextProps {
    return textProps.parse({
      fontSize: column.fontSize,
      lineHeight: column.lineHeight,
      padding: 0,
      paragraphSpacing: 0,
    })
  }

  /** One line of the column's type, in world units. The ruling's pitch. */
  private get ruleSpacing(): number {
    const column = this.column
    return column === null ? 0 : column.fontSize * column.lineHeight
  }

  /**
   * Where the first rule sits, relative to a row object's own top edge.
   *
   * One rule *above* the first baseline, so the writing rests on a rule rather than
   * being struck through by it: rules repeat every `ruleSpacing`, so subtracting one
   * spacing from the baseline offset is the same set of lines, phased to sit under the
   * type instead of through it. `WRITING_DROP` then lets the words ride into the rule
   * by a hair, which is what handwriting does.
   *
   * The baseline offset is measured, never fitted. It was a constant here once - a
   * fraction of the font size, calibrated by driving a real page - and the trouble with
   * that is that it is only a constant for the size it was fitted at. Raising the type
   * one step walked the writing six pixels off the rules, which is a lot on a 30px
   * line, and there is no reason to keep paying that every time the type changes.
   */
  private get rulePhase(): number {
    if (this.column === null) return 0
    return this.columnBaseline - this.ruleSpacing - WRITING_DROP
  }

  /**
   * The row a world y falls in, counting from the first line of the page.
   *
   * Row n's line box runs from `padding + n * spacing`, so this is the inverse of
   * `rowTop` below, and exactly its inverse. It was not: it subtracted the row's
   * padding while `rowTop` did not, so the two disagreed about where a row began and a
   * click near a band's edge resolved to its neighbour.
   *
   * Clamped at zero: the fence stops the camera going above the first line, but a
   * click can still land in the margin above it, and that means row zero rather than a
   * row that does not exist.
   */
  private rowAt(worldY: number): number {
    if (this.column === null) return 0
    return this.clampRow(Math.floor(worldY / this.ruleSpacing))
  }

  /**
   * The nearest band that is actually a row of this page.
   *
   * A page's bands are its rules and nothing else. The header above them and the paper
   * past the last one are margin, and a click there would otherwise make a row off the
   * page that nobody can see, so both ends resolve to the nearest real line.
   */
  private clampRow(row: number): number {
    return Math.min(Math.max(row, 0), this.pageLines - 1)
  }

  /** The world y a row object is placed at, so its first line lands on row n. */
  private rowTop(row: number): number {
    return row * this.ruleSpacing
  }

  /**
   * Limit the rail and the shortcuts to these tools. Pass null for every tool.
   *
   * `select` is always allowed whatever is passed: it is how you get out of any other
   * tool, and a board nobody can select on is a board nobody can edit.
   */
  setAvailableTools(ids: readonly ToolId[] | null): void {
    this.available = ids === null ? null : new Set<ToolId>([...ids, 'select'])
    // The kind arrives one request after the canvas mounts, so dots can already be on
    // screen by the time this says they should not be.
    if (!this.offersConnectors) this.connectorHost = null
    if (this.available !== null && !this.available.has(this.toolId)) this.setTool('select')
  }

  /** Whether this surface offers arrows at all, and so whether connectors mean anything. */
  private get offersConnectors(): boolean {
    return this.available === null || this.available.has('arrow') || this.available.has('line')
  }

  setTool(id: ToolId): void {
    if (this.available !== null && !this.available.has(id)) return

    // Connector dots belong to the select tool's hover state. Leaving them painted
    // after a switch to the arrow or shape tool offers a target that nothing handles.
    this.connectorHost = null

    if (this.tool !== undefined) {
      if (this.toolId === id) return
      this.tool.cancel?.()
    }
    this.toolId = id
    this.tool = this.buildTool(id)
    this.setCursor(this.tool.cursor)
    this.events.onToolChange?.(id)
    this.requestRender()
  }

  getSelection(): string[] {
    return Array.from(this.selected)
  }

  setSelection(ids: Iterable<string>): void {
    this.selected.clear()
    for (const id of ids) this.selected.add(id)
    this.events.onSelectionChange?.(Array.from(this.selected))
    this.requestRender()
  }

  selectAll(): void {
    this.setSelection(this.host.order().filter((id) => !this.cache.get(id)?.locked))
  }

  /**
   * Formatting for the object being edited, or for the selection when nothing is.
   *
   * Two different mechanisms behind one idea, and the split is the document's rather
   * than an implementation detail. Bold and italic are *marks on a range of text*, so
   * they belong to the fragment and go through the editor. Size is a property of the
   * whole object, so it is an ordinary patch and works on a selection with no editor
   * open at all - which is what lets you resize the type on three stickies at once.
   */
  toggleTextMark(mark: TextMark): void {
    this.host.toggleTextMark(mark)
    this.requestRender()
  }

  /** Ids the formatting bar applies to: the object being edited, or the selection. */
  private formatTargets(): string[] {
    if (this.editing !== null) return [this.editing.id]
    return Array.from(this.selected).filter((id) => {
      const object = this.cache.get(id)
      return object !== undefined && isTextBearing(object.type) && !object.locked
    })
  }

  setTextSize(size: number): void {
    const targets = this.formatTargets()
    if (targets.length === 0) return

    const clamped = Math.max(6, Math.min(288, Math.round(size)))
    this.host.applyPatches(
      targets.map((id) => ({ id, patch: { props: { fontSize: clamped } } })),
    )
    this.host.commit()
    this.requestRender()
  }

  /** The size the bar should show: the shared one, or null when they disagree. */
  get textSize(): number | null {
    let size: number | null = null
    for (const id of this.formatTargets()) {
      const object = this.cache.get(id)
      if (object === undefined) continue
      const own = resolveTextProps(object).fontSize
      if (size === null) size = own
      else if (size !== own) return null
    }
    return size
  }

  /** True when a formatting bar would have something to act on. */
  get canFormatText(): boolean {
    return this.host.canWrite && this.formatTargets().length > 0
  }

  /** The routing the arrow and line tools will draw with. */
  get arrowRoutingChoice(): ArrowRouting {
    return this.arrowRouting
  }

  setDefaultArrowRouting(routing: ArrowRouting): void {
    this.arrowRouting = routing
  }

  /** The side count the polygon tool will draw with. */
  get polygonSidesChoice(): number {
    return this.polygonSides
  }

  /**
   * Choose how many sides a polygon has.
   *
   * Both the setting for the next one and an edit of the selected ones, which is the
   * one place this parts company with the arrow's routing. A routing chosen in the rail
   * is a mode; a side count is the polygon, and a hexagon that can never be made into
   * an octagon without being deleted and drawn again is a shape with a typo in it.
   */
  setPolygonSides(sides: number): void {
    const clamped = Math.max(MIN_POLYGON_SIDES, Math.min(MAX_POLYGON_SIDES, Math.round(sides)))
    this.polygonSides = clamped

    const patches = [...this.selected]
      .map((id) => this.cache.get(id))
      .filter((object): object is ObjectData => object !== undefined && object.type === 'polygon')
      .map((object) => ({
        id: object.id,
        patch: { props: { ...object.props, polygonSides: clamped } },
      }))

    if (patches.length > 0) {
      this.host.applyPatches(patches)
      this.host.commit()
    }
    this.requestRender()
  }

  /** How the pen is set, for the rail to show. */
  get penSettings(): PenSettings {
    return this.pen
  }

  /**
   * Change the nib.
   *
   * Partial, because the rail changes one thing at a time and the rest of the nib has
   * to survive it: picking a colour must not reset the width somebody just chose.
   * Never touches ink that already exists. A stroke records the nib that drew it, and
   * restyling old marks when you pick up a different pen is not a thing pens do.
   */
  setPen(patch: Partial<PenSettings>): void {
    this.pen = { ...this.pen, ...patch }
    this.requestRender()
  }

  /**
   * Re-route an existing arrow.
   *
   * Straight is written as a routing with a zero curvature rather than as a routing
   * alone, so switching to straight and back to curved does not resurrect whatever
   * bow the arrow was last dragged into.
   */
  setArrowRouting(id: string, routing: ArrowRouting): void {
    const object = this.cache.get(id)
    if (object === undefined || !isArrowLike(object.type)) return

    if (routing === 'curved') {
      const props = resolveArrowProps(object)
      // An arrow that has never been bent has whatever the schema's default is, which
      // is a real bow. One that was dragged flat has none, and switching it back to
      // curved with both bows at zero would draw a straight line under a button that
      // says curved.
      const flat = Math.abs(props.curvature) < 0.02 && Math.abs(props.curvatureEnd) < 0.02
      this.host.setArrowRouting(id, {
        routing,
        curvature: flat ? 0.3 : props.curvature,
        curvatureEnd: flat ? 0.3 : props.curvatureEnd,
      })
    } else {
      this.host.setArrowRouting(id, { routing, curvature: 0, curvatureEnd: 0 })
    }

    this.host.commit()
    this.requestRender()
  }

  deleteSelection(): void {
    if (this.selected.size === 0) return

    // The page itself is never deletable. It is the paper, not something on it, and
    // there is no state a writing surface with no page is in that anybody wants: the
    // board view would simply create another one on the next load.
    const doomed = Array.from(this.selected).filter((id) => !this.isPageRow(id))
    if (doomed.length === 0) return

    this.host.deleteObjects(doomed)
    this.setSelection([])
    this.host.commit()
  }

  zoomToFit(): void {
    const all = Array.from(this.cache.values())
    const bounds = unionBounds(all)
    if (bounds === null) {
      this.camera.reset()
    } else {
      this.camera.fit(bounds, this.viewportWidth, this.viewportHeight)
    }
    this.requestRender()
  }

  resetZoom(): void {
    this.camera.setZoom(1, this.viewportWidth, this.viewportHeight)
    this.requestRender()
  }

  /**
   * Rebuild the cache and index from scratch.
   *
   * Used on mount and after a bulk change such as the initial sync, where walking
   * every event would cost more than a straight rebuild.
   */
  resync(): void {
    this.inkDirty = true
    this.cache.clear()
    if (this.textLayer !== undefined) this.textLayer.invalidateAll()
    const entries: { id: string; bounds: WorldRect }[] = []
    for (const object of this.host.allObjects()) {
      this.cache.set(object.id, object)
      entries.push({ id: object.id, bounds: objectBounds(object) })
    }
    this.index.reset(entries)
    this.pruneSelection()
    this.reportCount()
    this.requestRender()
  }

  /** Apply a targeted change. Cheaper than resync during a drag. */
  applyChanges(changed: Iterable<string>, removed: Iterable<string>): void {
    for (const id of removed) {
      if (this.cache.get(id)?.type === 'freedraw') this.inkDirty = true
      this.cache.delete(id)
      this.index.remove(id)
      this.selected.delete(id)
      if (this.editing?.id === id) this.stopEditing()
    }
    // A change to an object's `text` arrives here with the same id as a change to its
    // geometry, because observeDeep reports both under the object. The overlay is told
    // either way; re-serialising a fragment that did not change is cheap next to
    // tracking which of the two it was.
    if (this.textLayer !== undefined) this.textLayer.invalidate(changed)
    for (const id of changed) {
      const object = this.host.object(id)
      // Either side of the change can be ink: a stroke that was just drawn, one that
      // has just gone, and one whose type changed out from under a peer's edit. All
      // three have to rebuild, so this is asked before the object is dropped.
      if (this.cache.get(id)?.type === 'freedraw') this.inkDirty = true
      if (object !== undefined && isFreedraw(object.type)) this.inkDirty = true

      if (object === undefined) {
        this.cache.delete(id)
        this.index.remove(id)
        this.selected.delete(id)
        continue
      }
      this.cache.set(id, object)
      this.index.insert(id, objectBounds(object))
    }
    this.reportCount()
    this.requestRender()
  }

  private reportCount(): void {
    if (this.cache.size === this.lastReportedCount) return
    this.lastReportedCount = this.cache.size
    this.events.onObjectCountChange?.(this.cache.size)
  }

  requestRender(): void {
    this.dirty = true
  }

  // --- text editing -----------------------------------------------------------

  get editingId(): string | null {
    return this.editing?.id ?? null
  }

  /**
   * The transform the last frame was drawn with.
   *
   * Exposed so a test can assert the WebGL scene and the DOM overlay were handed the
   * same numbers, which is the invariant the whole two-layer design rests on.
   */
  get renderTransform(): ViewTransform {
    return this.lastTransform
  }

  /** The overlay element for an object, or null when it is not mounted. */
  overlayElement(id: string): HTMLElement | null {
    return this.textLayer?.root.querySelector(`[data-object-id="${CSS.escape(id)}"]`) ?? null
  }

  /**
   * Enter text editing on an object. ARCHITECTURE 5, step 2 of the lifecycle.
   *
   * A render has to happen first. The editor mounts into the object's overlay element,
   * and that element only exists once the object has been through a sync, so a text
   * object created a microsecond ago has nowhere to put an editor yet.
   */
  beginTextEdit(id: string): boolean {
    // The overlay does not exist until `init` has run. Callers retry rather than
    // assume, because the board view asks for a caret as soon as the document lands
    // and that can be before the renderer is up.
    if (!this.ready) return false

    const object = this.cache.get(id)
    if (object === undefined || !isTextBearing(object.type) || object.locked) return false
    if (this.editing?.id === id) return true

    this.stopEditing()
    this.setSelection([id])
    // Editing and a creation tool are mutually exclusive modes. Dropping back to
    // select means Escape leaves the user somewhere sensible.
    this.setTool('select')

    // Before the render, because the mount below only exists for an object the render
    // decided was on screen.
    this.revealRow(id)

    this.render()
    const element = this.textLayer.beginEdit(id)
    if (element === null) return false

    const teardown = this.host.beginEdit(id, element, () => this.stopEditing(), {
      ink: this.canvasInk,
      type: this.surfaceType,
      onLeave: (direction) => this.leaveRow(id, direction),
    })
    if (teardown === null) {
      this.textLayer.endEdit()
      return false
    }

    this.editing = { id, teardown }
    this.events.onEditingChange?.(id)
    this.requestRender()
    return true
  }

  /**
   * Scroll the page so the row being written on is on screen.
   *
   * Only on a writing surface. A canvas has no reading order and no reason to move
   * itself under a click, but a page does: writing runs down it, and the line you are
   * on has to be a line you can see.
   *
   * This used to happen by accident and was none of the better for it. ProseMirror
   * scrolls a focused caret into view through the nearest scrollable ancestor, and
   * `.canvas-host` was one, so the browser scrolled the host - canvas, overlay and
   * all - while the camera's own y stayed put. It looked like the page following the
   * caret until you clicked, at which point the click resolved against a camera that
   * was several lines out. Both ancestors are `overflow: clip` now, so nothing but
   * this moves the view.
   */
  private revealRow(id: string): void {
    if (this.column === null) return
    const object = this.cache.get(id)
    if (object === undefined) return
    // A rule of leading either side, so the caret is never hard against an edge.
    this.camera.reveal(object.y, object.y + object.h, this.ruleSpacing)
  }

  /**
   * The object a writing surface's page *is*, or null.
   *
   * The first text object in z-order, which is the same rule `ensureWritingColumn` in
   * doc/mutations.ts uses to find it: a fenced board creates its column into an empty
   * document, so it is always at the bottom of the stack. Both sides state the
   * invariant rather than passing an id around, and neither can drift from the other
   * without the rule itself changing.
   *
   * Null on an unfenced board. A glade has no page; it has objects.
   */
  /** Is this object one of the page's own rows? */
  private isPageRow(id: string): boolean {
    if (this.column === null) return false
    return this.cache.get(id)?.type === 'text'
  }

  /**
   * Move the caret off a row and onto its neighbour. False when there is no neighbour.
   *
   * Rows are geometry, not a list, so the neighbour is worked out from the band rather
   * than from any ordering in the document: a row is `bands` rules tall, so the one
   * below starts that many rules down. Nothing has to be kept in sync, and a row
   * written by a peer between two of yours is stepped through like any other.
   *
   * Up from the first rule does nothing. The page has a top and this is it.
   */
  private leaveRow(id: string, direction: 'up' | 'down'): boolean {
    const object = this.cache.get(id)
    if (this.column === null || object === undefined) return false

    const first = Math.round(object.y / this.ruleSpacing)
    // The first rule is the top of the page: the header above it is not written on.
    if (direction === 'up') return first <= 0 ? false : this.beginWritingRow(first - 1)

    const bands = Math.max(1, Math.round(object.h / this.ruleSpacing))
    const next = first + bands
    // The last rule is the end of the page. Somebody who wants more asks for more.
    return next > this.pageLines - 1 ? false : this.beginWritingRow(next)
  }

  /**
   * Put the caret on a row of the page, making the row if it is not there yet.
   *
   * Every rule is its own writing slot, the way a spreadsheet's rows are: the tenth and
   * the hundredth are equally available, and the ones between stay empty rather than
   * having to be typed past. That is what makes a lea feel like paper instead of like a
   * text box - on paper you write where you point, not at the end of what you wrote
   * last.
   *
   * A row is an ordinary `text` object at `(0, row * spacing)` carrying the column's
   * own type. Nothing about the schema knows what a row is; the position and the
   * metrics are the whole of it, which is why a client that has never heard of leas
   * still renders one correctly.
   *
   * The row is created empty and `discardIfEmpty` removes it again if the caret leaves
   * without anything being typed, so clicking around a page does not litter it with
   * blank objects.
   */
  beginWritingRow(row: number): boolean {
    const column = this.column
    if (column === null || !this.ready || !this.host.canWrite) return false

    const top = this.rowTop(row)
    // An existing row wins, including a taller one whose writing has wrapped down into
    // this rule. Clicking on wrapped writing continues it rather than starting a
    // second object on top of it.
    const existing = this.rowObjectAt(top)
    if (existing !== null) return this.beginTextEdit(existing)

    const id = this.host.createObject({
      type: 'text',
      // The page's own strip of the world, not world zero: which page a row is on is
      // where it is, and nothing else records it.
      x: this.pageOrigin,
      y: top,
      w: column.width,
      // One band tall, so rows tile the page exactly rather than overlapping.
      h: this.ruleSpacing,
      props: {
        fontSize: column.fontSize,
        lineHeight: column.lineHeight,
        padding: 0,
        // No gap between paragraphs: on ruled paper a new paragraph is the next rule,
        // not the next rule plus a bit.
        paragraphSpacing: 0,
      },
    })
    if (id === null) return false

    this.host.commit()
    return this.beginTextEdit(id)
  }

  /**
   * The row object covering this world y on the page being written, or null.
   *
   * The page matters as much as the height. Every page of a diary is ruled at the same
   * heights, so a search by y alone would find page one's third line while the caret
   * was being put on page four's.
   */
  private rowObjectAt(worldY: number): string | null {
    const spacing = this.ruleSpacing
    const origin = this.pageOrigin
    // The middle of the row's line box, so a row whose top edge is a fraction out
    // still answers, and a neighbouring row does not.
    const probe = worldY + spacing / 2
    for (const id of this.host.order()) {
      const object = this.cache.get(id)
      if (object === undefined || object.type !== 'text') continue
      if (!this.onThisPage(object, origin)) continue
      if (probe >= object.y && probe < object.y + object.h) return id
    }
    return null
  }

  /** Whether an object's writing belongs to the page whose left edge is `origin`. */
  private onThisPage(object: ObjectData, origin: number): boolean {
    if (this.column === null) return true
    const centre = object.x + object.w / 2
    return centre >= origin && centre < origin + this.column.width
  }

  stopEditing(): void {
    const active = this.editing
    // The teardown blurs the editor, and blur is what called this. Without the guard
    // that recurses straight back in through the exit callback.
    if (active === null || this.closingEditor) return

    this.closingEditor = true
    try {
      active.teardown()
    } finally {
      this.editing = null
      this.closingEditor = false
    }

    this.textLayer.endEdit()
    this.discardIfEmpty(active.id)
    this.host.commit()

    /*
     * Leaving the page leaves nothing selected.
     *
     * `beginTextEdit` selects what it is about to edit, which is right for an object
     * on a canvas and wrong for the paper: the page draws no chrome, so a selection
     * nobody can see would sit there afterwards making the toolbar's delete button
     * look live. Honest state, not just a guard - `deleteSelection` refuses the page
     * anyway, and this is what stops the button offering in the first place.
     */
    if (this.isPageRow(active.id)) this.setSelection([])

    this.events.onEditingChange?.(null)
    this.requestRender()
    if (this.app !== undefined) this.app.canvas.focus()
  }

  /**
   * Throw away a text object that was never typed into.
   *
   * The text tool creates the object and opens an editor in one gesture, so clicking
   * the canvas, changing your mind, and clicking away leaves a zero-content object
   * behind. It is invisible - a plain text object paints no box - but it is still in
   * the document, still in the spatial index, still selectable, and still syncs to
   * everybody else. A board collects dozens of them.
   *
   * Only standalone `text`. A sticky with nothing on it is a deliberate blank card, a
   * label is part of the shape or arrow that owns it, and deleting any of those would
   * be destroying something the user made on purpose rather than tidying up after a
   * gesture they abandoned.
   */
  private discardIfEmpty(id: string): void {
    const object = this.cache.get(id)
    if (object === undefined || object.type !== 'text') return
    if (this.host.textPlain(id).trim() !== '') return

    this.host.deleteObjects([id])
    if (this.selected.delete(id)) this.events.onSelectionChange?.(Array.from(this.selected))
  }

  // --- internals --------------------------------------------------------------

  private get viewportWidth(): number {
    return this.app?.screen.width ?? this.element.clientWidth
  }

  private get viewportHeight(): number {
    return this.app?.screen.height ?? this.element.clientHeight
  }

  private pruneSelection(): void {
    let changed = false
    for (const id of Array.from(this.selected)) {
      if (!this.cache.has(id)) {
        this.selected.delete(id)
        changed = true
      }
    }
    if (changed) this.events.onSelectionChange?.(Array.from(this.selected))
  }

  private buildTool(id: ToolId): Tool {
    switch (id) {
      case 'hand':
        return createHandTool(this.context)
      case 'rect':
      case 'ellipse':
      case 'diamond':
      case 'parallelogram':
      case 'triangle':
      case 'trapezoid':
      case 'polygon':
      case 'cylinder':
        return createShapeTool(this.context, id)
      case 'text':
      case 'sticky':
        return createTextTool(this.context, id)
      case 'arrow':
      case 'line':
        return createArrowTool(this.context, id)
      case 'pen':
        return createPenTool(this.context)
      default:
        return createSelectTool(this.context)
    }
  }

  private createToolContext(): ToolContext {
    const host = this.host
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the getters below
    // are plain object literals, so `this` inside them is the context, not the engine.
    const engine = this
    return {
      camera: this.camera,
      // A getter, not a snapshot: the role is resolved on the ws handshake and can
      // change on a reconnect, so a value captured at construction would go stale.
      get canWrite(): boolean {
        return host.canWrite
      },
      order: () => this.host.order(),
      object: (id) => this.cache.get(id),
      query: (rect) => this.index.search(rect),
      visibleObjects: () => this.visibleObjects(),
      selection: () => this.selected,
      setSelection: (ids) => this.setSelection(ids),
      setMarquee: (rect) => {
        this.marquee = rect
      },
      setGuides: (guides) => {
        this.guides = guides
      },
      setWetInk: (ink) => {
        this.wetInk = ink
      },
      setHoverTarget: (id) => {
        this.hoverTarget = id
      },
      setConnectorHost: (id) => {
        // A connector dot is an offer to drag an arrow out of the object under the
        // pointer. On a surface with no arrow tool there is nothing behind the offer,
        // so it is four blue dots that do nothing but follow the cursor around.
        const next = this.offersConnectors ? id : null
        if (this.connectorHost === next) return
        this.connectorHost = next
        this.requestRender()
      },
      createObject: (input) => this.host.createObject(input),
      applyPatches: (patches) => this.host.applyPatches(patches),
      setArrowPoints: (id, absolute) => this.host.setArrowPoints(id, absolute),
      bindArrow: (input) => this.host.bindArrow(input),
      setArrowRouting: (id, patch) => this.host.setArrowRouting(id, patch),
      get polygonSides(): number {
        return engine.polygonSides
      },
      get arrowRouting(): ArrowRouting {
        return engine.arrowRouting
      },
      get pen(): PenSettings {
        return engine.pen
      },
      commit: () => this.host.commit(),
      beginTextEdit: (id) => this.beginTextEdit(id),
      setTool: (tool) => this.setTool(tool),
      get authorName(): string {
        return host.authorName
      },
      requestRender: () => this.requestRender(),
      setCursor: (cursor) => this.setCursor(cursor),
    }
  }

  private visibleObjects(): ObjectData[] {
    const rect = this.camera.visibleWorld(this.viewportWidth, this.viewportHeight)
    const out: ObjectData[] = []
    for (const id of this.index.search(rect)) {
      const object = this.cache.get(id)
      if (object !== undefined) out.push(object)
    }
    return out
  }

  private setCursor(cursor: string): void {
    // `ready`, not `app !== undefined`. The Application object exists one await before
    // its renderer does, and Pixi's `canvas` getter reads through the renderer, so
    // anything that sets a tool from a React effect during that window threw here.
    if (this.ready) this.app.canvas.style.cursor = cursor
  }

  /**
   * One frame of eased wheel scrolling.
   *
   * The remainder is applied whole once it is under a pixel: easing toward a target
   * approaches it without arriving, and a camera left a third of a pixel out keeps the
   * loop dirty forever for a move nobody can see.
   */
  private stepWheel(): void {
    const pending = this.wheelPending
    if (pending.x === 0 && pending.y === 0) return

    const now = performance.now()
    // A first step, or a tab that was in the background, has no useful elapsed time.
    const elapsed = this.wheelAt === 0 ? 16 : Math.min(64, now - this.wheelAt)
    this.wheelAt = now

    const fraction = 1 - Math.exp(-elapsed / WHEEL_TAU_MS)
    let dx = pending.x * fraction
    let dy = pending.y * fraction
    if (Math.abs(pending.x - dx) < 0.5) dx = pending.x
    if (Math.abs(pending.y - dy) < 0.5) dy = pending.y

    pending.x -= dx
    pending.y -= dy

    const beforeX = this.camera.x
    const beforeY = this.camera.y
    this.camera.panByScreen(dx, dy)

    // Against the fence with nowhere to go. Keeping the target would leave the page
    // holding a scroll it can never spend, which then fires the moment you turn
    // round - the top of a diary bouncing when you finally scroll back down.
    if (this.camera.x === beforeX && this.camera.y === beforeY) {
      pending.x = 0
      pending.y = 0
    }
  }

  // --- render loop ------------------------------------------------------------

  private loop = (): void => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)

    this.stepWheel()
    this.syncHostSize()

    // A fenced camera re-centres its column when the window changes width, and this is
    // where it finds out that it did. A no-op at the same size, and on an unfenced
    // camera it is two comparisons.
    this.camera.setViewport(this.viewportWidth, this.viewportHeight)

    if (this.camera.version !== this.lastCameraVersion) {
      this.lastCameraVersion = this.camera.version
      this.dirty = true
      this.events.onCameraChange?.({
        x: this.camera.x,
        y: this.camera.y,
        zoom: this.camera.zoom,
      })
    }

    if (!this.dirty) return
    this.dirty = false

    const start = performance.now()
    this.render()
    this.app.render()
    this.lastRenderMs = performance.now() - start

    this.flushHeights()
  }

  /**
   * Push measured auto-heights into the document.
   *
   * Idempotent by construction: every client measures the same text with the same
   * fonts and arrives at the same number, so the first write settles it and the
   * tolerance in the text layer stops the rest. A read-only role never gets here,
   * because the host refuses the patch.
   */
  private flushHeights(): void {
    if (this.pendingHeights.size === 0) return

    const editing = this.editing?.id
    // Where the caret ended up, when the row it is in is the row that grew. Read here
    // rather than from the cache afterwards, because the patch below has not landed
    // yet and the cached height is the one from before the line was typed.
    let grew: { id: string; top: number; bottom: number } | null = null

    const patches: { id: string; patch: Partial<ObjectData> }[] = []
    for (const [id, height] of this.pendingHeights) {
      const object = this.cache.get(id)
      if (object !== undefined && Math.abs(object.h - height) > 1) {
        patches.push({ id, patch: { h: height } })
        if (id === editing) grew = { id, top: object.y, bottom: object.y + height }
      }
    }
    this.pendingHeights.clear()

    if (patches.length > 0 && this.host.canWrite) this.host.applyPatches(patches)

    /*
     * Writing that has wrapped past the bottom of the window pulls the page up.
     *
     * A row grows one rule at a time as it is written, so this is the moment the caret
     * leaves the screen and the moment to follow it. Only on a writing surface, and
     * only for the row being typed in: a peer's note growing on a glade must not drag
     * anybody's view anywhere.
     */
    if (grew !== null && this.column !== null) {
      this.camera.reveal(grew.top, grew.bottom, this.ruleSpacing)
      this.requestRender()

      // And the rows underneath it get out of the way, before the next frame draws
      // one line of writing on top of another.
      const displaced = this.reflowBelow(grew.id, grew.top, grew.bottom)
      if (displaced.length > 0 && this.host.canWrite) this.host.applyPatches(displaced)
    }
  }

  /**
   * Push the rows under a grown one out from under it.
   *
   * A row is one rule tall when it is made and grows as its writing wraps, and nothing
   * used to stop it growing straight over whatever was already written below. It is
   * easy to do by accident and it is not recoverable by eye: two rows land on the same
   * rules, both are painted, and the result is a smear of half-glyphs that reads as a
   * rendering fault rather than as two pieces of writing. The document was fine the
   * whole time, which is the worst kind of wrong.
   *
   * Whole bands, and cascading: a row shoved down can land on the next one, so the run
   * is walked in order and each row is put on the first rule clear of the one above it.
   * Rows that are already clear are left exactly where they are - this must not tidy a
   * page somebody deliberately left gaps in.
   */
  private reflowBelow(
    grownId: string,
    top: number,
    bottom: number,
  ): { id: string; patch: Partial<ObjectData> }[] {
    if (this.column === null) return []

    const spacing = this.ruleSpacing
    const origin = this.pageOrigin
    const below = [...this.cache.values()]
      .filter(
        (object) =>
          object.type === 'text' &&
          object.id !== grownId &&
          // Below the row that grew, by more than the rounding in a measured height.
          object.y > top + 0.05 &&
          this.onThisPage(object, origin),
      )
      .sort((a, b) => a.y - b.y)

    const patches: { id: string; patch: Partial<ObjectData> }[] = []
    let floor = bottom
    for (const row of below) {
      if (row.y >= floor - 0.05) {
        floor = row.y + row.h
        continue
      }
      const y = Math.ceil((floor - 0.05) / spacing) * spacing
      patches.push({ id: row.id, patch: { y } })
      floor = y + row.h
    }
    return patches
  }

  /**
   * Keep the drawing buffer the size of the host element.
   *
   * Pixi resizes itself from `resizeTo`, and `resizeTo` listens to the window. That
   * covers every way the canvas used to change size and misses the one a lea's page
   * list added: a host that gets narrower while the window does not. The
   * `ResizeObserver` is the obvious answer and is not a reliable one on its own -
   * it is delivered on a frame the browser chooses to run, and a page whose only
   * change is a sidebar appearing can go several frames without one.
   *
   * So the loop asks. Read at the top of the frame, before anything here writes to
   * the DOM, so layout is settled from the last paint and two reads cost nothing.
   * A no-op at the same size, which is every frame but the handful that matter.
   */
  private syncHostSize(): void {
    const app = this.app
    if (app === undefined) return

    const width = this.element.clientWidth
    const height = this.element.clientHeight
    // Zero while the host is display:none, and resizing to nothing throws away the
    // camera's sense of the viewport for the frame it comes back.
    if (width === 0 || height === 0) return
    if (width === Math.round(app.screen.width) && height === Math.round(app.screen.height)) {
      return
    }

    app.renderer.resize(width, height)
    this.dirty = true
  }

  private render(): void {
    // Nothing to paint on before `init` has built the layers. Reachable because the
    // board view applies a surface, a tool set and a column from React effects, any of
    // which can land while the renderer is still coming up.
    if (!this.ready) return

    // One transform, snapped to device pixels once, handed to both layers. See
    // camera.ts: this is the whole reason the DOM text sits exactly on its shape.
    const transform = viewTransform(this.camera, window.devicePixelRatio || 1)
    this.lastTransform = transform

    this.world.position.set(transform.tx, transform.ty)
    this.world.scale.set(transform.scale)

    this.ensureCapacity()

    const visible = new Set(
      this.index.search(this.camera.visibleWorld(this.viewportWidth, this.viewportHeight, 64)),
    )

    // Ink first: the count below is "what is on screen", and the ink layer knows how
    // many strokes it holds only once it has been brought up to date.
    this.syncInk()
    this.lastVisible = this.paintScene(visible) + this.ink.drawn
    this.drawWetInk()

    this.syncGrid(transform)
    this.textLayer.sync(transform, this.overlayObjects)
    this.drawOverlay(transform)
    this.catchUpGaps()
    this.drawWanderers(transform)
  }

  /**
   * Render the whole board, fitted, as a small image for the board list.
   *
   * Two things make this more than an `extract` call.
   *
   * Culling has to be off. The live scene only ever holds the objects on screen, and a
   * thumbnail wants the ones that are not.
   *
   * And text lives in the DOM overlay, not in WebGL, so extracting the canvas alone
   * produces a board with every sticky note blank. The glyphs are drawn on afterwards
   * with plain 2D canvas text. Fidelity is not the goal at this size; a thumbnail that
   * shows where the writing is beats one that pretends there is none.
   */
  async captureThumbnail(maxDimension = 512): Promise<Blob | null> {
    if (!this.ready || this.cache.size === 0) return null

    const bounds = unionBounds(Array.from(this.cache.values()))
    if (bounds === null) return null

    const worldWidth = Math.max(bounds.maxX - bounds.minX, 1)
    const worldHeight = Math.max(bounds.maxY - bounds.minY, 1)
    // Never upscale. A board with three small shapes should produce a small image, not
    // a blurry large one.
    const scale = Math.min(maxDimension / worldWidth, maxDimension / worldHeight, 1)
    const width = Math.max(1, Math.round(worldWidth * scale))
    const height = Math.max(1, Math.round(worldHeight * scale))

    const transform: ViewTransform = { tx: -bounds.minX * scale, ty: -bounds.minY * scale, scale }

    // Chrome and presence are this client's own state, not the board's.
    const overlayVisible = this.overlay.visible
    const wanderersVisible = this.wanderers.view.visible
    const wetVisible = this.wet.visible
    this.overlay.visible = false
    this.wanderers.view.visible = false
    // A stroke still under this client's pointer is not on the board yet, and a
    // thumbnail is served to everyone.
    this.wet.visible = false
    // The ink layer is invalidated rather than repainted per frame, so a capture that
    // runs before the next frame would otherwise catch it a rebuild behind.
    this.syncInk()

    let source: HTMLCanvasElement
    try {
      this.world.position.set(transform.tx, transform.ty)
      this.world.scale.set(transform.scale)
      this.ensureCapacity()
      this.paintScene(null)

      source = this.app.renderer.extract.canvas({
        target: this.app.stage,
        frame: new Rectangle(0, 0, width, height),
        resolution: 1,
      }) as HTMLCanvasElement
    } finally {
      this.overlay.visible = overlayVisible
      this.wanderers.view.visible = wanderersVisible
      this.wet.visible = wetVisible
      // The scene is now painted for the thumbnail rather than for the viewport, so
      // the next frame has to rebuild it.
      this.requestRender()
    }

    const surface = document.createElement('canvas')
    surface.width = width
    surface.height = height
    const context = surface.getContext('2d')
    if (context === null) return null

    // No paper under it. A thumbnail is captured once and served to everyone, so a
    // baked-in background is one client's theme imposed on every viewer: it showed up
    // as a white slab on a dark board list. Left transparent, the card's own well
    // shows through and the preview takes the reader's theme, not the author's.
    // webp carries alpha, so this survives the encode.
    context.drawImage(source, 0, 0, width, height)

    this.paintThumbnailText(context, transform)

    return await new Promise((resolve) => {
      // webp over png: a canvas of flat fills compresses far better, and the endpoint
      // accepts both.
      surface.toBlob((blob) => resolve(blob), 'image/webp', 0.8)
    })
  }

  /** Plain text for the thumbnail, since the real text is DOM and not in the capture. */
  private paintThumbnailText(context: CanvasRenderingContext2D, transform: ViewTransform): void {
    for (const { object } of this.overlayObjects) {
      const props = resolveTextProps(object)
      const size = props.fontSize * transform.scale
      // Below about three pixels a glyph is noise. Skipping is more honest than
      // drawing a grey smear where words would be.
      if (size < 3) continue

      const text = this.host.textPlain(object.id)
      if (text === '') continue

      const topLeft = projectPoint(transform, object.x, object.y)
      const boxWidth = object.w * transform.scale
      const boxHeight = object.h * transform.scale
      const padding = props.padding * transform.scale

      context.save()
      context.beginPath()
      context.rect(topLeft.x, topLeft.y, boxWidth, boxHeight)
      context.clip()

      context.fillStyle = `#${(props.color >>> 0).toString(16).padStart(6, '0').slice(-6)}`
      context.font = `${size}px ${FONT_STACKS[props.fontFamily]}`
      context.textAlign = props.align === 'center' ? 'center' : props.align === 'right' ? 'right' : 'left'
      context.textBaseline = 'top'

      const anchorX =
        props.align === 'center'
          ? topLeft.x + boxWidth / 2
          : props.align === 'right'
            ? topLeft.x + boxWidth - padding
            : topLeft.x + padding

      const lineHeight = size * props.lineHeight
      let y = topLeft.y + padding
      for (const line of wrapText(context, text, boxWidth - padding * 2)) {
        if (y > topLeft.y + boxHeight) break
        context.fillText(line, anchorX, y)
        y += lineHeight
      }

      context.restore()
    }
  }

  /**
   * Fill the batch and the arrow pass from the z-order.
   *
   * `visible` is the cull set, or null to paint everything regardless of the camera.
   * The thumbnail pass needs the second: it renders the whole board fitted into a
   * small frame, so the objects it wants are exactly the ones culling would drop.
   */
  private paintScene(visible: ReadonlySet<string> | null): number {
    this.batch.begin()
    this.arrows.begin()
    this.overlayObjects.length = 0
    let drawn = 0
    let depth = 0
    for (const id of this.host.order()) {
      depth += 1
      if (visible !== null && !visible.has(id)) continue
      const object = this.cache.get(id)
      if (object === undefined) continue

      // A text-bearing object is drawn twice on purpose: the batch paints its box, the
      // DOM overlay paints its glyphs on top. A sticky note is a rounded rectangle
      // plus real selectable text, not a picture of one.
      if (isTextBearing(object.type)) this.overlayObjects.push({ object, z: depth })

      if (isArrowLike(object.type)) {
        const style = resolveArrowProps(object)
        const anchors = absolutePoints(object, style)
        this.arrows.push({
          // Flattened here rather than in the pass, because this is the only place
          // that knows the zoom. `arrowPolyline` hands straight and orthogonal routes
          // straight back, so the common arrow allocates nothing extra.
          points: arrowPolyline(
            anchors,
            style.routing,
            style.curvature,
            style.curvatureEnd,
            curveSegments(anchors, this.camera.zoom),
          ),
          // A connector that never chose a colour follows the theme; one that did
          // keeps what the document says, in both themes. Note this is the connector
          // ink, not the board's text ink: an arrow reads a weight quieter than the
          // boxes it joins.
          stroke:
            typeof object.props.stroke === 'number'
              ? style.stroke
              : connectorInk(this.darkSurface),
          strokeAlpha: style.strokeAlpha * object.opacity,
          strokeWidth: style.strokeWidth,
          startHead: style.startHead,
          endHead: style.endHead,
          headSize: style.headSize,
          // The caption's own box, measured by the overlay, so the line breaks around
          // the words rather than running through them. One frame stale by
          // construction - the overlay is synced after this walk - which matters for
          // exactly the first frame after a caption changes width.
          gap: this.rememberGap(object.id),
        })
        drawn += 1
        continue
      }

      const kind = shapeKindFor(object.type)
      if (kind === null) continue

      const style = resolveStyle(object, kind, this.darkSurface)
      this.batch.push({
        x: object.x,
        y: object.y,
        w: object.w,
        h: object.h,
        rotation: object.rotation,
        kind: style.kind,
        fill: style.fill,
        fillAlpha: style.fillAlpha,
        stroke: style.stroke,
        strokeAlpha: style.strokeAlpha,
        strokeWidth: style.strokeWidth,
        radius: style.radius,
      })
      drawn += 1
    }
    this.batch.end()
    this.arrows.end()
    return drawn
  }

  /**
   * Bring the ink layer up to date, if the document has moved under it.
   *
   * The whole of the ink pass's cost is here, and it is paid on an edit rather than on
   * a frame. Panning across a page of handwriting rebuilds nothing.
   */
  private syncInk(): void {
    if (!this.inkDirty) return
    this.inkDirty = false
    this.ink.rebuild(this.inkStrokes())
  }

  /**
   * Every stroke in the document, in z-order.
   *
   * Not culled, unlike the scene walk above. See renderers/inkPass.ts: the layer is
   * retained, and culling would make looking around invalidate it.
   */
  private *inkStrokes(): Iterable<InkDraw> {
    for (const id of this.host.order()) {
      const object = this.cache.get(id)
      if (object === undefined || !isFreedraw(object.type)) continue

      const props = resolveFreedrawProps(object)
      yield {
        id,
        points: props.points,
        x: object.x,
        y: object.y,
        rotation: object.rotation,
        halfW: object.w / 2,
        halfH: object.h / 2,
        props,
        // The board's own ink, not the connector's: a pen stroke is writing on the
        // surface and should read at the weight the surface's text does. A stroke
        // whose document names a colour keeps it in both themes.
        color: typeof object.props.stroke === 'number' ? props.stroke : this.canvasInk,
        alpha: props.strokeAlpha * object.opacity,
      }
    }
  }

  /**
   * The stroke under the pointer.
   *
   * Rebuilt every frame, which is the opposite of how dry ink is drawn and right for
   * the same reason: this one is changing, and there is at most one of it.
   */
  private drawWetInk(): void {
    const ink = this.wetInk

    if (ink === null || ink.points.length < 3) {
      // Guarded, because this runs on every frame of every pan on every board and
      // `clear()` on a Graphics resets its context whether or not it held anything.
      if (!this.wetDrawn) return
      this.wet.clear()
      this.wetDrawn = false
      return
    }

    const pieces = strokeOutline(ink.points, ink)
    this.wet.clear()
    this.wetDrawn = true

    let drawn = false
    for (const piece of pieces) {
      if (piece.length < 6) continue
      this.wet.poly(piece)
      drawn = true
    }
    if (!drawn) return

    this.wet.fill({
      color: ink.color ?? this.canvasInk,
      alpha: TIP_PROFILES[ink.tip].alpha,
    })
  }

  /** The gap for this arrow, recording what was used so `catchUpGaps` can compare. */
  private rememberGap(id: string): ArrowDraw['gap'] {
    const bounds = this.textLayer.labelBounds(id)
    this.labelGaps.set(id, gapKey(bounds ?? undefined))
    return bounds ?? undefined
  }

  /**
   * Ask for one more frame if a caption's box is not what the shaft was cut around.
   *
   * Runs after the overlay has been laid out, which is the first moment the real
   * measurement exists. Converges in one extra frame and then costs two map lookups
   * per captioned arrow, which is nothing next to being wrong.
   */
  private catchUpGaps(): void {
    if (this.labelGaps.size === 0) return
    for (const [id, used] of this.labelGaps) {
      if (gapKey(this.textLayer.labelBounds(id) ?? undefined) !== used) {
        this.labelGaps.clear()
        this.requestRender()
        return
      }
    }
  }

  private ensureCapacity(): void {
    const needed = this.cache.size
    if (needed <= this.batch.capacity) return

    // Grow with headroom, so a board being filled in does not reallocate every add.
    const next = Math.max(MIN_BATCH_CAPACITY, Math.ceil(needed * 1.5))
    this.world.removeChild(this.batch.view)
    this.batch.destroy()
    this.batch = new ShapeBatch(next)
    // At index 0, not appended: appending would put the shapes over the arrows and
    // silently invert the layer order the first time a board outgrew its capacity.
    this.world.addChildAt(this.batch.view, 0)
  }

  /**
   * Selection chrome, drawn in screen space.
   *
   * Handles must stay the same pixel size at every zoom, so this cannot live in the
   * world container. It reads the same camera to project, never a second copy.
   */
  private drawOverlay(transform: ViewTransform): void {
    const graphics = this.overlay
    graphics.clear()

    /*
     * Two kinds of guide, drawn differently on purpose.
     *
     * An alignment guide is a plain line through the two edges that now agree. A
     * spacing guide is a *measurement*: a short bar with a tick at each end, sitting
     * in the gap it is measuring. Drawing both as the same line would be the worst of
     * both, because a bar spanning a gap looks exactly like an edge that lines up with
     * nothing.
     */
    let hasGuideLines = false
    for (const guide of this.guides) {
      const alongX = guide.axis === 'x'

      if (guide.kind === 'spacing') {
        const from = projectPoint(
          transform,
          alongX ? guide.from : guide.position,
          alongX ? guide.position : guide.from,
        )
        const to = projectPoint(
          transform,
          alongX ? guide.to : guide.position,
          alongX ? guide.position : guide.to,
        )
        // A gap under a few pixels has no room for a bar and reads as noise.
        if (Math.hypot(to.x - from.x, to.y - from.y) < 4) continue

        graphics.moveTo(from.x, from.y).lineTo(to.x, to.y)
        // End ticks, across the bar, so it reads as a dimension rather than a stray
        // segment of some other line.
        if (alongX) {
          graphics.moveTo(from.x, from.y - GUIDE_TICK).lineTo(from.x, from.y + GUIDE_TICK)
          graphics.moveTo(to.x, to.y - GUIDE_TICK).lineTo(to.x, to.y + GUIDE_TICK)
        } else {
          graphics.moveTo(from.x - GUIDE_TICK, from.y).lineTo(from.x + GUIDE_TICK, from.y)
          graphics.moveTo(to.x - GUIDE_TICK, to.y).lineTo(to.x + GUIDE_TICK, to.y)
        }
        hasGuideLines = true
        continue
      }

      const from = projectPoint(
        transform,
        alongX ? guide.position : guide.from,
        alongX ? guide.from : guide.position,
      )
      const to = projectPoint(
        transform,
        alongX ? guide.position : guide.to,
        alongX ? guide.to : guide.position,
      )
      graphics.moveTo(from.x, from.y).lineTo(to.x, to.y)
      hasGuideLines = true
    }
    if (hasGuideLines) graphics.stroke({ width: 1, color: GUIDE_COLOR })

    /*
     * Connector dots on the shape being pointed at.
     *
     * Drawn before the selection chrome, because when a shape is both selected and
     * hovered its resize handles are the more important target and should sit on top.
     * The dots are placed just outside the outline for the same reason: on it, they
     * would land exactly where the edge-midpoint resize handles already are.
     */
    if (this.connectorHost !== null) {
      const host = this.cache.get(this.connectorHost)
      if (host !== undefined) {
        const bounds = objectBounds(host)
        const offset = this.camera.toWorldDistance(CONNECTOR_OFFSET_PX)
        const dots = connectorPoints(bounds, offset)

        for (const side of CONNECTOR_SIDES) {
          const point = projectPoint(transform, dots[side].x, dots[side].y)
          graphics.circle(point.x, point.y, CONNECTOR_RADIUS_PX)
        }
        graphics
          .fill({ color: SELECTION_COLOR, alpha: 0.95 })
          .stroke({ width: 1.5, color: 0xffffff, alpha: 0.9 })
      }
    }

    // What an arrow end would attach to. Drawn before the selection chrome so a
    // selected shape's own outline stays on top of it.
    if (this.hoverTarget !== null) {
      const target = this.cache.get(this.hoverTarget)
      if (target !== undefined) {
        const bounds = objectBounds(target)
        const topLeft = projectPoint(transform, bounds.minX, bounds.minY)
        const bottomRight = projectPoint(transform, bounds.maxX, bounds.maxY)
        graphics
          .rect(
            topLeft.x - 2,
            topLeft.y - 2,
            bottomRight.x - topLeft.x + 4,
            bottomRight.y - topLeft.y + 4,
          )
          .stroke({ width: 2, color: BINDING_COLOR, alpha: 0.9 })
      }
    }

    if (this.marquee !== null) {
      const topLeft = projectPoint(transform, this.marquee.minX, this.marquee.minY)
      const bottomRight = projectPoint(transform, this.marquee.maxX, this.marquee.maxY)
      graphics
        .rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
        .fill({ color: MARQUEE_FILL, alpha: 0.08 })
        .stroke({ width: 1, color: SELECTION_COLOR, alpha: 0.7 })
    }

    /*
     * The page is not an object you select.
     *
     * On a writing surface the column is the paper, and a blue box with eight handles
     * round the paper is the app admitting it is a canvas editor wearing a diary. It
     * cannot be moved or resized either - the fence decides where it is and how wide -
     * so chrome offering both would be chrome for two things that do not happen.
     * Anything else on the page still selects and still shows its box.
     */
    const selectedObjects: ObjectData[] = []
    for (const id of this.selected) {
      if (this.isPageRow(id)) continue
      const object = this.cache.get(id)
      if (object !== undefined) selectedObjects.push(object)
    }
    if (selectedObjects.length === 0) return

    // A lone arrow gets its own chrome and none of the box's. See arrowHandles.ts.
    if (selectedObjects.length === 1 && isArrowLike(selectedObjects[0].type)) {
      this.drawArrowChrome(transform, selectedObjects[0])
      return
    }

    // Outline each member of a multi-selection, plus the union box the handles act on.
    if (selectedObjects.length > 1) {
      for (const object of selectedObjects) {
        const bounds = objectBounds(object)
        const topLeft = projectPoint(transform, bounds.minX, bounds.minY)
        const bottomRight = projectPoint(transform, bounds.maxX, bounds.maxY)
        graphics.rect(
          topLeft.x,
          topLeft.y,
          bottomRight.x - topLeft.x,
          bottomRight.y - topLeft.y,
        )
      }
      graphics.stroke({ width: 1, color: SELECTION_COLOR, alpha: 0.4 })
    }

    const box = unionBounds(selectedObjects)
    if (box === null) return

    const topLeft = projectPoint(transform, box.minX, box.minY)
    const bottomRight = projectPoint(transform, box.maxX, box.maxY)
    graphics
      .rect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y)
      .stroke({ width: 1.5, color: SELECTION_COLOR })

    if (!this.host.canWrite) return

    // Eight squares and nothing else. Rotation lives in the empty space just outside
    // each corner and is advertised by the cursor, so it costs no chrome at all.
    const positions = handlePositions(box)
    const half = HANDLE_SIZE_PX / 2

    for (const id of RESIZE_HANDLES) {
      const point = projectPoint(transform, positions[id].x, positions[id].y)
      graphics.rect(point.x - half, point.y - half, HANDLE_SIZE_PX, HANDLE_SIZE_PX)
    }
    graphics.fill({ color: 0xffffff }).stroke({ width: 1.5, color: SELECTION_COLOR })
  }

  /**
   * Selection chrome for a single arrow: two ends and a middle.
   *
   * The path itself is traced in the selection colour underneath the handles, because
   * a two-point line has no interior to highlight and an arrow crossing a busy board
   * is otherwise hard to pick out of the arrows next to it.
   */
  private drawArrowChrome(transform: ViewTransform, arrow: ObjectData): void {
    const graphics = this.overlay
    const props = resolveArrowProps(arrow)
    const path = arrowPolyline(
      props.points,
      props.routing,
      props.curvature,
      props.curvatureEnd,
      curveSegments(props.points, transform.scale),
    )

    const first = projectPoint(transform, path[0] + arrow.x, path[1] + arrow.y)
    graphics.moveTo(first.x, first.y)
    for (let index = 2; index + 1 < path.length; index += 2) {
      const point = projectPoint(transform, path[index] + arrow.x, path[index + 1] + arrow.y)
      graphics.lineTo(point.x, point.y)
    }
    graphics.stroke({
      width: props.strokeWidth * transform.scale + 4,
      color: SELECTION_COLOR,
      alpha: 0.22,
      cap: 'round',
      join: 'round',
    })

    if (!this.host.canWrite) return

    const handles = arrowHandles(arrow)
    for (const point of [handles.start, handles.end]) {
      const screen = projectPoint(transform, point.x, point.y)
      graphics.circle(screen.x, screen.y, ARROW_HANDLE_RADIUS_PX)
    }
    graphics.fill({ color: 0xffffff }).stroke({ width: 2, color: SELECTION_COLOR })

    // The bend handles are drawn hollow and a size down, so they do not read as more
    // endpoints. Dragging one bends the arrow; dragging an end moves it. An elbow has
    // none, because its shape is its routing.
    if (handles.bends.length === 0) return
    for (const bend of handles.bends) {
      const point = projectPoint(transform, bend.at.x, bend.at.y)
      graphics.circle(point.x, point.y, ARROW_HANDLE_RADIUS_PX - 1)
    }
    graphics
      .fill({ color: 0xffffff, alpha: 0.9 })
      .stroke({ width: 1.5, color: SELECTION_COLOR, alpha: 0.75 })
  }

  /**
   * Remote presence for the next frame.
   *
   * Stored and drawn rather than pushed straight to the layer, because awareness
   * arrives on its own schedule and rendering on receipt would break the one-render-
   * per-frame rule for the busiest message on the socket.
   */
  setWanderers(wanderers: readonly Wanderer[]): void {
    this.wandererState = wanderers
    this.requestRender()
  }

  private drawWanderers(transform: ViewTransform): void {
    if (this.wandererState.length === 0) {
      this.wanderers.drawSelections(transform, [])
      this.wanderers.drawCursors(transform, [])
      return
    }

    const selections: WandererSelection[] = []
    for (const wanderer of this.wandererState) {
      for (const id of wanderer.selection) {
        const object = this.cache.get(id)
        // Silently skipped when the object is unknown here: a peer can have something
        // selected that this client has not loaded yet, or has already seen deleted.
        if (object !== undefined) {
          selections.push({ color: wanderer.color, bounds: objectBounds(object) })
        }
      }
    }

    this.wanderers.drawSelections(transform, selections)
    this.wanderers.drawCursors(transform, this.wandererState)
  }

  // --- input ------------------------------------------------------------------

  /**
   * `bounds` is passed in when a whole batch of samples is being converted at once.
   *
   * `getBoundingClientRect` is a layout read, and a fast stroke can arrive as a dozen
   * coalesced samples in one event. Reading the same rectangle a dozen times for one
   * frame is the kind of thing that only shows up as jank on the machines least able
   * to afford it.
   */
  private toCanvasPoint(event: PointerEvent | WheelEvent, bounds?: DOMRect): Point {
    const rect = bounds ?? this.app.canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  private toPointerEvent(event: PointerEvent, bounds?: DOMRect): CanvasPointerEvent {
    const screen = this.toCanvasPoint(event, bounds)
    return {
      screen,
      world: this.camera.screenToWorld(screen.x, screen.y),
      shiftKey: event.shiftKey,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      button: event.button,
      pointerId: event.pointerId,
      pressure: event.pressure,
      pointerType: event.pointerType,
    }
  }

  /*
   * --- touch -------------------------------------------------------------------
   *
   * One finger is a pointer and needs nothing: the tools already run on pointer
   * events, so a tap selects and a drag draws exactly as a mouse does. Two fingers
   * are the gesture a canvas cannot do without, and there is no pointer event for
   * them - the browser reports two independent streams and leaves the arithmetic to
   * the page.
   *
   * Pinch and two-finger pan are one gesture, not two. Nobody pinches without also
   * moving their hand, and a canvas that zooms but refuses to follow the drift feels
   * like it is fighting you. So both are read off the same pair every move: the
   * change in the distance between the fingers is the zoom, the change in their
   * midpoint is the pan.
   */

  /** Where each finger currently is, in canvas pixels. */
  private touchPoints = new Map<number, Point>()

  /** The last pair reading, or null when fewer than two fingers are down. */
  private pinch: { distance: number; centre: Point } | null = null

  /**
   * True from the moment a second finger lands until the last one lifts.
   *
   * It outlives `pinch` on purpose. Lifting one finger of two must not hand the
   * remaining one back to the tool: that finger has been dragging across the screen
   * for the whole gesture, and resuming from wherever it happens to be would draw a
   * rectangle from one corner of the pinch.
   */
  private pinching = false

  /** Below this the midpoint is meaningless and the ratio explodes. */
  private static readonly MIN_PINCH_PX = 12

  private readPinch(): { distance: number; centre: Point } | null {
    const points = [...this.touchPoints.values()]
    if (points.length < 2) return null
    const [a, b] = points
    return {
      distance: Math.hypot(b.x - a.x, b.y - a.y),
      centre: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    }
  }

  private applyPinch(): void {
    const previous = this.pinch
    const next = this.readPinch()
    this.pinch = next
    if (previous === null || next === null) return

    if (previous.distance > CanvasEngine.MIN_PINCH_PX) {
      this.camera.zoomBy(next.centre.x, next.centre.y, next.distance / previous.distance)
    }
    // After the zoom, so the pan is applied to the scale the fingers are now at.
    this.camera.panByScreen(next.centre.x - previous.centre.x, next.centre.y - previous.centre.y)
    this.requestRender()
  }

  private onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      this.touchPoints.set(event.pointerId, this.toCanvasPoint(event))

      if (this.touchPoints.size >= 2) {
        if (!this.pinching) {
          this.pinching = true
          // The first finger has already started something. Drop it rather than
          // leaving a half-drawn shape behind the gesture.
          this.tool.cancel?.()
          this.events.onPointerWorld?.(null)
        }
        this.pinch = this.readPinch()
        return
      }
    }

    // Middle-click pans regardless of tool, the convention every canvas app shares.
    if (event.button === 1 || this.spacePanning) {
      this.beginTemporaryPan()
    } else if (event.button !== 0) {
      return
    }

    /*
     * On a writing surface, a click on the page starts writing on the rule you clicked.
     *
     * Not select-then-double-click-to-edit, which is how you handle an object lying on
     * a canvas and not how anybody handles paper.
     *
     * The band decides, and nothing else does. This used to hit-test the objects first
     * and only fall back to the band, which sounds more precise and is the bug: a hit
     * test is generous by design - it carries a tolerance so small things stay
     * clickable - and on a page where every band touches the next one, generosity means
     * a row claiming the rule below it. An empty rule between two written ones could
     * not be clicked into at all; the writing went to the end of the line above.
     * `beginWritingRow` still hands a click back to whichever row already covers that
     * band, so writing that has wrapped over several rules is continued rather than
     * written over.
     */
    if (this.column !== null && this.toolId === 'select' && this.host.canWrite) {
      const row = this.rowAt(this.toPointerEvent(event).world.y)
      /*
       * Clicking the line you are already writing on leaves you writing on it.
       *
       * This looks like a no-op and is the opposite of one. Without the
       * `preventDefault` the pointer's own default moves focus to the canvas, which
       * blurs the editor, which exits it, which throws the row away again if nothing
       * has been typed on it yet - so on a page that opens with the caret on its first
       * line, the first click anywhere near that line left the page with no caret at
       * all and nothing to type into. It read as a page refusing to be written on, and
       * it was worst on a page just started, because that is the one whose first line
       * is empty and has the caret. Suppressing the default keeps the caret where it
       * already is, which is what the click was asking for.
       */
      if (this.editing !== null && this.rowObjectAt(this.rowTop(row)) === this.editing.id) {
        event.preventDefault()
        return
      }
      this.beginWritingRow(row)
      return
    }

    this.app.canvas.setPointerCapture(event.pointerId)
    this.tool.onPointerDown(this.toPointerEvent(event))
  }

  private onPointerMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      if (this.touchPoints.has(event.pointerId)) {
        this.touchPoints.set(event.pointerId, this.toCanvasPoint(event))
      }
      if (this.pinching) {
        this.applyPinch()
        return
      }
    }

    const canvasEvent = this.toPointerEvent(event)
    // Presence is told once, about where the hand actually is. The samples below are
    // the shape of how it got there, which is the pen's business and nobody else's.
    this.events.onPointerWorld?.(canvasEvent.world)

    if (this.tool.usesCoalesced === true && typeof event.getCoalescedEvents === 'function') {
      const batch = event.getCoalescedEvents()
      if (batch.length > 1) {
        const bounds = this.app.canvas.getBoundingClientRect()
        for (const sample of batch) this.tool.onPointerMove(this.toPointerEvent(sample, bounds))
        return
      }
    }

    this.tool.onPointerMove(canvasEvent)
  }

  private onPointerLeave = (): void => {
    this.events.onPointerWorld?.(null)
  }

  private onPointerUp = (event: PointerEvent): void => {
    if (event.pointerType === 'touch') {
      const wasPinching = this.pinching
      this.touchPoints.delete(event.pointerId)

      if (this.touchPoints.size === 0) this.pinching = false
      this.pinch = this.readPinch()

      if (wasPinching) {
        if (this.app.canvas.hasPointerCapture(event.pointerId)) {
          this.app.canvas.releasePointerCapture(event.pointerId)
        }
        return
      }
    }

    if (this.app.canvas.hasPointerCapture(event.pointerId)) {
      this.app.canvas.releasePointerCapture(event.pointerId)
    }
    this.tool.onPointerUp(this.toPointerEvent(event))
    this.endTemporaryPan()
  }

  private temporaryPanFrom: ToolId | null = null

  private beginTemporaryPan(): void {
    if (this.temporaryPanFrom !== null || this.toolId === 'hand') return
    this.temporaryPanFrom = this.toolId
    this.setTool('hand')
  }

  private endTemporaryPan(): void {
    if (this.temporaryPanFrom === null || this.spacePanning) return
    this.setTool(this.temporaryPanFrom)
    this.temporaryPanFrom = null
  }

  /**
   * A wheel event in pixels.
   *
   * `deltaY` is only a pixel count when `deltaMode` says so. Firefox reports lines on a
   * mouse wheel and some browsers report pages, and reading either as pixels gives a
   * page that either barely moves or leaps a screen at a time.
   */
  private wheelPixels(event: WheelEvent): { x: number; y: number } {
    const scale =
      event.deltaMode === 1
        ? WHEEL_LINE_PX
        : event.deltaMode === 2
          ? this.viewportHeight
          : 1
    return { x: event.deltaX * scale, y: event.deltaY * scale }
  }

  private onWheel = (event: WheelEvent): void => {
    event.preventDefault()
    const point = this.toCanvasPoint(event)

    // Ctrl or meta plus wheel is zoom. A trackpad pinch arrives as ctrl+wheel too,
    // which is why both map to the same gesture.
    if (event.ctrlKey || event.metaKey) {
      // Zoom stays immediate. It is anchored to the pointer, and easing a move that has
      // to keep one world point under the cursor makes the thing you are pointing at
      // slide out from under it.
      this.camera.zoomBy(point.x, point.y, Math.exp(-this.wheelPixels(event).y * 0.01))
    } else {
      const delta = this.wheelPixels(event)
      // Shift is the horizontal wheel, which is a wheel that only reports deltaY.
      const dx = event.shiftKey ? delta.y : delta.x
      const dy = event.shiftKey ? 0 : delta.y
      this.wheelPending.x = clamp(this.wheelPending.x - dx, -WHEEL_MAX_PENDING, WHEEL_MAX_PENDING)
      this.wheelPending.y = clamp(this.wheelPending.y - dy, -WHEEL_MAX_PENDING, WHEEL_MAX_PENDING)
      // The next step is measured from now, not from whenever the last one ran, or a
      // wheel that has been still for a second starts with a full frame of catch-up.
      if (this.wheelAt === 0) this.wheelAt = performance.now()
    }
    this.requestRender()
  }

  private onKeyDown = (event: KeyboardEvent): void => {
    const target = event.target
    // Never steal keys from a text field. M3 adds real text editing on top of this.
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA')
    ) {
      return
    }

    const accel = event.ctrlKey || event.metaKey

    if (event.code === 'Space' && !this.spacePanning) {
      this.spacePanning = true
      this.beginTemporaryPan()
      event.preventDefault()
      return
    }

    if (accel && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      if (event.shiftKey) this.host.redo()
      else this.host.undo()
      return
    }
    if (accel && event.key.toLowerCase() === 'a') {
      event.preventDefault()
      this.selectAll()
      return
    }
    if (accel && event.key === ']') {
      event.preventDefault()
      this.host.bringToFront(this.getSelection())
      return
    }
    if (accel && event.key === '[') {
      event.preventDefault()
      this.host.sendToBack(this.getSelection())
      return
    }

    switch (event.key) {
      case 'Delete':
      case 'Backspace':
        event.preventDefault()
        this.deleteSelection()
        return
      case 'Escape':
        this.stopEditing()
        this.tool.cancel?.()
        this.setSelection([])
        return
      case ']':
        this.host.bringForward(this.getSelection())
        return
      case '[':
        this.host.sendBackward(this.getSelection())
        return
      case '0':
        this.resetZoom()
        return
      case '1':
        this.zoomToFit()
        return
      case 'v':
      case 'V':
        this.setTool('select')
        return
      case 'h':
      case 'H':
        this.setTool('hand')
        return
      case 'r':
      case 'R':
        this.setTool('rect')
        return
      case 'o':
      case 'O':
        this.setTool('ellipse')
        return
      case 'd':
      case 'D':
        this.setTool('diamond')
        return
      // G for the last letter of it, since P is the pen and every other letter in the
      // word is already a tool. Nothing groups objects yet, so G is free.
      case 'g':
      case 'G':
        this.setTool('parallelogram')
        return
      // The four that came with the second batch of shapes take whatever letter of
      // their own name was still free: J from the end of triangle, Z from trapezoid,
      // N from polygon, Y from cylinder. None of them is a first letter, because T, S,
      // P and C are all taken by tools that were here first and moving one of those to
      // make room would break a shortcut people already use.
      case 'j':
      case 'J':
        this.setTool('triangle')
        return
      case 'z':
      case 'Z':
        this.setTool('trapezoid')
        return
      case 'n':
      case 'N':
        this.setTool('polygon')
        return
      case 'y':
      case 'Y':
        this.setTool('cylinder')
        return
      case 't':
      case 'T':
        this.setTool('text')
        return
      case 's':
      case 'S':
        this.setTool('sticky')
        return
      case 'a':
      case 'A':
        this.setTool('arrow')
        return
      case 'l':
      case 'L':
        this.setTool('line')
        return
      case 'p':
      case 'P':
        this.setTool('pen')
        return
      case 'Enter':
        // Enter edits the selected text object, the keyboard equivalent of a
        // double-click. Ignored for anything else.
        if (this.selected.size === 1) {
          const [id] = this.selected
          if (this.beginTextEdit(id)) event.preventDefault()
        }
        return
      default:
        this.tool.onKeyDown?.(event)
    }
  }

  private onKeyUp = (event: KeyboardEvent): void => {
    if (event.code !== 'Space') return
    this.spacePanning = false
    this.endTemporaryPan()
  }

  private onContextMenu = (event: MouseEvent): void => {
    event.preventDefault()
  }

  /**
   * Double-click enters text editing. ARCHITECTURE 5, step 2.
   *
   * Only text-bearing types respond. Double-clicking a rectangle does nothing rather
   * than growing a text field on it, because "everything is secretly a text box" is
   * the behaviour that makes a canvas feel unpredictable.
   */
  private onDoubleClick = (event: MouseEvent): void => {
    const screen = this.toCanvasPoint(event as unknown as PointerEvent)
    const world = this.camera.screenToWorld(screen.x, screen.y)
    const tolerance = this.camera.toWorldDistance(8)

    const rect = {
      minX: world.x - tolerance,
      minY: world.y - tolerance,
      maxX: world.x + tolerance,
      maxY: world.y + tolerance,
    }
    const candidates = new Set(this.index.search(rect))

    // Reverse z-order: the topmost object under the pointer wins, same rule as a click.
    const order = this.host.order()
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const id = order[index]
      if (!candidates.has(id)) continue
      const object = this.cache.get(id)
      if (object === undefined || !isTextBearing(object.type)) continue
      // Precise, not the bounding box. The index answers with boxes, and for a
      // diamond or an ellipse most of that box is empty space outside the shape:
      // without this, double-clicking the blank corner beside a diamond opened its
      // label, and a click that visually missed the shape started editing it.
      if (!hitsObject(object, world, tolerance)) continue

      event.preventDefault()
      this.beginTextEdit(id)
      return
    }
  }

  private attachInput(): void {
    const canvas = this.app.canvas
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointercancel', this.onPointerUp)
    canvas.addEventListener('wheel', this.onWheel, { passive: false })
    canvas.addEventListener('pointerleave', this.onPointerLeave)
    canvas.addEventListener('dblclick', this.onDoubleClick)
    canvas.addEventListener('contextmenu', this.onContextMenu)
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('keyup', this.onKeyUp)
  }

  private detachInput(): void {
    // `this.app?.canvas` is not the guard it looks like. Pixi's `canvas` getter reads
    // through `renderer`, which does not exist until `app.init` resolves, so an engine
    // torn down mid-init threw here rather than returning undefined. Nothing was
    // attached in that case anyway: `attachInput` runs at the end of `init`.
    if (!this.ready) return
    const canvas = this.app.canvas
    if (canvas !== undefined) {
      canvas.removeEventListener('pointerdown', this.onPointerDown)
      canvas.removeEventListener('pointermove', this.onPointerMove)
      canvas.removeEventListener('pointerup', this.onPointerUp)
      canvas.removeEventListener('pointercancel', this.onPointerUp)
      canvas.removeEventListener('wheel', this.onWheel)
      canvas.removeEventListener('pointerleave', this.onPointerLeave)
      canvas.removeEventListener('dblclick', this.onDoubleClick)
      canvas.removeEventListener('contextmenu', this.onContextMenu)
    }
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('keyup', this.onKeyUp)
  }
}
