/**
 * Where an arrow end attaches, and where it sits while you are still dragging it.
 *
 * Both halves of this used to be wrong in the same way and it is worth writing down.
 * A drop had to land strictly inside the shape, so aiming at the outline - which is
 * where anybody aims when they mean "connect to this" - attached about half the time.
 * And the end followed the pointer for the whole drag, so the only feedback that a
 * connection had been made arrived after the gesture was over.
 */

import type { ObjectData } from '@meadow/schema'
import { describe, expect, it } from 'vitest'

import { Camera } from '../camera'
import type { ToolContext } from './types'
import { BIND_GAP, bindTarget, previewBind } from './binding'

function object(overrides: Partial<ObjectData> = {}): ObjectData {
  return {
    id: 'box',
    type: 'rect',
    x: 0,
    y: 0,
    w: 100,
    h: 100,
    rotation: 0,
    opacity: 1,
    locked: false,
    parentId: null,
    createdBy: '',
    props: {},
    ...overrides,
  }
}

/** Only the four members these two functions actually read. */
function context(objects: ObjectData[]): ToolContext {
  const camera = new Camera()
  const byId = new Map(objects.map((item) => [item.id, item]))
  return {
    camera,
    order: () => objects.map((item) => item.id),
    object: (id: string) => byId.get(id),
    query: () => objects.map((item) => item.id),
  } as unknown as ToolContext
}

describe('bindTarget', () => {
  const scene = context([object()])

  it('attaches from inside the shape', () => {
    expect(bindTarget(scene, { x: 50, y: 50 }, null)).toBe('box')
  })

  it('attaches on the outline', () => {
    expect(bindTarget(scene, { x: 100, y: 50 }, null)).toBe('box')
  })

  it('attaches just outside the outline, which is where an endpoint is aimed', () => {
    expect(bindTarget(scene, { x: 108, y: 50 }, null)).toBe('box')
  })

  it('leaves an endpoint dropped well clear of the shape free', () => {
    expect(bindTarget(scene, { x: 200, y: 50 }, null)).toBeNull()
  })

  it('never attaches to another arrow', () => {
    const arrows = context([object({ id: 'arrow', type: 'arrow', props: { points: [0, 0, 100, 0] } })])
    expect(bindTarget(arrows, { x: 50, y: 0 }, null)).toBeNull()
  })

  it('never attaches to a locked shape', () => {
    expect(bindTarget(context([object({ locked: true })]), { x: 50, y: 50 }, null)).toBeNull()
  })
})

describe('previewBind', () => {
  const scene = context([object()])

  it('pulls the end onto the outline while the drag is still running', () => {
    // Dropped near the middle, so the anchor is the centre and the end stops where the
    // ray from the centre towards the far end leaves the shape.
    const preview = previewBind(scene, { x: 50, y: 50 }, null, { x: 300, y: 50 })
    expect(preview.targetId).toBe('box')
    expect(preview.point.x).toBeCloseTo(100 + BIND_GAP)
    expect(preview.point.y).toBeCloseTo(50)
  })

  it('pins an end dropped near an edge to that spot', () => {
    const preview = previewBind(scene, { x: 100, y: 20 }, null, { x: 300, y: 20 })
    expect(preview.targetId).toBe('box')
    expect(preview.point.x).toBeGreaterThan(100)
    expect(preview.point.y).toBeLessThan(50)
  })

  it('leaves the point under the pointer when there is nothing to attach to', () => {
    const preview = previewBind(scene, { x: 300, y: 300 }, null, { x: 0, y: 0 })
    expect(preview.targetId).toBeNull()
    expect(preview.point).toEqual({ x: 300, y: 300 })
  })
})
