/**
 * The tool state machine. ARCHITECTURE 5.
 *
 * One tool is active at a time and owns the pointer. Tools never touch the Y.Doc
 * directly: they call through `ToolContext`, which routes writes to doc/mutations so
 * the transaction wrapping and the read-only check stay in one place.
 */

import type { ArrowRouting, ArrowRoutingPatch, BindingData, ObjectData } from '@meadow/schema'

import type { Camera, Point, WorldRect } from '../camera'
import type { SnapGuide } from '../snapping'

export type ToolId =
  | 'select'
  | 'hand'
  | 'rect'
  | 'ellipse'
  | 'diamond'
  | 'text'
  | 'sticky'
  | 'arrow'
  | 'line'

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
  onKeyDown?(event: KeyboardEvent): void
  /** Called when the tool is swapped out mid-gesture, so it can drop its state. */
  cancel?(): void
}
