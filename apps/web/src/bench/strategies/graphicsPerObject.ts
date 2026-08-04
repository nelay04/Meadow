/**
 * Strategy A: one Graphics per object.
 *
 * The obvious structure, and the one ARCHITECTURE 5 predicts will fail. Included as
 * the control: without a measured baseline there is no evidence that the complexity
 * of anything else is justified.
 */

import { Container, Graphics } from 'pixi.js'

import type { BenchObject } from '../scene'
import type { Strategy } from './types'

export function graphicsPerObject(): Strategy {
  const world = new Container()

  return {
    name: 'graphics-per-object',
    note: 'one Graphics per object (the naive structure)',

    build(objects: BenchObject[]): Container {
      for (const object of objects) {
        const graphic = new Graphics()

        if (object.shape === 'rect') {
          if (object.radius > 0) graphic.roundRect(0, 0, object.w, object.h, object.radius)
          else graphic.rect(0, 0, object.w, object.h)
        } else if (object.shape === 'ellipse') {
          graphic.ellipse(object.w / 2, object.h / 2, object.w / 2, object.h / 2)
        } else {
          graphic.poly([
            object.w / 2,
            0,
            object.w,
            object.h / 2,
            object.w / 2,
            object.h,
            0,
            object.h / 2,
          ])
        }

        graphic.fill(object.fill)
        graphic.stroke({ width: object.strokeWidth, color: object.stroke })

        graphic.position.set(object.x, object.y)
        graphic.rotation = object.rotation
        world.addChild(graphic)
      }
      return world
    },

    setCamera(x: number, y: number, zoom: number): void {
      world.position.set(-x * zoom, -y * zoom)
      world.scale.set(zoom)
    },

    destroy(): void {
      world.destroy({ children: true })
    },
  }
}
