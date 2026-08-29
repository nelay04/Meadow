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

/*
 * Status and dismissal, for toasts and the confirmation dialog.
 *
 * Each status glyph is distinguishable by shape alone at 16px, not only by colour.
 * A tick, a triangle and a disc read differently in a monochrome screenshot and to
 * anyone who cannot separate the green from the red, which is the whole reason a
 * toast carries an icon rather than just a coloured edge.
 */

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
