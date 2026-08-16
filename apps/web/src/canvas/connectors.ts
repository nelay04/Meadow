/**
 * Connector handles: the dots on a shape's edges that you drag to draw an arrow.
 *
 * The alternative, which this app had until now, is "pick the arrow tool, then drag
 * between two shapes". That is one more mode switch than the gesture deserves, and it
 * is why the arrows felt like something you fought rather than something you drew.
 * FigJam and Figma both put the affordance on the shape itself, so connecting two
 * boxes costs one drag from the object you are already pointing at.
 *
 * The dots sit slightly *outside* the outline rather than on it. On it, they collide
 * with the resize handles at the same edge midpoints, and the two gestures are
 * different enough that a shared hit target would be a coin toss.
 *
 * Everything here is geometry. Which shape is showing handles, and what a drag from
 * one does, belongs to the select tool.
 */

import type { Point, WorldRect } from './camera'

export const CONNECTOR_SIDES = ['n', 'e', 's', 'w'] as const
export type ConnectorSide = (typeof CONNECTOR_SIDES)[number]

/** Screen-space, converted by the caller, so they sit the same distance out at any zoom. */
export const CONNECTOR_OFFSET_PX = 10
export const CONNECTOR_RADIUS_PX = 4
/** Deliberately larger than the dot. A 4px target is a target you miss. */
export const CONNECTOR_GRAB_PX = 11

/** Where each dot sits, given the shape's box and an outward offset in world units. */
export function connectorPoints(rect: WorldRect, offset: number): Record<ConnectorSide, Point> {
  const midX = (rect.minX + rect.maxX) / 2
  const midY = (rect.minY + rect.maxY) / 2

  return {
    n: { x: midX, y: rect.minY - offset },
    e: { x: rect.maxX + offset, y: midY },
    s: { x: midX, y: rect.maxY + offset },
    w: { x: rect.minX - offset, y: midY },
  }
}

/** The dot under a point, or null. */
export function connectorAt(
  rect: WorldRect,
  point: Point,
  offset: number,
  grab: number,
): ConnectorSide | null {
  const points = connectorPoints(rect, offset)
  for (const side of CONNECTOR_SIDES) {
    const dot = points[side]
    if (Math.abs(point.x - dot.x) <= grab && Math.abs(point.y - dot.y) <= grab) return side
  }
  return null
}

/**
 * The normalised anchor a side binds to.
 *
 * An edge midpoint rather than the centre, so an arrow pulled from the top of a box
 * leaves from the top and stays there when the box moves. `anchorFor`, which the arrow
 * tool uses, infers this from where you dropped; here the user said it by choosing a
 * dot, and inferring it again would sometimes disagree with them.
 */
export function anchorForSide(side: ConnectorSide): { nx: number; ny: number } {
  switch (side) {
    case 'n':
      return { nx: 0.5, ny: 0 }
    case 'e':
      return { nx: 1, ny: 0.5 }
    case 's':
      return { nx: 0.5, ny: 1 }
    case 'w':
      return { nx: 0, ny: 0.5 }
  }
}

/** The point on the outline itself, where the arrow should actually start. */
export function edgePointForSide(rect: WorldRect, side: ConnectorSide): Point {
  const anchor = anchorForSide(side)
  return {
    x: rect.minX + (rect.maxX - rect.minX) * anchor.nx,
    y: rect.minY + (rect.maxY - rect.minY) * anchor.ny,
  }
}
