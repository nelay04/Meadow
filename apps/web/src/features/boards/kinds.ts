/**
 * The kinds of glade, as one list.
 *
 * "Glade" stays the word for a board, whatever kind it is. It is not being renamed and
 * it is not one of the options against the other: a lea is a kind of glade, the way a
 * ruled notebook is a kind of book. The default kind is simply called a glade because
 * that is what it has always been.
 *
 * This file is the extension point. A new kind is an entry here plus a value in
 * `app/services/board_kinds.py` and its check constraint: the sidebar's filters, the
 * create picker, the card badges and the board's own paper are all read off this
 * array, so none of them has to be edited to add one.
 *
 * What a kind is *not*: a different editor. ARCHITECTURE 1 has no page and no document
 * mode, and a kind never gets one. It picks the surface the same infinite canvas is
 * drawn on, and the same tools write the same objects into the same document on all
 * of them. A lea is a diary because it looks and feels like a diary to write in, not
 * because it is secretly a stack of pages.
 */

import type { BoardKind } from '../../lib/api'
import type { CanvasSurface } from '../../canvas/surface'
import type { WritingColumn } from '../../canvas/engine'
import type { ToolId } from '../../canvas/tools/types'
import { IconCanvas, IconDiary } from '../../ui/icons'

export type BoardKindSpec = {
  id: BoardKind
  /** Singular, for a badge or a button. Sentence case, because it is a common noun. */
  label: string
  /** Plural, for the sidebar filter and the view heading. */
  plural: string
  /** One line, shown under the label in the create picker. */
  blurb: string
  /** What the composer's field says before anything is typed. */
  placeholder: string
  Icon: typeof IconCanvas
  surface: CanvasSurface
  /**
   * What the card in the board list shows.
   *
   * `thumbnail` renders the captured preview, which is what you want when a board is a
   * drawing: a diagram is recognisable at card size and is the fastest way to find the
   * one you meant. `icon` shows the kind's mark instead, for surfaces whose preview
   * carries nothing - a page of body text at that scale is a grey smudge, and every
   * page's smudge is the same smudge.
   */
  preview: 'thumbnail' | 'icon'
  /**
   * Which tools the rail offers, in the rail's own order.
   *
   * A filter over the one list of tools, never a second list: every tool still exists
   * and still writes the same objects into the same document, so a shape drawn on a
   * lea by a client that offers shapes still renders here. This decides what is worth
   * putting in front of you, and on a diary that is a pen and nothing else. Select and
   * pan are on every kind, because they are how you get around rather than things you
   * make.
   */
  tools: readonly ToolId[]
  /**
   * The writing column, or null for a free canvas.
   *
   * Set, and four things follow: the camera is fenced to that column and to zoom 1,
   * the page scrolls down forever and no further up than its first line, the paper is
   * ruled at exactly one line of this type, and opening the board puts the caret on
   * the first line instead of asking you to place a text box. That is what "a diary"
   * means as behaviour rather than as a texture.
   */
  column: WritingColumn | null
}

/**
 * A page you write down.
 *
 * The type metrics are here rather than left to the text object's defaults because
 * the ruling has to match them exactly: the rule spacing *is* `fontSize * lineHeight`,
 * and the first rule sits at `padding`. Two numbers that have to agree belong in one
 * place, or the writing slowly walks off the lines down the page.
 */
export const BOARD_KINDS: readonly BoardKindSpec[] = [
  {
    id: 'glade',
    label: 'Glade',
    plural: 'Glades',
    blurb: 'A clearing with no edges. Think out loud, and let it sprawl.',
    placeholder: 'Name a new glade, then press Enter',
    Icon: IconCanvas,
    surface: 'graph',
    preview: 'thumbnail',
    tools: [
      'select',
      'hand',
      'text',
      'sticky',
      'arrow',
      'line',
      'pen',
      'rect',
      'ellipse',
      'diamond',
      'parallelogram',
      'triangle',
      'trapezoid',
      'polygon',
      'cylinder',
    ],
    column: null,
  },
  {
    id: 'lea',
    label: 'Lea',
    plural: 'Leas',
    blurb: 'Kraft paper, ruled and waiting. Open it and start writing.',
    placeholder: 'Name a new lea, then press Enter',
    Icon: IconDiary,
    surface: 'ruled',
    // A lea's preview would be a page of 16px text shrunk to a card, which is a grey
    // smudge, and every lea's smudge looks the same. The kind's own mark says more.
    preview: 'icon',
    // Getting around, and nothing else. No shapes and no arrows: a diary is a place to
    // put sentences on ruled lines, and a rail of drawing tools over it is an
    // invitation to make it into something else. Not even the text tool, which places
    // a box you then type into - on a ruled page you click a rule and write on it, so
    // a button for placing text boxes is a second way to do the same thing that puts
    // the writing somewhere the rules are not.
    tools: ['select', 'hand'],
    /*
     * A measure, not a page size: 760 world units at zoom 1 is a line you can read
     * without losing your place, and a window wider than that gets margins rather
     * than a longer line.
     *
     * The size and the leading move together on purpose. Rule pitch is
     * `fontSize * lineHeight`, so 21/1.45 rules the page at the same 30.4 units that
     * 19/1.6 and 16/1.75 did, with larger letters standing in the band. Growing the
     * type without shrinking the leading would push the lines apart instead, which is
     * not what "bigger writing" means on ruled paper.
     */
    column: { width: 760, fontSize: 21, lineHeight: 1.45 },
  },
]

export const DEFAULT_BOARD_KIND: BoardKind = 'glade'

const BY_ID = new Map(BOARD_KINDS.map((kind) => [kind.id, kind]))
const FALLBACK = BOARD_KINDS[0]

/**
 * The spec for a kind, falling back to the default.
 *
 * The fallback is the point rather than defensiveness: a client that has not been
 * redeployed will meet kinds it has never heard of the first time a new one ships,
 * and a glade it cannot name should still open and still be editable.
 */
export function boardKind(id: string | undefined): BoardKindSpec {
  return BY_ID.get(id as BoardKind) ?? FALLBACK
}

/**
 * Where a board of this kind lives in the address bar.
 *
 * The kind is in the path because the URL is the one part of the app a person reads
 * and sends to somebody else, and `#/glade/...` for a diary is simply wrong. It is not
 * load-bearing: the board view resolves the kind from the server and corrects the hash
 * if it disagrees, so an old or hand-edited link still opens the right board.
 */
export function boardPath(kind: string, boardId: string): string {
  return `#/${boardKind(kind).id}/${boardId}`
}

/** Every path segment that names a board, including the two historical spellings. */
export const BOARD_PATH_SEGMENTS: readonly string[] = [
  ...BOARD_KINDS.map((kind) => kind.id),
  // `glade` was the only board route before kinds existed, and `field` before that.
  // Both stay readable so a tab or a link left open still resolves.
  'field',
]
