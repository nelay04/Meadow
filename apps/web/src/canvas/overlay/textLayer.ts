/**
 * The DOM overlay. ARCHITECTURE 0 and 5.
 *
 * Rich text cannot be edited inside WebGL, so text objects live in absolutely
 * positioned DOM above the canvas. Both layers are driven by one `ViewTransform`, and
 * this file never reads the camera directly. That is the whole anti-drift strategy: a
 * second copy of the camera, or a second rounding of it, is what puts the text a pixel
 * off its own shape at zoom 1.37.
 *
 * The transform lives on a single root element and nothing below it scales. Child
 * elements are positioned in world units and inherit the scale, so a pan or a zoom
 * writes exactly one style property no matter how many objects are mounted.
 *
 * Only objects in the viewport are mounted, per ARCHITECTURE 5. A board with 500 text
 * objects must not put 500 editable nodes in the document; nodes are pooled and reused
 * as objects scroll in and out.
 */

import {
  type ObjectData,
  type TextProps,
  arrowPolyline,
  cylinderCap,
  isArrowLike,
  parallelogramSlant,
  pointAlongPath,
  polygonSidesOf,
  resolveArrowProps,
  resolveTextProps,
  trapezoidInset,
} from '@meadow/schema'

import type { ViewTransform } from '../camera'
import type { SurfaceType } from '../surface'
import { measureObjectHeight } from '../text/measure'
import {
  type BoxVariant,
  applyBoxStyle,
  applyBylineStyle,
  applyContentStyle,
} from '../text/textStyle'

/**
 * The box an arrow's caption is laid out in, in world units.
 *
 * Not the arrow's own bounds, which is the whole problem: a horizontal arrow has a
 * bounding box one unit tall, so a label positioned like a shape's would be a
 * one-pixel sliver with the text clipped out of it. This is a fixed-size region
 * centred on the middle of the path, with `overflow` visible so a long caption spills
 * rather than truncates.
 */
const ARROW_LABEL_SIZE = { w: 180, h: 44 }

type Box = { x: number; y: number; w: number; h: number }

/**
 * How much of a shape's bounding box its text may use, per axis.
 *
 * A rectangle can use all of it. A diamond and an ellipse cannot, and using the box
 * anyway is why a label that visibly fits still ran out over the slanted edge: the
 * corners of the box are outside the shape. These are the largest centred axis-aligned
 * rectangles that fit inside each - half the box for a diamond, and 1/sqrt(2) of it for
 * an ellipse, both of which fall straight out of the shapes' own equations.
 *
 * Per axis rather than one ratio, because a parallelogram is only pinched on one of
 * them: its top and bottom edges are horizontal, so the full height is available and
 * only the width loses the slant, twice over - once at each end of every line.
 *
 * The cost is that a diamond holds less text than its box suggests, which is true of a
 * real diamond and is the honest answer.
 */
type Fit = { x: number; y: number }

type Inscribe = (w: number, h: number, props?: Record<string, unknown>) => Fit

const INSCRIBED: Partial<Record<ObjectData['type'], Inscribe>> = {
  diamond: () => ({ x: 0.5, y: 0.5 }),
  ellipse: () => ({ x: 0.70710678, y: 0.70710678 }),
  parallelogram: (w, h) => ({ x: w === 0 ? 1 : (w - 2 * parallelogramSlant(w, h)) / w, y: 1 }),
  // The largest centred box in an isosceles triangle sits in its lower half, and a
  // label centred on the shape cannot use it. Half the width across the middle is what
  // is left once the label has to stay centred, which is the same bargain the diamond
  // makes.
  triangle: () => ({ x: 0.5, y: 0.5 }),
  // As wide as the top edge, so a label never runs out over the taper.
  trapezoid: (w, h) => ({ x: w === 0 ? 1 : (w - 2 * trapezoidInset(w, h)) / w, y: 1 }),
  // The apothem, which is the inradius of a regular polygon with a circumradius of 1.
  // A triangle gets half its box and a twelve-sided one almost all of it, which is
  // right: the more sides it has the closer it is to the ellipse it is inscribed in.
  polygon: (_w, _h, props) => {
    const sides = polygonSidesOf(props ?? {})
    const inradius = Math.cos(Math.PI / sides)
    return { x: inradius, y: inradius }
  },
  // Clear of both caps, so a label sits on the body rather than across the curve of
  // the top one. Narrower than the box as well, because the body's sides are where the
  // cap ellipses are widest and a full-width label would touch them.
  cylinder: (_w, h) => ({ x: 0.9, y: h === 0 ? 1 : Math.max((h - 4 * cylinderCap(h)) / h, 0.3) }),
}

function layoutBox(object: ObjectData): Box {
  if (!isArrowLike(object.type)) {
    const fit = INSCRIBED[object.type]?.(object.w, object.h, object.props)
    if (fit === undefined) return { x: object.x, y: object.y, w: object.w, h: object.h }

    // Centred on the shape, so growing the type keeps the label in the middle on both
    // axes rather than pushing it towards one corner.
    const w = object.w * fit.x
    const h = object.h * fit.y
    return {
      x: object.x + (object.w - w) / 2,
      y: object.y + (object.h - h) / 2,
      w,
      h,
    }
  }

  const props = resolveArrowProps(object)
  const middle = pointAlongPath(
    arrowPolyline(props.points, props.routing, props.curvature, props.curvatureEnd),
    0.5,
  )
  return {
    x: object.x + middle.x - ARROW_LABEL_SIZE.w / 2,
    y: object.y + middle.y - ARROW_LABEL_SIZE.h / 2,
    w: ARROW_LABEL_SIZE.w,
    h: ARROW_LABEL_SIZE.h,
  }
}

/**
 * Does this HTML render to nothing?
 *
 * An arrow with no caption must show no plate at all, and an empty fragment still
 * serialises to a block tag. Tag-stripping rather than parsing, because this runs on
 * the render path and only ever sees the overlay's own serialiser's output.
 */
function isBlank(html: string): boolean {
  return html.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim() === ''
}

export type TextLayerCallbacks = {
  /** Static HTML for this object's fragment. */
  html(id: string): string
  /**
   * A measured auto-height, in world units. Reported rather than written, so the
   * engine can batch a frame's worth into one transaction instead of one per object.
   */
  onMeasured(id: string, height: number): void
}

/**
 * Sentinel for "nothing has been rendered into this node yet". The serialiser cannot
 * produce it, because any content at all is wrapped in a block tag.
 *
 * Written as an escape, not as the byte. A literal NUL in the source makes the file
 * binary to everything that reads it as text: git diffs it as "Binary files differ"
 * rather than by line, grep skips it silently, and the pre-commit rules checker never
 * sees a single line of it. Same value, and the file stays reviewable.
 */
const HTML_UNSET = '\u0000unset'

/** What was last written to an element, so an unchanged frame writes nothing. */
type Mounted = {
  box: HTMLDivElement
  content: HTMLDivElement
  /** The signature on a sticky note. Created lazily, because only stickies have one. */
  byline: HTMLDivElement | null
  html: string
  x: number
  y: number
  w: number
  h: number
  rotation: number
  z: number
  styleKey: string
}

/** Anything in here changes layout, so a change means restyle and re-measure. */
function styleKey(props: TextProps, variant: BoxVariant, editing: boolean): string {
  return [
    variant,
    // Editing changes the box's clipping and its pointer handling, so it belongs in
    // the key. Toggling those from `beginEdit` and `endEdit` instead is how the
    // caption's own `overflow: visible` got stomped back to hidden on the way out.
    editing ? 'editing' : 'idle',
    props.fontFamily,
    props.fontSize,
    props.lineHeight,
    props.color,
    props.align,
    props.verticalAlign,
    props.padding,
  ].join('|')
}

export class TextLayer {
  readonly root: HTMLDivElement

  /** The theme's default text colour, set by the engine. See `update`. */
  ink = 0x2a3340

  /**
   * The type every text object on this layer is set in, or null to use each object's
   * own. Set from the surface's writing column; see `SurfaceType`.
   */
  columnType: SurfaceType | null = null

  private readonly mounted = new Map<string, Mounted>()
  private readonly pool: { box: HTMLDivElement; content: HTMLDivElement }[] = []
  /** Ids whose fragment changed since the last sync, so their HTML is stale. */
  private readonly staleHtml = new Set<string>()
  private editingId: string | null = null
  private lastTransform = ''

  constructor(
    container: HTMLElement,
    private readonly callbacks: TextLayerCallbacks,
  ) {
    const root = document.createElement('div')
    root.className = 'meadow-overlay'
    root.style.cssText = [
      'position:absolute',
      'inset:0',
      'transform-origin:0 0',
      // The canvas underneath owns every gesture. Individual elements opt back in
      // only while they are being edited.
      'pointer-events:none',
      // No `will-change: transform` here, and that is deliberate rather than an
      // omission. It promotes this root to its own compositing layer, and Chrome then
      // rasterises the layer once and reuses that bitmap for later transforms. A pan
      // is fine, because a translation of a raster is exact. A zoom is not: the text
      // is GPU-upscaled from whatever scale it happened to be rasterised at, so
      // zooming in made every glyph soft while the WebGL shapes beside it stayed
      // sharp. Without the hint the layer re-rasterises at the new scale and the type
      // is crisp at any zoom. Transforms are composited either way; the hint only
      // bought the right to skip the re-raster that is the entire point here.
      /*
       * This root clips nothing. `.canvas-host` does the clipping, and it is the only
       * element that can do it correctly.
       *
       * The reason is the transform. This element is `inset: 0`, so its box is the
       * host's size, but its children are placed at *world* coordinates inside it and
       * the whole thing is then translated and scaled by the camera. An overflow clip
       * is applied in the element's own coordinate space and carried along by that
       * transform, so clipping here does not mean "clip to the window", it means "clip
       * to a window-sized rectangle of the world that slides about as the camera
       * moves". On a lea that cut the page off at whatever world y happened to equal
       * the host's height in pixels: about rule 21 on a 650px window. The row on that
       * rule was sliced through the middle of its first line and every row below it
       * vanished, which reads as writing that will not appear and a page that will not
       * take a caret. A glade had the same fault the moment you panned far enough.
       *
       * `hidden` was worse than wrong in a second way: it also made this a scroll
       * container, and a scroll container gets scrolled by things that are not
       * scrollbars. Focusing an editor mounted below the fold had the browser scroll
       * this root to reveal it, which is what dragged that world-space clip window
       * down far enough to hide the fault most of the time. Nothing else moved with
       * it, so the writing then sat a page-length off the rule it was typed on.
       *
       * `visible` has neither failure: no scrollport for anything to scroll, and no
       * clip in a coordinate space that has nothing to do with the viewport. What is
       * on screen is decided by the cull, which mounts only what the camera can see,
       * and what is painted is bounded by the host, which clips in screen space.
       */
      'overflow:visible',
    ].join(';')
    container.appendChild(root)
    this.root = root
  }

  /**
   * The world-space box a mounted label's *type* actually occupies.
   *
   * The engine asks so the arrow pass can cut its shaft around a caption. Measured
   * from the content element rather than from the layout box, because the layout box
   * is a generous guess and the gap has to be the size of the words. `offsetWidth` is
   * already in world units: the overlay root carries the camera scale and nothing
   * below it scales again.
   *
   * Null when the object is not mounted or has nothing in it, which the caller reads
   * as "no gap" rather than as an error.
   */
  labelBounds(id: string): { minX: number; minY: number; maxX: number; maxY: number } | null {
    const entry = this.mounted.get(id)
    if (entry === undefined) return null

    const width = entry.content.offsetWidth
    const height = entry.content.offsetHeight
    if (width <= 0 || height <= 0) return null
    if (entry.box.style.display === 'none') return null

    // The content is centred in the box on both axes for a label, which is the only
    // kind of object this is asked about.
    const centreX = entry.x + entry.w / 2
    const centreY = entry.y + entry.h / 2
    const padX = width / 2 + 5
    const padY = height / 2 + 2
    return {
      minX: centreX - padX,
      minY: centreY - padY,
      maxX: centreX + padX,
      maxY: centreY + padY,
    }
  }

  /** Mark objects whose text changed. Called from the engine's Y observer path. */
  invalidate(ids: Iterable<string>): void {
    for (const id of ids) this.staleHtml.add(id)
  }

  invalidateAll(): void {
    for (const id of this.mounted.keys()) this.staleHtml.add(id)
  }

  get editing(): string | null {
    return this.editingId
  }

  /**
   * Give an editor somewhere to mount.
   *
   * A throwaway child, not the content element itself. ProseMirror treats the node it
   * is handed as its own and removes it on destroy, which would take the pooled
   * content element with it and leave the object rendering blank for the rest of the
   * session. A sacrificial wrapper costs one div and makes the teardown other
   * people's code performs irrelevant to ours.
   *
   * Returns null when the object is not currently mounted, which happens when it is
   * outside the viewport. The caller treats that as "cannot edit yet" rather than
   * mounting an editor into a detached node.
   */
  beginEdit(id: string): HTMLElement | null {
    const entry = this.mounted.get(id)
    if (entry === undefined) return null

    this.editingId = id
    // The style is not touched here. `update` owns every property on this element and
    // its key carries the editing flag, so the next sync applies the editing variant.
    // Poking at three properties from here and three more from `endEdit` is how a
    // caption's `overflow: visible` came back as `hidden` and clipped what was typed.
    this.staleHtml.add(id)

    const mount = document.createElement('div')
    mount.style.width = '100%'
    entry.content.replaceChildren(mount)
    return mount
  }

  endEdit(): void {
    const id = this.editingId
    this.editingId = null
    if (id === null) return

    const entry = this.mounted.get(id)
    if (entry !== undefined) {
      // Style is `update`'s, as in `beginEdit`. Forcing it back from here is what put
      // `overflow: hidden` on an arrow caption, which then clipped anything longer
      // than the label box's guess at how wide a caption might be.
      entry.styleKey = ''

      // Swap the editor's subtree for static HTML here rather than leaving it to the
      // next sync. The editor is already gone by this point, so waiting for a frame
      // would blank the object for up to 16ms and read as the text being lost.
      entry.html = this.callbacks.html(id)
      entry.content.innerHTML = entry.html
    }
    this.staleHtml.add(id)
  }

  /**
   * Position and update the overlay for one frame.
   *
   * `visible` is already culled and in ascending z-order; the engine has that list
   * anyway from its own render walk, and building it twice would double the cost of
   * the one loop that is O(objects on screen).
   */
  sync(transform: ViewTransform, visible: readonly { object: ObjectData; z: number }[]): void {
    const next = `translate(${transform.tx}px,${transform.ty}px) scale(${transform.scale})`
    if (next !== this.lastTransform) {
      this.lastTransform = next
      this.root.style.transform = next
    }

    const present = new Set<string>()
    for (const entry of visible) {
      present.add(entry.object.id)
      this.update(entry.object, entry.z)
    }

    for (const [id, entry] of this.mounted) {
      // Never unmount the object being edited. Scrolling it just off screen mid-word
      // would destroy the editor and drop the caret.
      if (present.has(id) || id === this.editingId) continue
      this.recycle(id, entry)
    }

    this.staleHtml.clear()
  }

  private update(object: ObjectData, z: number): void {
    const props = resolveTextProps(object)
    /*
     * Text that never chose a colour follows the theme.
     *
     * The schema's default is a dark ink, which is right on paper and unreadable on a
     * dark board: a caption sitting straight on the surface came out barely darker
     * than the surface itself. Same rule as connectors in the engine, and the same
     * limit: this is only ever a *default*. An object whose document carries an
     * explicit colour keeps it in both themes.
     *
     * `resolveTextProps` returns a fresh object per call, so this mutates rather than
     * spreading. It runs once per visible text object per frame. Colour is not a
     * layout input, so nothing here can change a measured height.
     */
    if (typeof object.props.color !== 'number') props.color = this.ink

    /*
     * On a ruled surface the page sets the type, not the object.
     *
     * Unlike the colour above, this overrides what the document says rather than
     * filling in what it left out. A row stores the metrics it was created with so a
     * client that has never heard of this kind still renders it sensibly, but here the
     * rules are drawn from the column and the writing has to land on them. Whichever
     * of the two is allowed to win, the other has to follow it, and it cannot be the
     * copy frozen into a row somebody typed a year ago.
     */
    if (this.columnType !== null) Object.assign(props, this.columnType)

    // `styleKey` includes the colour, so a theme change restyles what is mounted
    // instead of leaving the old ink on screen until an object happens to move.
    const editing = object.id === this.editingId
    const variant: BoxVariant = isArrowLike(object.type) ? 'arrow-label' : 'box'
    const arrowLabel = variant === 'arrow-label'
    const key = styleKey(props, variant, editing)

    let entry = this.mounted.get(object.id)
    if (entry === undefined) {
      const node = this.pool.pop() ?? this.createNode()
      entry = {
        box: node.box,
        content: node.content,
        byline: null,
        html: HTML_UNSET,
        // Values no real geometry can equal, so the first pass writes everything.
        x: Number.NaN,
        y: Number.NaN,
        w: Number.NaN,
        h: Number.NaN,
        rotation: Number.NaN,
        z: Number.NaN,
        styleKey: '',
      }
      this.mounted.set(object.id, entry)
      entry.box.dataset.objectId = object.id
      this.root.appendChild(entry.box)
    }

    if (entry.styleKey !== key) {
      entry.styleKey = key
      applyBoxStyle(entry.box, props, variant, editing)
      applyContentStyle(entry.content, props, variant)
    }

    // While an editor is mounted ProseMirror owns the content subtree, and writing
    // innerHTML underneath it would blow away the caret on the next keystroke. The
    // HTML is still read in that case, because auto-height has to keep tracking what
    // is being typed.
    const stale = editing || entry.html === HTML_UNSET || this.staleHtml.has(object.id)
    const html = stale ? this.callbacks.html(object.id) : entry.html
    if (editing) {
      entry.html = html
    } else if (html !== entry.html) {
      entry.html = html
      entry.content.innerHTML = html
    }

    const box = layoutBox(object)
    if (entry.x !== box.x) {
      entry.x = box.x
      entry.box.style.left = `${box.x}px`
    }
    if (entry.y !== box.y) {
      entry.y = box.y
      entry.box.style.top = `${box.y}px`
    }
    if (entry.w !== box.w) {
      entry.w = box.w
      entry.box.style.width = `${box.w}px`
    }
    if (entry.h !== box.h) {
      entry.h = box.h
      entry.box.style.height = `${box.h}px`
    }

    // An uncaptioned arrow shows nothing at all. The label is only there to hold
    // words, and an empty box still breaks the line behind it.
    if (arrowLabel) {
      const shown = editing || !isBlank(html) ? 'flex' : 'none'
      if (entry.box.style.display !== shown) entry.box.style.display = shown
    }

    this.syncByline(entry, object, props)
    // An arrow's `rotation` is always zero - its direction lives in its points - so
    // this is a shape-only concern, but reading it uniformly keeps one code path.
    if (entry.rotation !== object.rotation) {
      entry.rotation = object.rotation
      // Only a rotated object gets a nested transform, and it rotates about the same
      // centre the WebGL batch uses.
      entry.box.style.transform = object.rotation === 0 ? '' : `rotate(${object.rotation}rad)`
      entry.box.style.transformOrigin = '50% 50%'
    }
    if (entry.z !== z) {
      entry.z = z
      entry.box.style.zIndex = String(z)
    }

    if (props.autoHeight) {
      // Measured against the layout box, which is the object's own for every type that
      // grows to fit. The inscribed types do not - a shape's size is the author's.
      const measured = measureObjectHeight(html, box.w, props)
      // A whole world pixel of slack. Without it a fractional measurement that never
      // exactly equals the stored height writes a patch on every single frame.
      if (Math.abs(measured - object.h) > 1) this.callbacks.onMeasured(object.id, measured)
    }
  }

  /**
   * The author's name in the corner of a sticky note.
   *
   * Driven off `props.author`, which the text tool stamps at creation. A note with no
   * author - one made before this existed, or by a client that did not know its own
   * name - simply has no byline rather than an empty one.
   */
  private syncByline(entry: Mounted, object: ObjectData, props: TextProps): void {
    const author = object.type === 'sticky' ? object.props.author : undefined
    const name = typeof author === 'string' ? author.trim() : ''

    if (name === '') {
      if (entry.byline !== null) {
        entry.byline.remove()
        entry.byline = null
      }
      return
    }

    if (entry.byline === null) {
      entry.byline = document.createElement('div')
      entry.box.appendChild(entry.byline)
    }
    // Written unconditionally rather than diffed: a name changes never, and the two
    // comparisons would cost more than the assignment they are guarding.
    applyBylineStyle(entry.byline, props)
    if (entry.byline.textContent !== name) entry.byline.textContent = name
  }

  private createNode(): { box: HTMLDivElement; content: HTMLDivElement } {
    const box = document.createElement('div')
    const content = document.createElement('div')
    box.appendChild(content)
    return { box, content }
  }

  private recycle(id: string, entry: Mounted): void {
    this.mounted.delete(id)
    // The byline is a child of the box, so it has to go before the box is pooled or
    // the next object to reuse the node inherits somebody else's signature.
    entry.byline?.remove()
    entry.byline = null
    entry.box.remove()
    entry.box.removeAttribute('data-object-id')
    entry.box.removeAttribute('style')
    // The content element's inline styles go too. `applyContentStyle` runs again on
    // reuse and overwrites what it sets, but the arrow-label plate sets properties it
    // does not, and a pooled node would carry them onto the next object.
    entry.content.removeAttribute('style')
    entry.content.replaceChildren()
    // A pool this size covers a screenful with headroom. Past that the nodes are
    // cheaper to drop than to keep alive.
    if (this.pool.length < 64) this.pool.push({ box: entry.box, content: entry.content })
  }

  destroy(): void {
    this.mounted.clear()
    this.pool.length = 0
    this.root.remove()
  }
}
