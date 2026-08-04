/**
 * The tool state machine. ARCHITECTURE 5.
 *
 * One tool is active at a time and owns the pointer. Tools never touch the Y.Doc
 * directly: they call through `ToolContext`, which routes writes to doc/mutations so
 * the transaction wrapping and the read-only check stay in one place.
 */

import type { BindingData, ObjectData } from '@meadow/schema'

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

  createObject(input: Partial<ObjectData> & { type: ObjectData['type'] }): string | null
  applyPatches(patches: { id: string; patch: Partial<ObjectData> }[]): void
  /** Move an arrow's endpoints. Bounds and relative points are written together. */
  setArrowPoints(id: string, absolute: readonly number[]): void
  /** Attach an arrow end to an object. Replaces any existing binding on that end. */
  bindArrow(input: Omit<BindingData, 'id'>): void
  /** Close the current undo step. Call when a gesture completes. */
  commit(): void
  /**
   * Enter text editing on an object. False when it is not editable, which a tool
   * treats as "created it, leave it empty" rather than an error.
   */
  beginTextEdit(id: string): boolean

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
