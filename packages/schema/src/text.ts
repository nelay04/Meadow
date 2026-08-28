/**
 * Text-bearing objects. ARCHITECTURE 4 and 5.
 *
 * A text object is not a document. It is an object at (x, y) whose content happens to
 * be a `Y.XmlFragment`, and it goes through the same selection, transform, z-order and
 * undo machinery as a rectangle. The only thing that makes it special is that it is
 * drawn by the DOM overlay rather than the WebGL batch, because a caret, a selection,
 * an IME and a screen reader cannot exist inside a texture.
 *
 * Everything here is layout input, which means it is also *measurement* input. Two
 * clients that disagree on the font size or the line height will measure different
 * heights for the same text and write different bounds into the CRDT, so these
 * defaults have to be shared rather than picked in the renderer.
 */

import { z } from 'zod'

import type { ObjectData, ObjectType } from './objects'

/**
 * The three faces from ARCHITECTURE 1, referred to by slug rather than by CSS family
 * name so the document does not encode a font stack it cannot guarantee.
 */
export const FONT_FAMILIES = ['inter', 'comic', 'mono'] as const
export type FontFamily = (typeof FONT_FAMILIES)[number]

export const TEXT_ALIGNMENTS = ['left', 'center', 'right'] as const
export type TextAlign = (typeof TEXT_ALIGNMENTS)[number]

export const VERTICAL_ALIGNMENTS = ['top', 'middle', 'bottom'] as const
export type VerticalAlign = (typeof VERTICAL_ALIGNMENTS)[number]

export const textProps = z.object({
  /*
   * Comic Neue by default, the same face the chrome uses. A whiteboard that writes
   * its UI in one voice and its content in another reads as two products stitched
   * together. `inter` and `mono` stay available: the slug is what the document
   * stores, so an object that asks for a face keeps it.
   */
  fontFamily: z.enum(FONT_FAMILIES).default('comic'),
  fontSize: z.number().min(6).max(288).default(16),
  lineHeight: z.number().min(0.8).max(3).default(1.45),
  /*
   * The gap between blocks, in ems, on top of the line height.
   *
   * A paragraph wants air after it, and 0.4em is what makes a note readable rather
   * than a wall. Zero is the case that needs it to be a property at all: on a ruled
   * surface every line has to land on a rule, and a gap between paragraphs walks the
   * writing off them a little further with each one.
   */
  paragraphSpacing: z.number().min(0).max(2).default(0.4),
  color: z.number().int().default(0x2a3340),
  align: z.enum(TEXT_ALIGNMENTS).default('left'),
  verticalAlign: z.enum(VERTICAL_ALIGNMENTS).default('top'),
  /** Inset from the object's box, in world units. */
  padding: z.number().min(0).max(200).default(8),
  /**
   * Grow `h` to fit the content. A plain text object does; a sticky is a fixed square
   * that shrinks its type instead, the way a real sticky note behaves.
   */
  autoHeight: z.boolean().default(true),
})

export type TextProps = z.infer<typeof textProps>

/** A caption centred inside a shape's own box. */
const SHAPE_LABEL: Partial<TextProps> = {
  align: 'center',
  verticalAlign: 'middle',
  padding: 10,
  autoHeight: false,
}

/** A caption riding on a connector, drawn over a plate so the line does not cross it. */
const ARROW_LABEL: Partial<TextProps> = {
  fontSize: 14,
  align: 'center',
  verticalAlign: 'middle',
  padding: 3,
  autoHeight: false,
}

/** Defaults that differ per type. Everything not listed falls back to the schema. */
const TYPE_DEFAULTS: Partial<Record<ObjectType, Partial<TextProps>>> = {
  /*
   * A sticky is written like an actual sticky note: from the top-left, filling
   * downwards. Centring it on both axes was borrowed from a shape's label and it is
   * the wrong model - a caption in a box is a title, but a note is a note, and text
   * that re-centres itself as you add a second line is unusable for writing more than
   * three words. The bottom inset leaves room for the byline the overlay draws there.
   */
  sticky: {
    fontSize: 16,
    align: 'left',
    verticalAlign: 'top',
    padding: 14,
    autoHeight: false,
  },
  // A label inside a shape is centred on both axes, and the shape does not grow to
  // fit it. Growing is right for a standalone caption, whose height is its content;
  // it is wrong for a box in a diagram, whose size the author chose.
  rect: SHAPE_LABEL,
  ellipse: SHAPE_LABEL,
  diamond: SHAPE_LABEL,
  // A caption on a connector. Smaller than a shape's, because it sits on top of the
  // board rather than inside a box, and `autoHeight` off for a much harder reason
  // than style: an arrow's `h` is its bounding box, and letting the overlay write a
  // measured text height into it would overwrite the arrow's own geometry.
  arrow: ARROW_LABEL,
  line: ARROW_LABEL,
}

/**
 * Read text style off an object without running the validator.
 *
 * Called once per visible text object per frame, and zod's `parse` allocates. The
 * schema stays the source of truth for what is valid; this is the read path.
 */
export function resolveTextProps(object: ObjectData): TextProps {
  const base = textProps.parse(TYPE_DEFAULTS[object.type] ?? {})
  const props = object.props

  const pick = <K extends keyof TextProps>(key: K, guard: (value: unknown) => boolean): void => {
    const value = props[key]
    if (guard(value)) base[key] = value as TextProps[K]
  }

  const isFinite = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value)
  const oneOf =
    (allowed: readonly string[]) =>
    (value: unknown): boolean =>
      typeof value === 'string' && allowed.includes(value)

  pick('fontFamily', oneOf(FONT_FAMILIES))
  pick('fontSize', isFinite)
  pick('lineHeight', isFinite)
  pick('paragraphSpacing', isFinite)
  pick('color', isFinite)
  pick('align', oneOf(TEXT_ALIGNMENTS))
  pick('verticalAlign', oneOf(VERTICAL_ALIGNMENTS))
  pick('padding', isFinite)
  pick('autoHeight', (value) => typeof value === 'boolean')

  return base
}

/** Starting geometry for a click-created object, before any text has been typed. */
export const TEXT_DEFAULT_SIZE = { w: 220, h: 32 }
/** 3:3.25, portrait. A square note is a coaster; a page-shaped one is a note. */
export const STICKY_DEFAULT_SIZE = { w: 180, h: 195 }

/**
 * A text object never collapses to nothing. An empty one still has to be clickable and
 * still has to show a caret, so its height floors at one line plus padding.
 */
export function minimumTextHeight(props: TextProps): number {
  return Math.ceil(props.fontSize * props.lineHeight + props.padding * 2)
}
