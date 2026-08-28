/**
 * Adapts a DocSession to the canvas engine's host interface.
 *
 * Shared by the board view and the dev harness, so there is one definition of how the
 * engine reaches the document rather than two that drift.
 *
 * The z-order cache is the reason this is a class rather than an object literal. The
 * engine asks for the order once per frame, and `Y.Array.toArray()` allocates a fresh
 * array of every id each time. At 5,000 objects that alone was most of the frame's CPU
 * budget, for a value that only changes when something is created, deleted, or
 * restacked.
 */

import {
  type ArrowRoutingPatch,
  type BindingData,
  type ObjectData,
  type TextProps,
  readObject,
  resolveTextProps,
} from '@meadow/schema'
import type * as Y from 'yjs'

import type { EngineHost } from '../canvas/engine'
import type { SurfaceType } from '../canvas/surface'
import {
  type DocSession,
  ReadOnlyError,
  addObject,
  bindArrow,
  bringForward,
  bringToFront,
  deleteObjects,
  endGesture,
  ensureObjectFragment,
  objectFragment,
  sendBackward,
  sendToBack,
  setArrowPoints,
  setArrowRouting,
  updateObjects,
} from './mutations'
import { type TextMark, fragmentToHtml, fragmentToPlainText } from './richText'

/**
 * Mounts a rich-text editor onto a fragment. Supplied by the caller rather than
 * imported, so neither the engine nor this file pulls in ProseMirror. A host built
 * without one renders text but cannot edit it, which is exactly what the dev harness
 * and a read-only embed want.
 */
export type EditorFactory = (options: {
  element: HTMLElement
  fragment: Y.XmlFragment
  props: TextProps
  editable: boolean
  onExit(): void
  onLeave?(direction: 'up' | 'down'): boolean
  onMarks?(marks: TextMark[]): void
}) => {
  destroy(): void
  toggleMark(mark: TextMark): void
  activeMarks(): TextMark[]
}

export type HostOptions = {
  /** Called when a write is refused because the role is read-only. */
  onRefused?(message: string): void
  /** The marks under the caret in the live editor, whenever they change. */
  onMarks?(marks: TextMark[]): void
  createEditor?: EditorFactory
  /**
   * The signed-in person's display name, for the byline on a sticky note.
   *
   * A getter, because the name is fetched after the engine is built and a captured
   * value would be empty for the whole session. It is stamped onto the object at
   * creation rather than resolved at render time: `createdBy` is a user id, and there
   * is no way to turn one into a name for somebody who is not currently connected -
   * a note would lose its author the moment they closed the tab.
   */
  authorName?(): string
}

export class DocEngineHost implements EngineHost {
  private orderCache: readonly string[] | null = null
  private readonly onOrderChanged = (): void => {
    this.orderCache = null
  }

  /**
   * `getSession` rather than a session, because the session's identity changes when
   * the role is resolved on a reconnect. Capturing one would pin the engine to the
   * role it started with, which for a viewer promoted to editor means writes keep
   * being refused until the page is reloaded.
   */
  constructor(
    private readonly getSession: () => DocSession,
    private readonly options: HostOptions = {},
  ) {}

  /** Start watching the roots this host caches. Returns the unsubscribe. */
  observe(): () => void {
    const order = this.getSession().order
    order.observe(this.onOrderChanged)
    return () => order.unobserve(this.onOrderChanged)
  }

  get authorName(): string {
    return this.options.authorName?.() ?? ''
  }

  /** Drop the cache after a change this host did not observe. */
  invalidate(): void {
    this.orderCache = null
  }

  private get session(): DocSession {
    return this.getSession()
  }

  private guard<T>(fn: () => T, fallback: T): T {
    try {
      return fn()
    } catch (error) {
      if (error instanceof ReadOnlyError) {
        this.options.onRefused?.(error.message)
        return fallback
      }
      throw error
    }
  }

  order(): readonly string[] {
    this.orderCache ??= this.session.order.toArray()
    return this.orderCache
  }

  object(id: string): ObjectData | undefined {
    const map = this.session.objects.get(id)
    return map === undefined ? undefined : readObject(map)
  }

  *allObjects(): Iterable<ObjectData> {
    for (const map of this.session.objects.values()) yield readObject(map)
  }

  get canWrite(): boolean {
    return this.session.canWrite
  }

  createObject(input: Partial<ObjectData> & { type: ObjectData['type'] }): string | null {
    return this.guard(() => addObject(this.session, input), null)
  }

  applyPatches(patches: { id: string; patch: Partial<ObjectData> }[]): void {
    this.guard(() => updateObjects(this.session, patches), undefined)
  }

  deleteObjects(ids: readonly string[]): void {
    this.guard(() => deleteObjects(this.session, ids), undefined)
  }

  commit(): void {
    endGesture(this.session)
  }

  undo(): void {
    this.session.undo.undo()
  }

  redo(): void {
    this.session.undo.redo()
  }

  bringForward(ids: readonly string[]): void {
    this.guard(() => bringForward(this.session, ids), undefined)
  }

  sendBackward(ids: readonly string[]): void {
    this.guard(() => sendBackward(this.session, ids), undefined)
  }

  bringToFront(ids: readonly string[]): void {
    this.guard(() => bringToFront(this.session, ids), undefined)
  }

  sendToBack(ids: readonly string[]): void {
    this.guard(() => sendToBack(this.session, ids), undefined)
  }

  setArrowPoints(id: string, absolute: readonly number[]): void {
    this.guard(() => setArrowPoints(this.session, id, absolute), undefined)
  }

  bindArrow(input: Omit<BindingData, 'id'>): void {
    this.guard(() => bindArrow(this.session, input), undefined)
  }

  setArrowRouting(id: string, patch: ArrowRoutingPatch): void {
    this.guard(() => setArrowRouting(this.session, id, patch), undefined)
  }

  /**
   * Static HTML for an idle text object.
   *
   * Not cached here. The overlay only asks when its own observer said the fragment
   * changed, so a cache at this level would be a second copy of that bookkeeping with
   * nothing to invalidate it correctly.
   */
  textHtml(id: string): string {
    const fragment = objectFragment(this.session, id)
    return fragment === null ? '' : fragmentToHtml(fragment)
  }

  /** Plain text, for thumbnails, search, and anything that is not the overlay. */
  textPlain(id: string): string {
    const fragment = objectFragment(this.session, id)
    return fragment === null ? '' : fragmentToPlainText(fragment)
  }

  /**
   * Mount an editor into an overlay element. Returns the teardown, or null when this
   * host has no editor factory or the object carries no fragment.
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
  ): (() => void) | null {
    const factory = this.options.createEditor
    if (factory === undefined) return null

    // `ensure`, not `read`: a shape drawn before the primitives became text-bearing
    // has no fragment yet, and the first double-click is what attaches it.
    const fragment = ensureObjectFragment(this.session, id)
    if (fragment === null) return null

    const object = this.object(id)
    if (object === undefined) return null

    /*
     * The same ink fallback the idle text layer applies, for the same reason and with
     * the same limit: an object whose document names a colour keeps it, and one that
     * does not follows the surface.
     *
     * Without this the editor took the schema's default instead, so text changed colour
     * the moment you stopped typing. On a lea that is brown paper against navy ink and
     * impossible to miss; on a dark glade it was there all along and simply looked like
     * the caret being a different shade.
     */
    const props = resolveTextProps(object)
    if (typeof object.props.color !== 'number') props.color = surface.ink

    // And the same override, for the same reason: the ruled page sets the type its
    // rows are written in, whatever metrics a given row happens to carry.
    if (surface.type !== null) Object.assign(props, surface.type)

    const editor = factory({
      element,
      fragment,
      props,
      // A viewer still gets a caret and can select and copy. The write path is what is
      // closed off, in exactly one place, the same as every other mutation.
      editable: this.session.canWrite,
      onExit,
      onLeave: surface.onLeave,
      onMarks: (marks) => this.options.onMarks?.(marks),
    })

    this.editor = editor
    return () => {
      if (this.editor === editor) this.editor = null
      editor.destroy()
    }
  }

  /**
   * The live editor, or null.
   *
   * Held here rather than in the engine because the engine must not know what an
   * editor is - it receives one through a factory and only ever tears it down. The
   * formatting bar needs to send commands to it, and this is the one place that both
   * owns the instance and is allowed to know its shape.
   */
  private editor: {
    destroy(): void
    toggleMark(mark: TextMark): void
    activeMarks(): TextMark[]
  } | null = null

  toggleTextMark(mark: TextMark): void {
    this.editor?.toggleMark(mark)
  }
}

/**
 * Feed a Y.Doc's changes into an engine's cache.
 *
 * `observeDeep` reports a nested field write with the object id as the first path
 * segment, and an add or remove on the map itself with an empty path. Translating
 * those into a targeted update matters: rebuilding the whole cache per event would be
 * O(objects) on every pointermove of a drag.
 *
 * Every consumer of the engine needs this, and a consumer that forgets it gets an
 * engine that renders the initial load and then silently ignores every edit after it.
 * That is why it lives here rather than in each caller.
 */
export function observeDocument(
  session: DocSession,
  engine: {
    applyChanges(changed: Iterable<string>, removed: Iterable<string>): void
    requestRender(): void
  },
): () => void {
  const onObjects = (events: Y.YEvent<Y.AbstractType<unknown>>[]): void => {
    const changed = new Set<string>()
    const removed = new Set<string>()

    for (const event of events) {
      if (event.path.length === 0) {
        for (const [key, change] of event.changes.keys) {
          if (change.action === 'delete') removed.add(key)
          else changed.add(key)
        }
      } else {
        changed.add(String(event.path[0]))
      }
    }

    engine.applyChanges(changed, removed)
  }

  // Reordering changes no geometry, only paint order, so a redraw is enough and the
  // object cache can stay as it is.
  const onOrder = (): void => engine.requestRender()

  session.objects.observeDeep(onObjects)
  session.order.observe(onOrder)

  return () => {
    session.objects.unobserveDeep(onObjects)
    session.order.unobserve(onOrder)
  }
}

export type { Y }
