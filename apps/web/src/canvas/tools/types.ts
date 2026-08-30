/**
 * The tool state machine. ARCHITECTURE 5.
 *
 * One tool is active at a time and owns the pointer. Tools never touch the Y.Doc
 * directly: they call through `ToolContext`, which routes writes to doc/mutations so
 * the transaction wrapping and the read-only check stay in one place.
 */

import type {
  ArrowRouting,
  ArrowRoutingPatch,
  BindingData,
  FreedrawTip,
  ObjectData,
} from '@meadow/schema'

import type { Camera, Point, WorldRect } from '../camera'
import type { SnapGuide } from '../snapping'

export type ToolId =
  | 'select'
  | 'hand'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'parallelogram'
  | 'text'
  | 'sticky'
  | 'arrow'
  | 'line'
  | 'pen'

export type CanvasPointerEvent = {
  /** Position in world coordinates. */
  world: Point
  /** Position in CSS pixels relative to the canvas. */
  screen: Point
  shiftKey: boolean
  altKey: boolean
  ctrlKey: boolean
  metaKey: boolean
  button: number
  pointerId: number
  /**
   * 0..1, straight from the pointer event.
   *
   * A stylus reports what it is being leant on. A mouse reports a constant, and
   * browsers do not agree on which constant, so nothing may read this as "how hard"
   * without first checking `pointerType`. The pen tool is the only caller and it does
   * exactly that.
   */
  pressure: number
  /** 'mouse', 'pen' or 'touch'. Which of those it is decides what `pressure` means. */
  pointerType: string
}

/**
 * How the pen is currently set, chosen in the rail before a stroke rather than after.
 *
 * A nib is not a style you apply to a finished mark. It is the thing that made the
 * mark, and changing it afterwards would be asking to have written it again, so this
 * lives on the tool and never touches ink that already exists.
 */
export type PenSettings = {
  tip: FreedrawTip
  /** The nib's width in world units, before the tip's own scale. */
  size: number
  /** The angle a bladed nib is held at, in radians. */
  angle: number
  /** An explicit colour, or null to take the surface's own ink. */
  color: number | null
}

/**
 * A stroke still under the pointer.
 *
 * Wet ink is not in the document yet, deliberately. A stroke is one object and one
 * undo step, and streaming it in would mean a Yjs update per pointer sample, each
 * rewriting the whole points array, for a shape that is not final until the pointer
 * lifts. The cost is that a peer sees the stroke when it is finished rather than as it
 * is drawn, which is the trade Excalidraw makes too. Presence still shows the hand
 * moving, so nobody is looking at a frozen board.
 *
 * It lives beside the marquee rect as transient engine state: gesture state, not
 * document state, so ARCHITECTURE 2 has nothing to say about it.
 */
export type WetInk = {
  /** World-space samples, flat [x, y, pressure]. */
  points: readonly number[]
  tip: FreedrawTip
  size: number
  angle: number
  color: number | null
}

export type ToolContext = {
  readonly camera: Camera
  readonly canWrite: boolean

  /** Ascending z-order. */
  order(): readonly string[]
  object(id: string): ObjectData | undefined
  /** Ids whose bounds intersect a world rectangle. */
  query(rect: WorldRect): string[]
  /** Objects currently on screen, for snapping candidates. */
  visibleObjects(): readonly ObjectData[]

  selection(): ReadonlySet<string>
  setSelection(ids: Iterable<string>): void

  /** Transient overlay state, cleared when a gesture ends. */
  setMarquee(rect: WorldRect | null): void
  setGuides(guides: readonly SnapGuide[]): void
  /** The stroke currently under the pointer, drawn by the engine until it is committed. */
  setWetInk(ink: WetInk | null): void
  /** The object an arrow end would attach to, highlighted while drawing. */
  setHoverTarget(id: string | null): void
  /**
   * The shape currently offering connector dots, or null. Hover state, so the tool
   * publishes it and the engine draws it; the engine has no notion of what is hovered.
   */
  setConnectorHost(id: string | null): void

  createObject(input: Partial<ObjectData> & { type: ObjectData['type'] }): string | null
  applyPatches(patches: { id: string; patch: Partial<ObjectData> }[]): void
  /** Move an arrow's endpoints. Bounds and relative points are written together. */
  setArrowPoints(id: string, absolute: readonly number[]): void
  /** Attach an arrow end to an object. Replaces any existing binding on that end. */
  bindArrow(input: Omit<BindingData, 'id'>): void
  /**
   * Change how an arrow is routed. Bounds are re-derived with it, because a curved
   * arrow does not fit inside the box its two endpoints span.
   */
  setArrowRouting(id: string, patch: ArrowRoutingPatch): void
  /**
   * The routing a newly drawn arrow should get, chosen in the tool rail.
   *
   * A getter on the context rather than a value passed to the tool's factory, because
   * the choice can change while the tool is mounted and a captured value would draw
   * the previous one until the user switched tools and back.
   */
  readonly arrowRouting: ArrowRouting
  /**
   * The nib the next stroke will be drawn with. A getter for the same reason
   * `arrowRouting` is one: it changes while the tool is mounted.
   */
  readonly pen: PenSettings
  /** The local person's display name, for the byline on a new sticky. */
  readonly authorName: string
  /** Close the current undo step. Call when a gesture completes. */
  commit(): void
  /**
   * Enter text editing on an object. False when it is not editable, which a tool
   * treats as "created it, leave it empty" rather than an error.
   */
  beginTextEdit(id: string): boolean

  /**
   * Switch the active tool.
   *
   * Creation tools call this with `select` once they have made something, so the
   * gesture after drawing is the one you almost always want next - adjusting what you
   * just drew - rather than drawing a second one. Holding the tool is the rarer case
   * and it costs one click.
   */
  setTool(tool: ToolId): void

  requestRender(): void
  setCursor(cursor: string): void
}

export interface Tool {
  readonly id: ToolId
  readonly cursor: string
  onPointerDown(event: CanvasPointerEvent): void
  onPointerMove(event: CanvasPointerEvent): void
  onPointerUp(event: CanvasPointerEvent): void
  /**
   * Deliver every sample the browser buffered, not just the latest one.
   *
   * A pointer emits far faster than a frame, and the browser coalesces the surplus.
   * For a marquee or a drag the extra samples are the same answer computed more often,
   * so the default is to ignore them. For ink they are the stroke: dropping them is
   * what turns a curve drawn quickly into a run of straight lines between the frames
   * that happened to fire.
   */
  readonly usesCoalesced?: boolean
  onKeyDown?(event: KeyboardEvent): void
  /** Called when the tool is swapped out mid-gesture, so it can drop its state. */
  cancel?(): void
}
