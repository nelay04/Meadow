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
  type BindingData,
  type ObjectData,
  type TextProps,
  readObject,
  resolveTextProps,
} from '@meadow/schema'
import type * as Y from 'yjs'

import type { EngineHost } from '../canvas/engine'
import {
  type DocSession,
  ReadOnlyError,
  addObject,
  bindArrow,
  bringForward,
  bringToFront,
  deleteObjects,
  endGesture,
  objectFragment,
  sendBackward,
  sendToBack,
  setArrowPoints,
  updateObjects,
} from './mutations'
import { fragmentToHtml } from './richText'

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
}) => { destroy(): void }

export type HostOptions = {
  /** Called when a write is refused because the role is read-only. */
  onRefused?(message: string): void
  createEditor?: EditorFactory
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

  /**
   * Mount an editor into an overlay element. Returns the teardown, or null when this
   * host has no editor factory or the object carries no fragment.
   */
  beginEdit(id: string, element: HTMLElement, onExit: () => void): (() => void) | null {
    const factory = this.options.createEditor
    if (factory === undefined) return null

    const fragment = objectFragment(this.session, id)
    if (fragment === null) return null

    const object = this.object(id)
    if (object === undefined) return null

    const editor = factory({
      element,
      fragment,
      props: resolveTextProps(object),
      // A viewer still gets a caret and can select and copy. The write path is what is
      // closed off, in exactly one place, the same as every other mutation.
      editable: this.session.canWrite,
      onExit,
    })

    return () => editor.destroy()
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
