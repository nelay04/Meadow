/**
 * Instanced signed-distance-field renderer for the primitive shapes.
 *
 * One draw call for every rect, ellipse and diamond on screen, regardless of count.
 * ARCHITECTURE 5 calls for "shared geometry + instancing for repeated primitives";
 * this is that, and the benchmark in src/bench is the evidence for choosing it.
 *
 * How it works: a single unit quad is drawn N times with per-instance attributes, and
 * the fragment shader evaluates a signed distance function to decide fill, stroke, or
 * nothing. Because the SDF is evaluated in world units and antialiased with `fwidth`,
 * edges stay exactly one screen pixel soft at every zoom level. A texture-atlas or
 * scaled-geometry approach cannot do that: it distorts stroke width and corner radius
 * with the shape's size.
 *
 * The instance data is one interleaved Float32Array uploaded as a single GPU buffer.
 * Sixteen floats per instance, so 20,000 objects is 1.28 MB.
 */

import { Buffer, BufferUsage, Container, Geometry, Mesh, Rectangle, Shader } from 'pixi.js'

export const SHAPE_RECT = 0
export const SHAPE_ELLIPSE = 1
export const SHAPE_DIAMOND = 2

export type ShapeKind = typeof SHAPE_RECT | typeof SHAPE_ELLIPSE | typeof SHAPE_DIAMOND

/** Floats per instance. Keep in sync with the attribute offsets below. */
const STRIDE = 16

export type ShapeInstance = {
  x: number
  y: number
  w: number
  h: number
  rotation: number
  kind: ShapeKind
  fill: number
  fillAlpha: number
  stroke: number
  strokeAlpha: number
  strokeWidth: number
  radius: number
}

// The version pragma is load-bearing. Pixi decides whether a program is GLSL ES 3.00
// by searching the *fragment* source for this exact line, and without it compiles as
// ES 1.00 - where uniform interface blocks do not exist and `fwidth` is unavailable.
// The failure is a console warning and a shader that silently draws nothing.
const vertex = /* glsl */ `#version 300 es
in vec2 aVertex;
in vec2 aOffset;
in vec2 aSize;
in vec4 aFill;
in vec4 aStroke;
in vec4 aStyle;   // kind, strokeWidth, cornerRadius, rotation

// Pixi supplies these as individual uniforms, not interface blocks - neither its
// global nor its mesh-local UniformGroup sets ubo:true. Declaring them as blocks
// compiles, then crashes the uniform sync, which looks for standalone locations.
//
// Every one of them has to be *used*, too. The GLSL compiler strips an unreferenced
// uniform, Pixi still tries to look up its location, and reads undefined. That is why
// uRound and uResolution drive the pixel snapping below rather than being ignored.
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform vec4 uWorldColorAlpha;
uniform vec2 uResolution;
uniform mat3 uTransformMatrix;
uniform vec4 uColor;
uniform float uRound;

out vec2 vLocal;
out vec2 vHalf;
out vec4 vFill;
out vec4 vStroke;
out vec3 vStyle;  // kind, strokeWidth, cornerRadius
out vec4 vTint;

vec4 roundPixels(vec4 position, vec2 targetSize) {
  return vec4(
    (floor(((position.xy + 1.0) * 0.5 * targetSize) + 0.5) / targetSize * 2.0 - 1.0) * position.w,
    position.zw
  );
}

void main() {
  mat3 model = uWorldTransformMatrix * uTransformMatrix;

  // World-to-screen scale, read back out of the matrix rather than passed as a
  // second uniform that could drift out of step with the camera.
  float zoom = length(model[0].xy);

  vec2 halfSize = aSize * 0.5;

  // Grow the quad past the shape so the stroke and the antialiased edge have room.
  // The 2px margin is a screen-space budget, so it converts to world units by zoom -
  // at 0.1x one screen pixel is ten world units, and a fixed world-space pad would
  // clip the fade.
  float pad = aStyle.y * 0.5 + 2.0 / max(zoom, 0.0001);

  vec2 local = (aVertex * 2.0 - 1.0) * (halfSize + pad);

  float c = cos(aStyle.w);
  float s = sin(aStyle.w);
  vec2 rotated = vec2(local.x * c - local.y * s, local.x * s + local.y * c);

  // aOffset is the top-left corner, matching the CRDT's x/y.
  vec2 world = aOffset + halfSize + rotated;

  vec4 clip = vec4((uProjectionMatrix * model * vec3(world, 1.0)).xy, 0.0, 1.0);

  // Off by default. Snapping vertices to device pixels makes edges crisp but makes
  // shapes jitter during a smooth pan, so it is the caller's choice.
  gl_Position = uRound > 0.5 ? roundPixels(clip, uResolution) : clip;

  vLocal = local;
  vHalf = halfSize;
  vFill = aFill;
  vStroke = aStroke;
  vStyle = aStyle.xyz;
  vTint = uColor * uWorldColorAlpha;
}
`

const fragment = /* glsl */ `#version 300 es
precision highp float;

in vec2 vLocal;
in vec2 vHalf;
in vec4 vFill;
in vec4 vStroke;
in vec3 vStyle;
in vec4 vTint;

out vec4 finalColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  r = min(r, min(b.x, b.y));
  vec2 q = abs(p) - b + r;
  return min(max(q.x, q.y), 0.0) + length(max(q, 0.0)) - r;
}

// Cheap ellipse approximation: distance in a circle-normalised space, rescaled by the
// gradient magnitude. Exact enough for a 1px antialiased edge and far cheaper than
// the closed-form solution.
float sdEllipse(vec2 p, vec2 ab) {
  ab = max(ab, vec2(1e-4));
  float k1 = length(p / ab);
  float k2 = length(p / (ab * ab));
  return (k1 - 1.0) / max(k2, 1e-6);
}

float ndot(vec2 a, vec2 b) { return a.x * b.x - a.y * b.y; }

float sdRhombus(vec2 p, vec2 b) {
  p = abs(p);
  float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

void main() {
  float kind = vStyle.x;
  float strokeWidth = vStyle.y;
  float radius = vStyle.z;

  float d;
  if (kind < 0.5) {
    d = sdRoundBox(vLocal, vHalf, radius);
  } else if (kind < 1.5) {
    d = sdEllipse(vLocal, vHalf);
  } else {
    d = sdRhombus(vLocal, vHalf);
  }

  // Screen-space derivative, so the edge stays one pixel soft at any zoom.
  float aa = max(fwidth(d), 1e-5);

  float fillAlpha = (1.0 - smoothstep(-aa, aa, d)) * vFill.a;
  float halfStroke = strokeWidth * 0.5;
  float strokeAlpha = strokeWidth > 0.0
    ? (1.0 - smoothstep(-aa, aa, abs(d) - halfStroke)) * vStroke.a
    : 0.0;

  vec3 rgb = mix(vFill.rgb, vStroke.rgb, strokeAlpha);
  float alpha = max(fillAlpha, strokeAlpha);

  if (alpha < 0.001) discard;

  // Pixi composites premultiplied, and vTint is already premultiplied, so the
  // container's alpha and tint fold in with a plain multiply.
  finalColor = vec4(rgb * alpha, alpha) * vTint;
}
`

export class ShapeBatch {
  readonly view: Container
  private readonly data: Float32Array
  private readonly buffer: Buffer
  private readonly geometry: Geometry
  private readonly mesh: Container
  private instanceCount = 0
  private minX = Infinity
  private minY = Infinity
  private maxX = -Infinity
  private maxY = -Infinity

  constructor(capacity: number) {
    this.data = new Float32Array(capacity * STRIDE)

    this.buffer = new Buffer({
      data: this.data,
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    })

    const quad = new Buffer({
      data: new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]),
      usage: BufferUsage.VERTEX | BufferUsage.COPY_DST,
    })

    this.geometry = new Geometry({
      attributes: {
        aVertex: { buffer: quad, format: 'float32x2', stride: 8, offset: 0 },
        aOffset: {
          buffer: this.buffer,
          format: 'float32x2',
          stride: STRIDE * 4,
          offset: 0,
          instance: true,
        },
        aSize: {
          buffer: this.buffer,
          format: 'float32x2',
          stride: STRIDE * 4,
          offset: 2 * 4,
          instance: true,
        },
        aFill: {
          buffer: this.buffer,
          format: 'float32x4',
          stride: STRIDE * 4,
          offset: 4 * 4,
          instance: true,
        },
        aStroke: {
          buffer: this.buffer,
          format: 'float32x4',
          stride: STRIDE * 4,
          offset: 8 * 4,
          instance: true,
        },
        aStyle: {
          buffer: this.buffer,
          format: 'float32x4',
          stride: STRIDE * 4,
          offset: 12 * 4,
          instance: true,
        },
      },
      indexBuffer: new Uint32Array([0, 1, 2, 0, 2, 3]),
      instanceCount: 0,
    })

    const shader = Shader.from({ gl: { vertex, fragment } })

    // One cast, and it is a type-level limitation rather than a runtime one. Pixi
    // types Mesh as Mesh<MeshGeometry, TextureShader>, but MeshGeometry has no way to
    // express instanced attributes and this shader samples no texture. At runtime the
    // mesh pipe only needs a Geometry with an index buffer and any Shader.
    const InstancedMesh = Mesh as unknown as new (options: {
      geometry: Geometry
      shader: Shader
    }) => Container

    this.mesh = new InstancedMesh({ geometry: this.geometry, shader })

    this.view = new Container()
    this.view.addChild(this.mesh)
  }

  get count(): number {
    return this.instanceCount
  }

  get capacity(): number {
    return this.data.length / STRIDE
  }

  /** Reset the write cursor. Call once per frame, then `push` the visible objects. */
  begin(): void {
    this.instanceCount = 0
    this.minX = Infinity
    this.minY = Infinity
    this.maxX = -Infinity
    this.maxY = -Infinity
  }

  push(instance: ShapeInstance): void {
    if (this.instanceCount >= this.capacity) return

    this.growBounds(instance)

    const at = this.instanceCount * STRIDE
    const data = this.data

    data[at] = instance.x
    data[at + 1] = instance.y
    data[at + 2] = instance.w
    data[at + 3] = instance.h

    data[at + 4] = ((instance.fill >> 16) & 0xff) / 255
    data[at + 5] = ((instance.fill >> 8) & 0xff) / 255
    data[at + 6] = (instance.fill & 0xff) / 255
    data[at + 7] = instance.fillAlpha

    data[at + 8] = ((instance.stroke >> 16) & 0xff) / 255
    data[at + 9] = ((instance.stroke >> 8) & 0xff) / 255
    data[at + 10] = (instance.stroke & 0xff) / 255
    data[at + 11] = instance.strokeAlpha

    data[at + 12] = instance.kind
    data[at + 13] = instance.strokeWidth
    data[at + 14] = instance.radius
    data[at + 15] = instance.rotation

    this.instanceCount += 1
  }

  private growBounds(instance: ShapeInstance): void {
    const halfW = instance.w / 2
    const halfH = instance.h / 2
    const centerX = instance.x + halfW
    const centerY = instance.y + halfH

    let extentX = halfW
    let extentY = halfH
    if (instance.rotation !== 0) {
      const cos = Math.abs(Math.cos(instance.rotation))
      const sin = Math.abs(Math.sin(instance.rotation))
      extentX = halfW * cos + halfH * sin
      extentY = halfW * sin + halfH * cos
    }
    // The stroke straddles the edge, so half of it sits outside the shape.
    const pad = instance.strokeWidth / 2

    this.minX = Math.min(this.minX, centerX - extentX - pad)
    this.minY = Math.min(this.minY, centerY - extentY - pad)
    this.maxX = Math.max(this.maxX, centerX + extentX + pad)
    this.maxY = Math.max(this.maxY, centerY + extentY + pad)
  }

  /** Upload the instances written since `begin`. */
  end(): void {
    this.geometry.instanceCount = this.instanceCount
    if (this.instanceCount > 0) {
      // Upload only the region actually written, not the whole capacity.
      this.buffer.update(this.instanceCount * STRIDE * 4)
    }

    // Pixi derives a container's bounds from its geometry, and this geometry is a
    // single unit quad regardless of how many instances it draws. Left alone, the
    // batch reports itself as 1x1 at the origin, which silently breaks anything
    // relying on bounds: getBounds, culling, and renderer.extract in particular,
    // which then captures a one-pixel texture and looks like "the shader drew
    // nothing". boundsArea both fixes that and skips Pixi's own bounds walk.
    this.view.boundsArea =
      this.instanceCount === 0
        ? new Rectangle(0, 0, 0, 0)
        : new Rectangle(this.minX, this.minY, this.maxX - this.minX, this.maxY - this.minY)
  }

  /** World-space extent of the instances currently uploaded. */
  get bounds(): Rectangle {
    return this.view.boundsArea
  }

  destroy(): void {
    this.view.destroy({ children: true })
  }
}
