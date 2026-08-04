/** Pan the camera. Also what space-drag temporarily switches to. */

import type { CanvasPointerEvent, Tool, ToolContext } from './types'

export function createHandTool(context: ToolContext): Tool {
  let panning = false
  let lastScreenX = 0
  let lastScreenY = 0

  return {
    id: 'hand',
    cursor: 'grab',

    onPointerDown(event: CanvasPointerEvent): void {
      panning = true
      lastScreenX = event.screen.x
      lastScreenY = event.screen.y
      context.setCursor('grabbing')
    },

    onPointerMove(event: CanvasPointerEvent): void {
      if (!panning) return
      context.camera.panByScreen(event.screen.x - lastScreenX, event.screen.y - lastScreenY)
      lastScreenX = event.screen.x
      lastScreenY = event.screen.y
      context.requestRender()
    },

    onPointerUp(): void {
      panning = false
      context.setCursor('grab')
    },

    cancel(): void {
      panning = false
    },
  }
}
