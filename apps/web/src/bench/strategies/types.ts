import type { Container } from 'pixi.js'

import type { BenchObject } from '../scene'

export type Strategy = {
  readonly name: string
  readonly note: string
  build(objects: BenchObject[]): Container
  setCamera(x: number, y: number, zoom: number): void
  destroy(): void
}
