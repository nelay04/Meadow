/**
 * Counts WebGL draw calls per frame.
 *
 * Frame timings depend on the GPU, the driver, and whether the browser fell back to
 * software rendering. Draw-call count does not: it is a property of how the scene is
 * structured, which is the thing ARCHITECTURE 5 warns about. A strategy issuing one
 * draw call per object is wrong on every machine, and no amount of faster hardware
 * changes the conclusion.
 *
 * Patch before Pixi creates its context, since it grabs the methods off the instance.
 */

type DrawingContext = WebGL2RenderingContext | WebGLRenderingContext

const METHODS = [
  'drawElements',
  'drawArrays',
  'drawElementsInstanced',
  'drawArraysInstanced',
] as const

let drawCalls = 0
let patched = false

export function installDrawCallCounter(): void {
  if (patched) return
  patched = true

  const prototypes: object[] = [WebGLRenderingContext.prototype]
  if (typeof WebGL2RenderingContext !== 'undefined') {
    prototypes.push(WebGL2RenderingContext.prototype)
  }

  for (const prototype of prototypes) {
    for (const method of METHODS) {
      const original = (prototype as unknown as Record<string, unknown>)[method]
      if (typeof original !== 'function') continue
      ;(prototype as unknown as Record<string, unknown>)[method] = function (
        this: DrawingContext,
        ...args: unknown[]
      ) {
        drawCalls += 1
        return (original as (...a: unknown[]) => unknown).apply(this, args)
      }
    }
  }
}

export function resetDrawCalls(): void {
  drawCalls = 0
}

export function readDrawCalls(): number {
  return drawCalls
}
