/**
 * Strategy C: one instanced draw call for every primitive, via ShapeBatch.
 *
 * A thin wrapper so the benchmark measures the renderer that would actually ship,
 * not a simplified stand-in for it.
 */

import { Container } from 'pixi.js'

import {
  SHAPE_DIAMOND,
  SHAPE_ELLIPSE,
  SHAPE_RECT,
  ShapeBatch,
  type ShapeKind,
} from '../../canvas/renderers/shapeBatch'
import type { BenchObject } from '../scene'
import type { Strategy } from './types'

const KINDS: Record<BenchObject['shape'], ShapeKind> = {
  rect: SHAPE_RECT,
  ellipse: SHAPE_ELLIPSE,
  diamond: SHAPE_DIAMOND,
}

export function instanced(): Strategy {
  const world = new Container()
  let batch: ShapeBatch | null = null

  return {
    name: 'instanced-sdf',
    note: 'one instanced draw call, signed distance fields in the fragment shader',

    build(objects: BenchObject[]): Container {
      batch = new ShapeBatch(objects.length)
      batch.begin()
      for (const object of objects) {
        batch.push({
          x: object.x,
          y: object.y,
          w: object.w,
          h: object.h,
          rotation: object.rotation,
          kind: KINDS[object.shape],
          fill: object.fill,
          fillAlpha: 1,
          stroke: object.stroke,
          strokeAlpha: 1,
          strokeWidth: object.strokeWidth,
          radius: object.radius,
        })
      }
      batch.end()
      world.addChild(batch.view)
      return world
    },

    setCamera(x: number, y: number, zoom: number): void {
      world.position.set(-x * zoom, -y * zoom)
      world.scale.set(zoom)
    },

    destroy(): void {
      batch?.destroy()
      batch = null
      world.destroy({ children: true })
    },
  }
}
