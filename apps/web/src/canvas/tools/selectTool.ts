/**
 * Select, move, resize, rotate, marquee, and everything you can do to an arrow.
 *
 * The gesture is decided on pointer-down and does not change mid-drag. Re-deciding on
 * movement is how a canvas ends up starting a marquee because the pointer left the
 * object it grabbed.
 *
 * An arrow is not transformed like a shape and never has been in any tool worth
 * copying. A bounding box with eight resize handles and a rotation is meaningless for
 * a two-point path: you cannot see what "resize the box" means for a diagonal line,
 * and rotating it about the box centre moves both ends at once, which is never what
 * anybody wants. So a selected arrow gets three handles instead - its two ends and its
 * middle - and nothing else.
 */

import {
  type ObjectData,
  anchorFor,
  arrowGeometry,
  curvatureAt,
  elbowAxis,
  elbowFor,
  isArrowLike,
  resolveArrowProps,
  routeOrthogonal,
} from '@meadow/schema'

import type { Point, WorldRect } from '../camera'
import {
  CONNECTOR_GRAB_PX,
  CONNECTOR_OFFSET_PX,
  type ConnectorSide,
  anchorForSide,
  connectorAt,
  edgePointForSide,
} from '../connectors'
import { HIT_TOLERANCE_PX, containedBy, hitsObject, pickTop, unionBounds } from '../hitTest'
import { SNAP_THRESHOLD_PX, snapMove, snapResize } from '../snapping'
import {
  HANDLE_CURSORS,
  type HandleId,
  ROTATE_REACH_PX,
  type ResizeHandle,
  applyRectToObject,
  handleAt,
  resizeRect,
  rotateAbout,
  rotationFor,
} from '../transform'
import { ARROW_HANDLE_GRAB_PX, arrowHandleAt, arrowHandles } from '../arrowHandles'
import type { CanvasPointerEvent, Tool, ToolContext } from './types'

const HANDLE_GRAB_PX = 6

/** World units of travel before a press on a connector dot becomes an arrow. */
const CONNECT_THRESHOLD = 4

/**
 * Below this, a bend is not a bend. Dragging the middle handle back towards the chord
 * puts the arrow back to `straight` rather than leaving it curved with a curvature of
 * 0.003, so the type picker keeps agreeing with what is on screen.
 */
const CURVE_DEADZONE = 0.02

type Gesture =
  | { kind: 'none' }
  | { kind: 'marquee'; origin: Point; additive: boolean }
  | { kind: 'move'; origin: Point; start: ObjectData[]; box: WorldRect; moved: boolean }
  | { kind: 'resize'; handle: ResizeHandle; start: ObjectData[]; box: WorldRect }
  | { kind: 'rotate'; center: Point; start: ObjectData[]; startAngle: number }
  /** Dragging a connector dot out of a shape to draw an arrow from it. */
  | { kind: 'connect'; fromId: string; side: ConnectorSide; origin: Point; arrowId: string | null }
  /** Dragging one end of an existing arrow, to re-aim or re-attach it. */
  | { kind: 'endpoint'; arrowId: string; end: 'start' | 'end'; anchorPoint: Point }
  /** Dragging one of a curved arrow's bend handles. */
  | { kind: 'curve'; arrowId: string; start: Point; end: Point; t: number; which: 0 | 1 }
  /** Sliding an elbow's dogleg along the axis it turns on. */
  | { kind: 'elbow'; arrowId: string; start: Point; end: Point }

export function createSelectTool(context: ToolContext): Tool {
  let gesture: Gesture = { kind: 'none' }
  /*
   * The shape whose dots are currently on screen.
   *
   * Remembered rather than recomputed on pointer-down, and that is the whole point: a
   * connector dot sits *outside* its shape, so by the time you press one the pointer
   * is no longer over anything. Working the host out again from the press position
   * finds empty canvas and starts a marquee instead of an arrow.
   */
  let hoverHost: string | null = null

  const selectedObjects = (): ObjectData[] => {
    const out: ObjectData[] = []
    for (const id of context.selection()) {
      const object = context.object(id)
      if (object !== undefined && !object.locked) out.push(object)
    }
    return out
  }

  const selectionBox = (): WorldRect | null => unionBounds(selectedObjects())

  /**
   * The selection, when it is exactly one arrow.
   *
   * Everything arrow-specific hangs off this. A multi-selection containing an arrow is
   * deliberately not included: the union box is the only thing that can be transformed
   * coherently there, and giving one member of it private handles would be ambiguous.
   */
  const singleArrow = (): ObjectData | null => {
    const ids = context.selection()
    if (ids.size !== 1) return null
    const [id] = ids
    const object = context.object(id)
    if (object === undefined || object.locked || !isArrowLike(object.type)) return null
    return object
  }

  /** A shape an arrow may attach to. Arrows are excluded, same rule as the arrow tool. */
  const connectable = (object: ObjectData | undefined): object is ObjectData =>
    object !== undefined && !object.locked && !isArrowLike(object.type)

  const boundsOf = (object: ObjectData): WorldRect => ({
    minX: object.x,
    minY: object.y,
    maxX: object.x + object.w,
    maxY: object.y + object.h,
  })

  /** The dot of a given shape under a point, if any. */
  const sideOf = (object: ObjectData, world: Point): ConnectorSide | null =>
    connectorAt(
      boundsOf(object),
      world,
      context.camera.toWorldDistance(CONNECTOR_OFFSET_PX),
      context.camera.toWorldDistance(CONNECTOR_GRAB_PX),
    )

  /**
   * Which shape should be offering dots for a pointer at `world`.
   *
   * Three ways in, in priority order: the shape already showing dots keeps them while
   * the pointer is on it or on one of them, so reaching for a dot does not make the
   * dots disappear on the way; then a selected shape; then whatever is under the
   * pointer.
   */
  const connectorHostAt = (world: Point): ObjectData | null => {
    const held = hoverHost === null ? undefined : context.object(hoverHost)
    if (
      connectable(held) &&
      (sideOf(held, world) !== null ||
        hitsObject(held, world, context.camera.toWorldDistance(HIT_TOLERANCE_PX)))
    ) {
      return held
    }

    for (const id of context.selection()) {
      const object = context.object(id)
      if (!connectable(object)) continue
      if (
        sideOf(object, world) !== null ||
        hitsObject(object, world, context.camera.toWorldDistance(HIT_TOLERANCE_PX))
      ) {
        return object
      }
    }

    const hovered = hitAt(world)
    if (hovered === null) return null
    const object = context.object(hovered)
    return connectable(object) ? object : null
  }

  /** The shape under a point that a dragged arrow end would bind to. */
  const targetAt = (point: Point, exclude: string | null): string | null => {
    const tolerance = context.camera.toWorldDistance(HIT_TOLERANCE_PX)
    const candidates = new Set(
      context.query({
        minX: point.x - tolerance,
        minY: point.y - tolerance,
        maxX: point.x + tolerance,
        maxY: point.y + tolerance,
      }),
    )
    const order = context.order()
    for (let index = order.length - 1; index >= 0; index -= 1) {
      const id = order[index]
      if (id === exclude || !candidates.has(id)) continue
      const object = context.object(id)
      if (!connectable(object)) continue
      // No tolerance: an arrow attaches when dropped *on* a shape, not near it.
      if (hitsObject(object, point)) return id
    }
    return null
  }

  const hitAt = (world: Point): string | null => {
    const tolerance = context.camera.toWorldDistance(HIT_TOLERANCE_PX)
    const rect: WorldRect = {
      minX: world.x - tolerance,
      minY: world.y - tolerance,
      maxX: world.x + tolerance,
      maxY: world.y + tolerance,
    }
    return pickTop(
      context.order(),
      new Set(context.query(rect)),
      (id) => context.object(id),
      world,
      tolerance,
    )
  }

  /**
   * Write an arrow's two ends, re-routing if it has an elbow.
   *
   * An orthogonal arrow stores its waypoints, so writing just the two ends would
   * flatten it into a diagonal that snaps back to an elbow the next time anything
   * reflows it. A curved one stores only its ends and derives the rest, so it needs no
   * help here.
   */
  const writeEnds = (arrowId: string, start: Point, end: Point): void => {
    const arrow = context.object(arrowId)
    const props = arrow === undefined ? null : resolveArrowProps(arrow)
    const points =
      props !== null && props.routing === 'orthogonal'
        ? routeOrthogonal(start, end, props.elbow)
        : [start.x, start.y, end.x, end.y]
    context.setArrowPoints(arrowId, points)
  }

  /** On-screen objects other than the selection, which is what is being moved. */
  const snapTargets = (): ObjectData[] => {
    const selected = context.selection()
    return context.visibleObjects().filter((object) => !selected.has(object.id))
  }

  return {
    id: 'select',
    cursor: 'default',

    onPointerDown(event: CanvasPointerEvent): void {
      const arrow = singleArrow()

      /*
       * An arrow's own handles come before everything, including the shape underneath
       * them. An endpoint is usually sitting right on top of the box it is bound to,
       * so anything that resolved the object first would make a bound arrow's ends
       * ungrabbable, which is exactly the state this tool was in before.
       */
      if (arrow !== null && context.canWrite) {
        const handles = arrowHandles(arrow)
        const handle = arrowHandleAt(
          handles,
          event.world,
          context.camera.toWorldDistance(ARROW_HANDLE_GRAB_PX),
        )

        if (handle === 'start' || handle === 'end') {
          gesture = {
            kind: 'endpoint',
            arrowId: arrow.id,
            end: handle,
            // The end that is staying put, captured now. Reading it back each frame
            // would feed the solved position of a bound end into its own solve.
            anchorPoint: handle === 'start' ? handles.end : handles.start,
          }
          return
        }

        if (handle === 'elbow') {
          gesture = {
            kind: 'elbow',
            arrowId: arrow.id,
            start: handles.start,
            end: handles.end,
          }
          return
        }

        if (handle !== null) {
          const bend = handles.bends.find((candidate) => candidate.id === handle)
          if (bend !== undefined) {
            gesture = {
              kind: 'curve',
              arrowId: arrow.id,
              start: handles.start,
              end: handles.end,
              t: bend.t,
              // A straight arrow's single handle drives both bows at once, so it is
              // solved as the first one and the second is mirrored onto it below.
              which: handle === 'bend1' ? 1 : 0,
            }
            return
          }
        }
      }

      const box = arrow === null ? selectionBox() : null

      // Handles win over everything, including objects drawn on top of them.
      if (box !== null && context.canWrite) {
        const handle = handleAt(
          box,
          event.world,
          context.camera.toWorldDistance(HANDLE_GRAB_PX),
          context.camera.toWorldDistance(ROTATE_REACH_PX),
        )

        if (handle === 'rotate') {
          const center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 }
          gesture = {
            kind: 'rotate',
            center,
            start: selectedObjects(),
            startAngle: rotationFor(center, event.world, false),
          }
          return
        }
        if (handle !== null) {
          gesture = { kind: 'resize', handle, start: selectedObjects(), box }
          return
        }
      }

      /*
       * A connector dot beats the object under it. The dots sit just outside the
       * outline, so the only thing they can overlap is the empty space beside the
       * shape, and a press there is far more likely to mean "draw an arrow from here"
       * than "start a marquee two pixels from a box".
       */
      if (context.canWrite) {
        const host = connectorHostAt(event.world)
        if (host !== null) {
          const side = sideOf(host, event.world)
          if (side !== null) {
            gesture = {
              kind: 'connect',
              fromId: host.id,
              side,
              origin: edgePointForSide(boundsOf(host), side),
              arrowId: null,
            }
            context.setSelection([host.id])
            context.requestRender()
            return
          }
        }
      }

      const hit = hitAt(event.world)

      if (hit === null) {
        if (!event.shiftKey) context.setSelection([])
        gesture = { kind: 'marquee', origin: event.world, additive: event.shiftKey }
        context.requestRender()
        return
      }

      const selection = context.selection()
      if (event.shiftKey) {
        const next = new Set(selection)
        if (next.has(hit)) next.delete(hit)
        else next.add(hit)
        context.setSelection(next)
      } else if (!selection.has(hit)) {
        context.setSelection([hit])
      }

      if (!context.canWrite) {
        gesture = { kind: 'none' }
        context.requestRender()
        return
      }

      const start = selectedObjects()
      const startBox = unionBounds(start)
      gesture =
        startBox === null
          ? { kind: 'none' }
          : { kind: 'move', origin: event.world, start, box: startBox, moved: false }
      context.requestRender()
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (gesture.kind === 'none') {
        const arrow = singleArrow()
        let cursor = 'default'

        // An arrow's handles, then a shape's, then the connector dots. Same order the
        // press uses, so what the cursor promises is what the press does.
        if (arrow !== null && context.canWrite) {
          const handle = arrowHandleAt(
            arrowHandles(arrow),
            event.world,
            context.camera.toWorldDistance(ARROW_HANDLE_GRAB_PX),
          )
          if (handle === 'start' || handle === 'end') cursor = 'move'
          else if (handle === 'elbow') {
            // The dogleg only slides one way, so the cursor says which. Read from the
            // same function the route uses, not from a second comparison here.
            const ends = arrowHandles(arrow)
            cursor = elbowAxis(ends.start, ends.end) === 'x' ? 'ew-resize' : 'ns-resize'
          } else if (handle !== null) cursor = 'crosshair'
        }

        const box = arrow === null ? selectionBox() : null
        if (box !== null && context.canWrite && cursor === 'default') {
          const handle = handleAt(
            box,
            event.world,
            context.camera.toWorldDistance(HANDLE_GRAB_PX),
            context.camera.toWorldDistance(ROTATE_REACH_PX),
          )
          if (handle !== null) cursor = HANDLE_CURSORS[handle as HandleId]
        }

        // Which shape offers connector dots. Published every idle move, because the
        // dots are hover state and the engine cannot work it out for itself.
        const host = context.canWrite ? connectorHostAt(event.world) : null
        hoverHost = host?.id ?? null
        context.setConnectorHost(hoverHost)
        if (host !== null && cursor === 'default' && sideOf(host, event.world) !== null) {
          cursor = 'crosshair'
        }

        context.setCursor(cursor)
        context.requestRender()
        return
      }

      if (gesture.kind === 'endpoint') {
        const active = gesture
        const moving = event.world
        if (active.end === 'start') writeEnds(active.arrowId, moving, active.anchorPoint)
        else writeEnds(active.arrowId, active.anchorPoint, moving)

        context.setHoverTarget(targetAt(moving, active.arrowId))
        context.requestRender()
        return
      }

      if (gesture.kind === 'elbow') {
        const active = gesture
        context.setArrowRouting(active.arrowId, {
          elbow: elbowFor(active.start, active.end, event.world),
        })
        context.requestRender()
        return
      }

      if (gesture.kind === 'curve') {
        const active = gesture
        const arrow = context.object(active.arrowId)
        if (arrow === undefined) return
        const props = resolveArrowProps(arrow)
        const symmetric = props.routing !== 'curved'

        // A straight arrow being bent for the first time gets a symmetric C: both
        // bows solved together, at the midpoint, so one grab does the obvious thing.
        // Once it is a curve, each handle solves its own half against the other,
        // which is what lets the two lean opposite ways and make an S.
        const other = symmetric ? 0 : active.which === 0 ? props.curvatureEnd : props.curvature
        const solved = curvatureAt(
          active.start,
          active.end,
          event.world,
          active.t,
          symmetric ? 0 : active.which,
          other,
        )
        // Solved as one bow but applied to both, so the midpoint still lands under
        // the pointer: at t = 0.5 the two Bernstein terms are equal, so half each.
        const curvature = symmetric ? solved / 2 : active.which === 0 ? solved : props.curvature
        const curvatureEnd = symmetric ? solved / 2 : active.which === 1 ? solved : props.curvatureEnd

        // Straight is a routing, not a curvature of zero, so that the type picker and
        // the geometry never disagree about what this arrow is.
        context.setArrowRouting(
          active.arrowId,
          Math.abs(curvature) < CURVE_DEADZONE && Math.abs(curvatureEnd) < CURVE_DEADZONE
            ? { routing: 'straight', curvature: 0, curvatureEnd: 0 }
            : { routing: 'curved', curvature, curvatureEnd },
        )
        context.requestRender()
        return
      }

      if (gesture.kind === 'connect') {
        const from = context.object(gesture.fromId)
        if (from === undefined) return

        const absolute = [gesture.origin.x, gesture.origin.y, event.world.x, event.world.y]

        if (gesture.arrowId === null) {
          const moved =
            Math.abs(event.world.x - gesture.origin.x) > CONNECT_THRESHOLD ||
            Math.abs(event.world.y - gesture.origin.y) > CONNECT_THRESHOLD
          if (!moved) return

          // Created on the first real movement, so a click on a dot that goes nowhere
          // leaves no zero-length arrow behind.
          const geometry = arrowGeometry(absolute)
          const arrowId = context.createObject({
            type: 'arrow',
            x: geometry.x,
            y: geometry.y,
            w: geometry.w,
            h: geometry.h,
            // Same rail choice the arrow tool draws with. Dragging a connector dot is
            // still drawing an arrow, and it would be strange for it to ignore the
            // shape the user picked one panel away.
            props: { points: geometry.points, routing: context.arrowRouting },
          })
          if (arrowId === null) return

          gesture = { ...gesture, arrowId }
          // Bound immediately, so the tail tracks the shape from the first frame
          // rather than snapping onto it when the drag ends.
          context.bindArrow({
            arrowId,
            end: 'start',
            targetId: gesture.fromId,
            anchor: anchorForSide(gesture.side),
            gap: 4,
          })
        } else {
          context.setArrowPoints(gesture.arrowId, absolute)
        }

        context.setHoverTarget(targetAt(event.world, gesture.arrowId))
        context.requestRender()
        return
      }

      if (gesture.kind === 'marquee') {
        const rect: WorldRect = {
          minX: Math.min(gesture.origin.x, event.world.x),
          minY: Math.min(gesture.origin.y, event.world.y),
          maxX: Math.max(gesture.origin.x, event.world.x),
          maxY: Math.max(gesture.origin.y, event.world.y),
        }
        context.setMarquee(rect)

        const inside = context
          .query(rect)
          .filter((id) => {
            const object = context.object(id)
            return object !== undefined && !object.locked && containedBy(object, rect)
          })

        context.setSelection(gesture.additive ? new Set([...context.selection(), ...inside]) : inside)
        context.requestRender()
        return
      }

      if (gesture.kind === 'move') {
        let dx = event.world.x - gesture.origin.x
        let dy = event.world.y - gesture.origin.y

        // Shift constrains to the dominant axis.
        if (event.shiftKey) {
          if (Math.abs(dx) > Math.abs(dy)) dy = 0
          else dx = 0
        }

        const moving: WorldRect = {
          minX: gesture.box.minX + dx,
          minY: gesture.box.minY + dy,
          maxX: gesture.box.maxX + dx,
          maxY: gesture.box.maxY + dy,
        }

        // Alt disables snapping, the usual escape hatch for placing something between
        // two aligned neighbours.
        if (!event.altKey) {
          const snap = snapMove(
            moving,
            snapTargets(),
            context.camera.toWorldDistance(SNAP_THRESHOLD_PX),
          )
          dx += snap.dx
          dy += snap.dy
          context.setGuides(snap.guides)
        } else {
          context.setGuides([])
        }

        context.applyPatches(
          gesture.start.map((object) => ({
            id: object.id,
            patch: { x: object.x + dx, y: object.y + dy },
          })),
        )
        gesture.moved = true
        context.requestRender()
        return
      }

      if (gesture.kind === 'resize') {
        // Bound to a const first: `gesture` is reassigned by the other handlers, so
        // TypeScript drops the narrowing inside the map callback below.
        const active = gesture
        let after = resizeRect(active.box, active.handle, event.world, {
          preserveAspect: event.shiftKey,
          fromCenter: event.altKey,
        })

        // Snapping a resize, not just a move. Without it the only way to make two
        // boxes the same width is to get it right by hand, which on a shared board
        // nobody does and everybody notices.
        if (!event.altKey && !event.shiftKey) {
          const snap = snapResize(
            after,
            active.handle,
            snapTargets(),
            context.camera.toWorldDistance(SNAP_THRESHOLD_PX),
          )
          after = snap.rect
          context.setGuides(snap.guides)
        } else {
          context.setGuides([])
        }

        context.applyPatches(
          active.start.map((object) => ({
            id: object.id,
            patch: applyRectToObject(object, active.box, after),
          })),
        )
        context.requestRender()
        return
      }

      if (gesture.kind === 'rotate') {
        const active = gesture
        const angle = rotationFor(active.center, event.world, event.shiftKey)
        const delta = angle - active.startAngle
        context.applyPatches(
          active.start.map((object) => ({
            id: object.id,
            patch: rotateAbout(object, active.center, delta),
          })),
        )
        context.requestRender()
      }
    },

    onPointerUp(event: CanvasPointerEvent): void {
      if (gesture.kind === 'endpoint') {
        const { arrowId, end } = gesture
        gesture = { kind: 'none' }
        context.setHoverTarget(null)

        const targetId = targetAt(event.world, arrowId)
        const target = targetId === null ? undefined : context.object(targetId)

        // Written either way. Dropping an end on empty canvas has to *clear* the
        // binding it had, or the arrow springs back onto the shape the moment
        // anything reflows it, and the drag looks like it silently failed.
        context.bindArrow({
          arrowId,
          end,
          targetId: targetId,
          anchor: target === undefined ? { nx: 0.5, ny: 0.5 } : anchorFor(target, event.world),
          gap: 4,
        })

        context.commit()
        context.requestRender()
        return
      }

      if (gesture.kind === 'connect') {
        const { arrowId } = gesture
        gesture = { kind: 'none' }
        context.setHoverTarget(null)

        // A press on a dot that never travelled. Nothing was created, so there is
        // nothing to bind, nothing to undo and nothing to clean up.
        if (arrowId === null) {
          context.requestRender()
          return
        }

        const targetId = targetAt(event.world, arrowId)
        const target = targetId === null ? undefined : context.object(targetId)
        if (targetId !== null && target !== undefined) {
          // `anchorFor`, not `anchorForSide`: the far end was aimed by hand, so where
          // it landed is what the user meant. The near end is the one they chose by
          // picking a dot.
          context.bindArrow({
            arrowId,
            end: 'end',
            targetId,
            anchor: anchorFor(target, event.world),
            gap: 4,
          })
        }

        // As in the arrow tool: an elbow has to have its route generated once both
        // ends are settled.
        context.setArrowRouting(arrowId, { routing: context.arrowRouting })

        context.setSelection([arrowId])
        context.commit()
        context.requestRender()
        return
      }

      const wasActive = gesture.kind !== 'none'
      gesture = { kind: 'none' }
      context.setMarquee(null)
      context.setGuides([])
      if (wasActive) context.commit()
      context.requestRender()
    },

    cancel(): void {
      gesture = { kind: 'none' }
      context.setMarquee(null)
      context.setGuides([])
      context.setHoverTarget(null)
    },
  }
}
