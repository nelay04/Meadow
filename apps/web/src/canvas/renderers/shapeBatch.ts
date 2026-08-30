/**
 * Instanced signed-distance-field renderer for the primitive shapes.
 *
 * One draw call for every rect, ellipse, diamond, parallelogram, triangle, trapezoid,
 * polygon and cylinder on screen, regardless of count.
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
export const SHAPE_PARALLELOGRAM = 3
export const SHAPE_TRIANGLE = 4
export const SHAPE_TRAPEZOID = 5
export const SHAPE_POLYGON = 6
export const SHAPE_CYLINDER = 7

export type ShapeKind =
  | typeof SHAPE_RECT
  | typeof SHAPE_ELLIPSE
  | typeof SHAPE_DIAMOND
  | typeof SHAPE_PARALLELOGRAM
  | typeof SHAPE_TRIANGLE
  | typeof SHAPE_TRAPEZOID
  | typeof SHAPE_POLYGON
  | typeof SHAPE_CYLINDER

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
  /**
   * Corner radius, or the one number the shape's own geometry needs instead.
   *
   * A parallelogram puts its slant here, a trapezoid its top inset, a polygon its side
   * count and a cylinder the half-height of its cap. One slot for all of them rather
   * than a seventeenth float on every instance in the buffer: a rounded corner means
   * nothing on a sheared box, and a shape whose geometry needs a parameter has nowhere
   * else to put it. `canvas/style.ts` decides which meaning it is writing; the shader
   * reads it per branch.
   */
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
in vec4 aStyle;   // kind, strokeWidth, cornerRadius or slant, rotation

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
out vec3 vStyle;  // kind, strokeWidth, cornerRadius or slant
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

// Exact parallelogram, after iq. wi is half the length of the flat top and bottom
// edges, he half the height, and sk how far the top edge is pushed sideways - half
// the shape's full slant, since the top goes one way and the bottom the other.
float sdParallelogram(vec2 p, float wi, float he, float sk) {
  vec2 e = vec2(sk, he);
  p = (p.y < 0.0) ? -p : p;

  // The flat edge.
  vec2 w = p - e;
  w.x -= clamp(w.x, -wi, wi);
  vec2 d = vec2(dot(w, w), -w.y);

  // The slanted edge, in the half-plane the point actually falls in.
  float s = p.x * e.y - p.y * e.x;
  p = (s < 0.0) ? -p : p;
  vec2 v = p - vec2(wi, 0.0);
  v -= e * clamp(dot(v, e) / dot(e, e), -1.0, 1.0);
  d = min(d, vec2(dot(v, v), wi * he - abs(s)));

  return sqrt(d.x) * sign(-d.y);
}

float sdRhombus(vec2 p, vec2 b) {
  p = abs(p);
  float h = clamp(ndot(b - 2.0 * p, b) / dot(b, b), -1.0, 1.0);
  float d = length(p - 0.5 * b * vec2(1.0 - h, 1.0 + h));
  return d * sign(p.x * b.y + p.y * b.x - b.x * b.y);
}

float dot2(vec2 v) { return dot(v, v); }

// Exact isosceles triangle, after iq. q is (half the base width, the height), with
// the apex at the origin and the base at +q.y - so callers pass the point measured
// from the apex. The triangle fills the same box a rect would: apex centred on the
// top edge, base spanning the full width.
float sdTriangle(vec2 p, vec2 q) {
  p.x = abs(p.x);
  vec2 a = p - q * clamp(dot(p, q) / dot2(q), 0.0, 1.0);
  vec2 b = p - q * vec2(clamp(p.x / q.x, 0.0, 1.0), 1.0);
  float s = -sign(q.y);
  vec2 d = min(vec2(dot2(a), s * (p.x * q.y - p.y * q.x)),
               vec2(dot2(b), s * (p.y - q.y)));
  return -sqrt(d.x) * sign(d.y);
}

// Exact trapezoid, after iq. r1 is the half-width at -y and r2 the half-width at +y,
// and he is the half-height. +y is downwards on this canvas, so the narrow edge is r1.
float sdTrapezoid(vec2 p, float r1, float r2, float he) {
  vec2 k1 = vec2(r2, he);
  vec2 k2 = vec2(r2 - r1, 2.0 * he);
  p.x = abs(p.x);
  vec2 ca = vec2(p.x - min(p.x, (p.y < 0.0) ? r1 : r2), abs(p.y) - he);
  vec2 cb = p - k1 + k2 * clamp(dot(k1 - p, k2) / dot2(k2), 0.0, 1.0);
  float s = (cb.x < 0.0 && ca.y < 0.0) ? -1.0 : 1.0;
  return s * sqrt(min(dot2(ca), dot2(cb)));
}

// Regular polygon with sides sides, one vertex at the top.
//
// Evaluated in the box's own normalised space, so the vertices sit on the bounding
// ellipse and a wide box gives a wide polygon rather than a circle floating in it.
// That space is anisotropic, so the distance it returns is not a world distance: the
// fold's own gradient converts it back, which is what keeps the stroke the same
// weight along a long side as along a short one.
float sdPolygon(vec2 p, vec2 b, float sides) {
  b = max(b, vec2(1e-4));
  float n = max(sides, 3.0);
  vec2 q = p / b;

  float an = 6.2831853 / n;
  // The inradius that puts the vertices on the unit circle, and half an edge with it.
  // Measuring from the edge rather than the vertex is what makes the fold below one
  // line, and getting these two the wrong way round draws a polygon around the box
  // instead of inside it.
  float ir = cos(0.5 * an);
  float he = ir * tan(0.5 * an);

  // The direction of the first edge's midpoint, which is half a sector round from the
  // vertex the shape is drawn with at the top. -pi/2 is up, since +y is downwards.
  float base = -1.5707963 + 0.5 * an;
  float bn = an * floor((atan(q.y, q.x) - base) / an + 0.5) + base;
  vec2 cs = vec2(cos(bn), sin(bn));

  // Fold into that one sector: rotating by -bn puts the nearest edge at x = ir.
  vec2 f = vec2(cs.x * q.x + cs.y * q.y, -cs.y * q.x + cs.x * q.y);
  vec2 e = f - vec2(ir, clamp(f.y, -he, he));
  float len = length(e);

  // Unfold the gradient and divide the axes back out. Along the normal the two spaces
  // differ by exactly this factor, which is all the conversion an edge one pixel wide
  // needs.
  vec2 g = len > 1e-6 ? e / len : vec2(1.0, 0.0);
  vec2 gq = vec2(cs.x * g.x - cs.y * g.y, cs.y * g.x + cs.x * g.y);
  float scale = 1.0 / max(length(vec2(gq.x / b.x, gq.y / b.y)), 1e-6);

  return len * sign(f.x - ir) * scale;
}

void main() {
  float kind = vStyle.x;
  float strokeWidth = vStyle.y;
  float radius = vStyle.z;

  float d;
  // An inner line drawn in the stroke colour, for the shapes that have one. Far away
  // unless a branch below moves it, so it costs the others nothing.
  float seam = 1e6;

  if (kind < 0.5) {
    d = sdRoundBox(vLocal, vHalf, radius);
  } else if (kind < 1.5) {
    d = sdEllipse(vLocal, vHalf);
  } else if (kind < 2.5) {
    d = sdRhombus(vLocal, vHalf);
  } else if (kind < 3.5) {
    // radius carries the slant here, not a corner. The y flip is what leans the
    // shape the way a flowchart's does - top edge to the right - since the function
    // above pushes the +y edge and +y is downwards on the canvas.
    float he = max(vHalf.y, 1e-4);
    float skew = radius * 0.5;
    d = sdParallelogram(vec2(vLocal.x, -vLocal.y), max(vHalf.x - skew, 1e-4), he, skew);
  } else if (kind < 4.5) {
    // Measured from the apex, which sits centred on the top edge.
    d = sdTriangle(vec2(vLocal.x, vLocal.y + vHalf.y), vec2(vHalf.x, 2.0 * vHalf.y));
  } else if (kind < 5.5) {
    // radius carries the trapezoid's inset here, same pattern as the parallelogram:
    // how far each side of the narrow top edge steps in from the box.
    float topHalf = max(vHalf.x - radius, 1e-4);
    d = sdTrapezoid(vLocal, topHalf, vHalf.x, vHalf.y);
  } else if (kind < 6.5) {
    // radius carries the side count here.
    d = sdPolygon(vLocal, vHalf, radius);
  } else {
    // A body between two cap ellipses. The caps are exactly as wide as the body, so the
    // three stack rather than overlap and the shape is whichever one the point's own
    // band belongs to. A min of the three would be the union, and unions of signed
    // distance fields stroke their hidden internal edges: the body's flat top would
    // draw a line across the middle of the cap sitting on it. The bands agree at the
    // seam - a cap's own field there is the body's - so the branch has no edge of its
    // own.
    //
    // radius carries the cap's half-height, in world units.
    float cap = clamp(radius, 1e-4, vHalf.y);
    float body = vHalf.y - cap;
    float topArc = sdEllipse(vec2(vLocal.x, vLocal.y + body), vec2(vHalf.x, cap));
    float botArc = sdEllipse(vec2(vLocal.x, vLocal.y - body), vec2(vHalf.x, cap));

    if (vLocal.y < -body) d = topArc;
    else if (vLocal.y > body) d = botArc;
    else d = abs(vLocal.x) - vHalf.x;

    // What actually says "cylinder" is the front of the top cap, which is inside the
    // silhouette rather than on it, so it is stroked separately. Only within the cap's
    // own band, though: the ellipse field is an approximation that reads far too small
    // a long way from a flat ellipse, and left unbounded it paints ghost arcs down the
    // body.
    float front = -body + cap + strokeWidth;
    seam = (vLocal.y > -body && vLocal.y < front) ? topArc : 1e6;
  }

  // Screen-space derivative, so the edge stays one pixel soft at any zoom.
  float aa = max(fwidth(d), 1e-5);

  float fillAlpha = (1.0 - smoothstep(-aa, aa, d)) * vFill.a;
  float halfStroke = strokeWidth * 0.5;
  float edge = min(abs(d), abs(seam));
  float strokeAlpha = strokeWidth > 0.0
    ? (1.0 - smoothstep(-aa, aa, edge - halfStroke)) * vStroke.a
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
