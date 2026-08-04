/**
 * Strategy B: one shared GraphicsContext per style bucket.
 *
 * PixiJS 8 lets many Graphics share a GraphicsContext, which is the cheap version of
 * "shared geometry for repeated primitives" from ARCHITECTURE 5. Each instance is a
 * unit shape scaled to size.
 *
 * The visual caveat, and the reason this is a probe rather than a candidate: scaling
 * a unit shape scales its stroke and its corner radius with it, so a 400px-wide rect
 * gets a 4x thicker border than a 100px one. Correcting that means a context per
 * distinct size, which is the same as no sharing at all. Measured anyway, because
 * "would have been fast enough" is worth knowing before reaching for a shader.
 */

import { Container, Graphics, GraphicsContext } from 'pixi.js'

import type { BenchObject } from '../scene'
import type { Strategy } from './types'

const UNIT = 100

export function sharedContext(): Strategy {
  const world = new Container()
  const contexts = new Map<string, GraphicsContext>()

  const contextFor = (object: BenchObject): GraphicsContext => {
    const rounded = object.radius > 0 ? 1 : 0
    const key = `${object.shape}|${object.fill}|${object.strokeWidth}|${rounded}`

    let context = contexts.get(key)
    if (context !== undefined) return context

    context = new GraphicsContext()
    if (object.shape === 'rect') {
      if (rounded) context.roundRect(0, 0, UNIT, UNIT, 8)
      else context.rect(0, 0, UNIT, UNIT)
    } else if (object.shape === 'ellipse') {
      context.ellipse(UNIT / 2, UNIT / 2, UNIT / 2, UNIT / 2)
    } else {
      context.poly([UNIT / 2, 0, UNIT, UNIT / 2, UNIT / 2, UNIT, 0, UNIT / 2])
    }
    context.fill(object.fill)
    context.stroke({ width: object.strokeWidth, color: object.stroke })

    contexts.set(key, context)
    return context
  }

  return {
    name: 'shared-context',
    note: 'shared GraphicsContext per style bucket, scaled per instance',

    build(objects: BenchObject[]): Container {
      for (const object of objects) {
        const graphic = new Graphics(contextFor(object))
        graphic.position.set(object.x, object.y)
        graphic.scale.set(object.w / UNIT, object.h / UNIT)
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
      for (const context of contexts.values()) context.destroy()
      contexts.clear()
    },
  }
}

