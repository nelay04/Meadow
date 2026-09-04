/**
 * The icon set.
 *
 * Inline SVG rather than an icon font or a package: there are twenty of them, they
 * are all one stroked path, and shipping a dependency to draw a triangle is how a
 * bundle gets to a megabyte. Every icon inherits `currentColor` and sizes from a
 * single `size` prop, so a button's colour states drive its icon for free.
 *
 * All drawn on a 24 unit grid with the same stroke weight and round caps. That
 * consistency is most of what makes a set look designed rather than collected.
 */

import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconCursor(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.5 18.5 11.2a.6.6 0 0 1-.13 1.1l-5.2 1.5-2.4 5a.6.6 0 0 1-1.1-.1z" />
    </Svg>
  )
}

export function IconHand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9 11V5.6a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M11.8 10.6V4.4a1.4 1.4 0 0 1 2.8 0V11" />
      <path d="M14.6 11V6.4a1.4 1.4 0 0 1 2.8 0V15a5.5 5.5 0 0 1-5.5 5.5h-.9a5 5 0 0 1-3.8-1.8L4 14.6a1.4 1.4 0 0 1 2-1.9L9 15" />
    </Svg>
  )
}

export function IconText(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6.5V5h14v1.5" />
      <path d="M12 5v14" />
      <path d="M9 19h6" />
    </Svg>
  )
}

export function IconSticky(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 6.5A1.5 1.5 0 0 1 6.5 5h11A1.5 1.5 0 0 1 19 6.5V14l-5 5H6.5A1.5 1.5 0 0 1 5 17.5z" />
      <path d="M19 14h-3.5a1.5 1.5 0 0 0-1.5 1.5V19" />
    </Svg>
  )
}

export function IconArrow(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 19.5 19 5" />
      <path d="M12.5 5H19v6.5" />
    </Svg>
  )
}

export function IconLine(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 19.5 19.5 4.5" />
    </Svg>
  )
}

export function IconSquare(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.5" y="4.5" width="15" height="15" rx="2.5" />
    </Svg>
  )
}

export function IconCircle(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="7.5" />
    </Svg>
  )
}

export function IconDiamond(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.6 20.4 12 12 20.4 3.6 12z" />
    </Svg>
  )
}

export function IconParallelogram(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.6 5.5H20l-4.6 13H4z" />
    </Svg>
  )
}

export function IconTriangle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4 21 20H3z" />
    </Svg>
  )
}

export function IconTrapezoid(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.5 5.5h9L20 18.5H4z" />
    </Svg>
  )
}

/**
 * A hexagon, standing for the polygon family the way the circle stands for the
 * ellipse. Which face count is in your hand is said by a number, not a different icon.
 */
export function IconPolygon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3 20.2 7.5V16.5L12 21 3.8 16.5V7.5z" />
    </Svg>
  )
}

export function IconCylinder(props: IconProps) {
  return (
    <Svg {...props}>
      <ellipse cx="12" cy="7" rx="7.5" ry="3" />
      <path d="M4.5 7v10c0 1.66 3.36 3 7.5 3s7.5-1.34 7.5-3V7" />
    </Svg>
  )
}

/**
 * The shape family, as one mark.
 *
 * Two shapes overlapping rather than three side by side: at 19px a row of three is a
 * grey smear, and what this button has to say is "shapes live in here", not which
 * ones. Which one is in your hand is said by the button wearing that shape's own icon
 * while it is armed.
 */
export function IconShapes(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9.2" cy="9.2" r="4.7" />
      <rect x="10.5" y="10.5" width="9" height="9" rx="1.8" />
    </Svg>
  )
}

export function IconTrash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 6.5h15" />
      <path d="M9.5 6.5V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v1.5" />
      <path d="M6.5 6.5 7.4 19a1.5 1.5 0 0 0 1.5 1.4h6.2a1.5 1.5 0 0 0 1.5-1.4l.9-12.5" />
      <path d="M10.5 10v6.5M13.5 10v6.5" />
    </Svg>
  )
}

/** Two sheets, one behind the other: the copy and what it was copied from. */
export function IconDuplicate(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v8A1.5 1.5 0 0 0 5.5 15" />
    </Svg>
  )
}

export function IconBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M19 12H5" />
      <path d="M11 6 5 12l6 6" />
    </Svg>
  )
}

export function IconPlus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  )
}

export function IconMinus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
    </Svg>
  )
}

export function IconLogout(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14.5 4.5h3A1.5 1.5 0 0 1 19 6v12a1.5 1.5 0 0 1-1.5 1.5h-3" />
      <path d="M11 8.5 14.5 12 11 15.5" />
      <path d="M14.5 12H5" />
    </Svg>
  )
}

export function IconFit(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 9V5.8a1.3 1.3 0 0 1 1.3-1.3H9" />
      <path d="M15 4.5h3.2a1.3 1.3 0 0 1 1.3 1.3V9" />
      <path d="M19.5 15v3.2a1.3 1.3 0 0 1-1.3 1.3H15" />
      <path d="M9 19.5H5.8a1.3 1.3 0 0 1-1.3-1.3V15" />
    </Svg>
  )
}

export function IconSun(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
    </Svg>
  )
}

export function IconMoon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 14.2A8.2 8.2 0 0 1 9.8 4a8.4 8.4 0 1 0 10.2 10.2z" />
    </Svg>
  )
}

export function IconAuto(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5" width="18" height="12" rx="1.8" />
      <path d="M9 20h6" />
      <path d="M12 17v3" />
    </Svg>
  )
}

export function IconSearch(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.8" cy="10.8" r="6.3" />
      <path d="m15.4 15.4 4.1 4.1" />
    </Svg>
  )
}

export function IconGrid(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="7" height="7" rx="1.6" />
      <rect x="13" y="4" width="7" height="7" rx="1.6" />
      <rect x="4" y="13" width="7" height="7" rx="1.6" />
      <rect x="13" y="13" width="7" height="7" rx="1.6" />
    </Svg>
  )
}

export function IconClock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 1.8" />
    </Svg>
  )
}

export function IconCalendar(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 9.5h17M8 3.5v3M16 3.5v3" />
    </Svg>
  )
}

export function IconUser(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="8.5" r="3.8" />
      <path d="M4.8 19.5a7.2 7.2 0 0 1 14.4 0" />
    </Svg>
  )
}

export function IconShared(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="9" cy="8.5" r="3.4" />
      <path d="M3.2 19.5a5.8 5.8 0 0 1 11.6 0" />
      <path d="M16 5.6a3.4 3.4 0 0 1 0 5.8" />
      <path d="M17.6 14.4a5.8 5.8 0 0 1 3.2 5.1" />
    </Svg>
  )
}

export function IconLock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.8" y="10.5" width="14.4" height="9" rx="2.2" />
      <path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.6 0v2.7" />
      <path d="M12 14v2.2" />
    </Svg>
  )
}

export function IconUnlock(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4.8" y="10.5" width="14.4" height="9" rx="2.2" />
      <path d="M8.2 10.5V7.8a3.8 3.8 0 0 1 7.2-1.7" />
      <path d="M12 14v2.2" />
    </Svg>
  )
}

export function IconGridLines(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <path d="M9.3 4v16M14.7 4v16M4 9.3h16M4 14.7h16" />
    </Svg>
  )
}

export function IconGridDots(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
      {/* Filled, not stroked: at this radius a ring reads as a smudge, and the point
          of the icon is that the rules are gone and only their crossings are left. */}
      <circle cx="9.3" cy="9.3" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="9.3" r="1" fill="currentColor" stroke="none" />
      <circle cx="9.3" cy="14.7" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.7" cy="14.7" r="1" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/** The paper with nothing printed on it. The frame alone, so the row reads as one of
    the three papers rather than as an absence. */
export function IconGridNone(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="16" height="16" rx="2" />
    </Svg>
  )
}

/** Stand-in for a board with no preview yet. */
export function IconCanvas(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.5" y="5" width="17" height="14" rx="2" />
      <circle cx="8.5" cy="10" r="1.6" />
      <path d="M3.5 16.5 8 12.5l3.5 3 3-2.5 6 5" />
    </Svg>
  )
}

/**
 * A lea: a spiral diary seen face on.
 *
 * The rings are the whole icon. A plain rectangle with two lines in it is a document,
 * and at 17px the only mark that says "notebook" rather than "file" is the binding,
 * so the spiral gets three coils and the ruling gets two rules and no more.
 */
export function IconDiary(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.5 4.5h11a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5h-11z" />
      <path d="M7.5 4.5A2.5 2.5 0 0 0 5 7v10a2.5 2.5 0 0 0 2.5 2.5" />
      <path d="M4 7.5h4M4 12h4M4 16.5h4" />
      <path d="M11 9.5h6M11 13.5h6" />
    </Svg>
  )
}

/**
 * The paper a lea is printed on: two sheets, the top one turned back.
 *
 * A stack rather than a single sheet, because a single sheet is the document icon
 * every toolbar already has. What this picks is which stock, so the mark is one sheet
 * lying over another.
 */
export function IconPaper(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8.5 3.5h7.4L20 7.6V17a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 7 17V5a1.5 1.5 0 0 1 1.5-1.5z" />
      <path d="M15.6 3.6V7.4h3.9" />
      <path d="M4 7.5v12A1.5 1.5 0 0 0 5.5 21h9" />
    </Svg>
  )
}

/**
 * The page list, drawn as the thing the button does rather than the thing it lists.
 *
 * A panel down the right of the view, with the rules of what is in it. A stack of
 * sheets would be the more literal mark and would be a second icon that looks like
 * `IconPaper` at 17px, which is the size that matters.
 */
export function IconPanel(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="M14 4.5v15" />
      <path d="M16.5 9.5h3M16.5 13h3" />
    </Svg>
  )
}

/*
 * The three arrow routings, drawn as the path each one produces between the same two
 * points. A picker for connector shapes has to show the shape, not name it: "straight,
 * curved, elbow" is three words for something the eye reads instantly.
 */

export function IconRouteStraight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19 17.5 5.5" />
      <path d="M12 5h6v6" />
    </Svg>
  )
}

export function IconRouteCurved(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19C4 10 9 5.5 17.5 5.5" />
      <path d="M12 4.5h6v6" />
    </Svg>
  )
}

export function IconRouteElbow(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 19h9.5V5.5h4" />
      <path d="M14 2.8 18.2 5.5 14 8.2" />
    </Svg>
  )
}

/*
 * Text formatting. Drawn as the letterform each one produces rather than as an
 * abstract glyph, which is the one place in this set where imitating the result beats
 * a consistent stroke: a bold B says bold in a way no icon does.
 */

export function IconBold(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2}>
      <path d="M7 5h6a3.5 3.5 0 0 1 0 7H7z" />
      <path d="M7 12h7a3.5 3.5 0 0 1 0 7H7z" />
    </Svg>
  )
}

export function IconItalic(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15 5h-5M14 19H9M13.5 5 10.5 19" />
    </Svg>
  )
}

export function IconUnderline(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7 4v6.5a5 5 0 0 0 10 0V4" />
      <path d="M5.5 20h13" />
    </Svg>
  )
}

export function IconStrike(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 12h14" />
      <path d="M15.5 7.2A4 4 0 0 0 12 5.5C9.6 5.5 8 6.8 8 8.6c0 1.5 1.1 2.4 3 3" />
      <path d="M8.5 16.8a4 4 0 0 0 3.5 1.7c2.4 0 4-1.3 4-3.1 0-.9-.4-1.6-1.1-2.1" />
    </Svg>
  )
}

/** Viewers, in the presence list. */
export function IconEye(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.6 12S6 6.5 12 6.5 21.4 12 21.4 12 18 17.5 12 17.5 2.6 12 2.6 12z" />
      <circle cx="12" cy="12" r="2.7" />
    </Svg>
  )
}

/** Editors, in the presence list. */
export function IconPencil(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M15.6 4.6a1.9 1.9 0 0 1 2.7 0l1.1 1.1a1.9 1.9 0 0 1 0 2.7L8.6 19.2 4 20l.8-4.6z" />
      <path d="M14.2 6 18 9.8" />
    </Svg>
  )
}

/**
 * Owners, in the presence list.
 *
 * Filled rather than stroked, unlike the rest of the set: it is drawn at nine pixels
 * perched on the rim of an avatar, and at that size a 1.75 stroke on a five-point
 * outline closes up into a blob. The one place the house style loses to legibility.
 */
export function IconCrown(props: IconProps) {
  return (
    <Svg {...props} fill="currentColor" stroke="none">
      <path d="M3 8.2 7.2 11 12 4.6 16.8 11 21 8.2l-1.7 9.4a1 1 0 0 1-1 .8H5.7a1 1 0 0 1-1-.8z" />
    </Svg>
  )
}

/*
 * The pen, and the nibs it can be fitted with.
 *
 * The tip icons are not five drawings of a pen. Each one is the *mark* that nib
 * leaves, because that is the thing being chosen: a row of five near-identical pen
 * silhouettes is a row you have to read the tooltips of, and a row of five different
 * strokes can be read at a glance and without language.
 */

export function IconPen(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 20.2 4.9 16 15.9 5a2.1 2.1 0 0 1 3 0l.1.1a2.1 2.1 0 0 1 0 3l-11 11z" />
      <path d="M14.4 6.5 17.5 9.6" />
      <path d="M4.9 16 8 19.1" />
    </Svg>
  )
}

/** A ballpoint: an even line with a little swell in the middle. */
export function IconNibRound(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2.6}>
      <path d="M4 17.5c3.4-4 5.6-9 8-11 2.6-2.2 6 1.4 8 5" />
    </Svg>
  )
}

/** A fineliner: the same line, thinner, and the same the whole way. */
export function IconNibFelt(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={1.5}>
      <path d="M4 17.5c3.4-4 5.6-9 8-11 2.6-2.2 6 1.4 8 5" />
    </Svg>
  )
}

/** A chisel: a filled ribbon, broad across the nib and hairline along it. */
export function IconNibChisel(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={1.1}>
      <path
        d="M4.6 18.2 8.4 5.4l2.6-.6-3.2 13z"
        fill="currentColor"
      />
      <path
        d="M13.2 18.6 17 5.8l2.6-.6-3.2 13z"
        fill="currentColor"
      />
    </Svg>
  )
}

/** A brush: a stroke that comes to a point at both ends. */
export function IconNibBrush(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={1.1}>
      <path
        d="M3.6 17.8c4-1.6 6.6-6.4 9.4-9.6 2.4-2.8 5.6-3.6 7.4-2.6-1.8.6-3.6 2.2-5.6 4.6-3 3.6-5.6 8-11 9.2z"
        fill="currentColor"
      />
    </Svg>
  )
}

/** A highlighter: a broad translucent band laid over a line of writing. */
export function IconNibHighlighter(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 13.5h17" stroke="currentColor" strokeWidth={6} strokeOpacity={0.32} />
      <path d="M6 13.5h12" strokeWidth={1.5} />
    </Svg>
  )
}

/*
 * Status and dismissal, for toasts and the confirmation dialog.
 *
 * Each status glyph is distinguishable by shape alone at 16px, not only by colour.
 * A tick, a triangle and a disc read differently in a monochrome screenshot and to
 * anyone who cannot separate the green from the red, which is the whole reason a
 * toast carries an icon rather than just a coloured edge.
 */

/*
 * The three degrees of pen assist.
 *
 * They are read against each other rather than on their own, so they say their piece
 * with one difference each. Freehand is the wobble as drawn. Tidy is that wobble made
 * into the shape it was, still an outline in your own ink. Shapes is the same shape
 * again with the board's own fill, which is exactly what the two modes differ by. The
 * spark says a correction happened, and it is the same spark in both that correct.
 */

export function IconAssistNone(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 16.4c1.7.5 2-3.5 3.7-3.5 1.5 0 1.2 3.7 2.8 3.7 1.8 0 1.5-5.3 3.2-5.3 1.4 0 1.3 3.5 2.8 3.5 1.3 0 1.7-2.2 4.3-6.3" />
    </Svg>
  )
}

export function IconAssistTidy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.4" y="8.6" width="12" height="12" rx="1.8" />
      <path d="M18.6 2.6v4.2M16.5 4.7h4.2" />
    </Svg>
  )
}

export function IconAssistShapes(props: IconProps) {
  return (
    <Svg {...props}>
      {/* The same box, filled. A shape from the rail carries the surface's own fill,
          and that is the whole difference between this mode and tidying. */}
      <rect x="3.4" y="8.6" width="12" height="12" rx="1.8" fill="currentColor" fillOpacity={0.28} />
      <path d="M18.6 2.6v4.2M16.5 4.7h4.2" />
    </Svg>
  )
}

export function IconCheck(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2.25}>
      <path d="M5 12.5 10 17.5 19 7" />
    </Svg>
  )
}

export function IconAlert(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4.6 21 19.4H3z" />
      <path d="M12 10v4" />
      <path d="M12 16.8v.1" />
    </Svg>
  )
}

export function IconInfo(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.2" />
      <path d="M12 11v5.4" />
      <path d="M12 7.8v.1" />
    </Svg>
  )
}

export function IconClose(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
    </Svg>
  )
}

/** Opens the workspace sidebar when it is a drawer rather than a column. */
/** A menu opens below this. Small, and only ever beside a word that says what. */
export function IconChevronDown(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9.5 12 15.5 18 9.5" />
    </Svg>
  )
}

/** The same chevron turned, for a panel that closes towards the edge it sits on. */
export function IconChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 6 15.5 12 9.5 18" />
    </Svg>
  )
}

export function IconMenu(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15M4.5 12h15M4.5 17h15" />
    </Svg>
  )
}

/**
 * The GitHub mark. The one icon in this file that is not on the 24 unit stroke grid:
 * it is a brand mark with a fixed shape, and redrawing it as a stroked path would
 * make it something else. Filled with `currentColor` so it still follows the button.
 */
export function IconShare(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 15V4" />
      <path d="m8.5 7.5 3.5-3.5 3.5 3.5" />
      <path d="M5.5 12.5V18a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-5.5" />
    </Svg>
  )
}

export function IconLink(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M10.5 13.5a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1.4 1.4" />
      <path d="M13.5 10.5a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1.4-1.4" />
    </Svg>
  )
}

export function IconGlobe(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8" />
      <path d="M4 12h16" />
      <path d="M12 4c2.2 2.2 3.3 5 3.3 8s-1.1 5.8-3.3 8c-2.2-2.2-3.3-5-3.3-8s1.1-5.8 3.3-8Z" />
    </Svg>
  )
}

export function IconCopy(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M15 6.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h.5" />
    </Svg>
  )
}

export function IconMail(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.8 7 7.1 5.3a2 2 0 0 0 2.2 0L20.2 7" />
    </Svg>
  )
}

export function IconRotate(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </Svg>
  )
}

/**
 * The overflow button on the board bar.
 *
 * Three dots and not a hamburger. A hamburger says "the navigation is behind here",
 * which is a claim about the whole screen; three dots say "there is more of *this*
 * row", which is exactly what is true - the four controls that stayed out are still
 * out, and this is the rest of them.
 */
export function IconMore(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="5.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="12" cy="18.5" r="1.4" fill="currentColor" stroke="none" />
    </Svg>
  )
}

/*
 * The social marks, below, break this file's own rule about one stroked path on a 24
 * grid: they are filled brand glyphs at their own proportions, because a brand mark
 * redrawn in somebody else's stroke weight stops being recognisable, and recognisable
 * at 16px is the entire reason to show one. Same exception `IconGitHub` and
 * `IconGoogle` already take.
 */

function Brand({ size = 18, children, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  )
}

export function IconWhatsApp(props: IconProps) {
  return (
    <Brand {...props}>
      <path d="M12 2.2a9.7 9.7 0 0 0-8.3 14.7L2.2 21.8l5-1.3A9.7 9.7 0 1 0 12 2.2Zm0 1.8a7.9 7.9 0 0 1 6.6 12.2 7.9 7.9 0 0 1-9.9 2.8l-.4-.2-3 .8.8-2.9-.2-.4A7.9 7.9 0 0 1 12 4Zm-3.4 4c-.2 0-.5.1-.7.4-.3.3-.9.9-.9 2.1s.9 2.4 1 2.6c.1.2 1.8 2.9 4.5 4 2.2.9 2.7.7 3.2.7.5 0 1.6-.6 1.8-1.3.2-.6.2-1.2.2-1.3-.1-.1-.3-.2-.6-.3l-2-1c-.3-.1-.5-.1-.6.1l-.9 1.1c-.2.2-.3.2-.6.1a6.5 6.5 0 0 1-3.2-2.8c-.2-.4 0-.5.2-.7l.4-.5c.1-.2.2-.3.3-.5 0-.2 0-.4-.1-.5l-.8-2c-.2-.5-.4-.4-.6-.4Z" />
    </Brand>
  )
}

export function IconX(props: IconProps) {
  return (
    <Brand {...props}>
      <path d="M17.2 3h3.3l-7.2 8.3 8.5 9.7h-6.6l-5.2-6-6 6H.7l7.7-8.9L.2 3h6.8l4.7 5.5Zm-1.2 15.9h1.8L7.9 4.8H6Z" />
    </Brand>
  )
}

export function IconFacebook(props: IconProps) {
  return (
    <Brand {...props}>
      <path d="M22 12a10 10 0 1 0-11.6 9.9v-7H7.9V12h2.5V9.8c0-2.5 1.5-3.9 3.7-3.9 1.1 0 2.2.2 2.2.2v2.4h-1.2c-1.2 0-1.6.8-1.6 1.6V12h2.7l-.4 2.9h-2.3v7A10 10 0 0 0 22 12Z" />
    </Brand>
  )
}

export function IconLinkedIn(props: IconProps) {
  return (
    <Brand {...props}>
      <path d="M20.4 2H3.6A1.6 1.6 0 0 0 2 3.6v16.8A1.6 1.6 0 0 0 3.6 22h16.8a1.6 1.6 0 0 0 1.6-1.6V3.6A1.6 1.6 0 0 0 20.4 2ZM8.1 19H5.2V9.7h2.9Zm-1.5-10.6a1.7 1.7 0 1 1 0-3.4 1.7 1.7 0 0 1 0 3.4ZM19 19h-2.9v-4.5c0-1.1 0-2.5-1.5-2.5s-1.8 1.2-1.8 2.4V19H9.9V9.7h2.8V11h.1a3 3 0 0 1 2.7-1.5c2.9 0 3.5 1.9 3.5 4.4Z" />
    </Brand>
  )
}

export function IconTelegram(props: IconProps) {
  return (
    <Brand {...props}>
      <path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm4.6 6.9-1.5 7.3c-.1.5-.4.6-.9.4l-2.4-1.8-1.2 1.1c-.1.1-.2.3-.5.3l.2-2.5 4.5-4.1c.2-.2 0-.3-.3-.1l-5.5 3.5-2.4-.7c-.5-.2-.5-.5.1-.8l9.3-3.6c.4-.2.8.1.6.8Z" />
    </Brand>
  )
}

export function IconGitHub({ size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
    </svg>
  )
}

/**
 * Google's mark, in its four brand colours.
 *
 * Hard-coded rather than `currentColor`, unlike every other icon here: Google's brand
 * terms require the mark to be used as issued, and a monochrome or recoloured G is not
 * it. It reads on both themes because the white centre is left transparent.
 */
export function IconGoogle({ size = 18, ...rest }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      <path
        fill="#4285F4"
        d="M45.12 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11c4.16-3.83 6.56-9.47 6.56-16.17z"
      />
      <path
        fill="#34A853"
        d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
      />
      <path
        fill="#FBBC05"
        d="M11.69 28.18c-.44-1.32-.69-2.73-.69-4.18s.25-2.86.69-4.18v-5.7H4.34A21.99 21.99 0 0 0 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
      />
      <path
        fill="#EA4335"
        d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
      />
    </svg>
  )
}

/**
 * The stack, drawn as three sheets seen at an angle.
 *
 * Depth is what the panel behind this button is about, so the mark has to show
 * something in front of something else. Three offset diamonds do that at 16px, where a
 * numbered list or a pair of overlapping rectangles both read as "document".
 */
export function IconStack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m12 3 8.5 4.5L12 12 3.5 7.5z" />
      <path d="m4.5 12 7.5 4 7.5-4" />
      <path d="m4.5 16.5 7.5 4 7.5-4" />
    </Svg>
  )
}

/*
 * The four z-order moves.
 *
 * An arrow and, on the two absolute moves, the wall it travels to. That is the whole
 * difference between them, and it has to be the whole difference: "forward" and "to the
 * front" are the same direction, so anything else the marks disagreed about would be
 * noise arguing with the one thing they are meant to say.
 *
 * Deliberately not a picture of stacked cards. Two or three overlapping rectangles plus
 * an arrow is four shapes inside sixteen pixels, and at that size it reads as a smudge
 * with a tick on it. The panel is titled Stack and every button carries its own words on
 * hover, so the icons only have to carry direction and distance.
 */
export function IconToFront(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 3.5h15" />
      <path d="M12 20.5V7.5" />
      <path d="m7.5 12 4.5-4.5 4.5 4.5" />
    </Svg>
  )
}

export function IconForward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 20V5.5" />
      <path d="m7 10.5 5-5 5 5" />
    </Svg>
  )
}

export function IconBackward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 4v14.5" />
      <path d="m7 13.5 5 5 5-5" />
    </Svg>
  )
}

export function IconToBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 20.5h15" />
      <path d="M12 3.5v13" />
      <path d="m7.5 12 4.5 4.5 4.5-4.5" />
    </Svg>
  )
}

/**
 * The grip on a row that can be dragged.
 *
 * Six dots, which is the one mark for "pick this up and move it" that everybody has
 * already learnt. Drawn as dots rather than as the usual pair of rules because the
 * rules are indistinguishable from the stack panel's own dividers at row height.
 */
export function IconGrip(props: IconProps) {
  return (
    <Svg {...props} strokeWidth={2.4}>
      <path d="M9.5 6.5h.01M9.5 12h.01M9.5 17.5h.01M14.5 6.5h.01M14.5 12h.01M14.5 17.5h.01" />
    </Svg>
  )
}

/** A freehand stroke, for the row a `freedraw` object gets in the stack list. */
export function IconInk(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3.5 16.5c3-6 5-8 6.5-6s-1.5 8 .5 8.5 4.5-4.5 6-8 3-4 4-3.5" />
    </Svg>
  )
}
