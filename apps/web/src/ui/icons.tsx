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
