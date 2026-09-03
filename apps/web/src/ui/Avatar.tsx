import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * A person's face: their picture when there is one, their initials when there is not.
 *
 * One component rather than the three copies of `initials()` this replaces, because
 * the picture half has a failure mode the initials half does not. An avatar is a remote
 * URL on someone else's CDN: it can 404 after an account is renamed, and it can be
 * blocked. `onError` falls back to the initials instead of leaving the broken image
 * glyph, which is the whole reason this is a component and not a template.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

/**
 * The pixel width to ask a CDN for.
 *
 * Both providers serve whatever size you ask for and default to a small one - Google
 * hands out `=s96-c`, GitHub `?v=4` at 460 but scaled by the browser from the source -
 * and a 96px image in the 72px portrait on the profile page is 96 pixels covering 144
 * device pixels on any retina screen. That is the blur. 256 is enough for the largest
 * place a face is drawn at 2x, and small enough to stay a cheap request.
 */
const CDN_PX = 256

/**
 * Ask a known avatar CDN for a size that survives a high-density screen.
 *
 * Anything unrecognised is returned untouched: rewriting a URL we do not understand
 * is how a working picture turns into a 404.
 */
export function sharpUrl(url: string): string {
  try {
    const parsed = new URL(url, window.location.origin)

    // Google encodes the size in the path, as `=s96-c` on the last segment, and
    // ignores it as a query parameter.
    if (parsed.hostname.endsWith('googleusercontent.com')) {
      parsed.pathname = parsed.pathname.replace(/=s\d+(-c)?$/, `=s${CDN_PX}$1`)
      if (!/=s\d+/.test(parsed.pathname)) parsed.pathname += `=s${CDN_PX}-c`
      return parsed.toString()
    }

    if (parsed.hostname.endsWith('githubusercontent.com')) {
      parsed.searchParams.set('s', String(CDN_PX))
      return parsed.toString()
    }

    return url
  } catch {
    return url
  }
}

type Props = {
  name: string
  url?: string | null
  className?: string
  style?: CSSProperties
  title?: string
  /**
   * Makes the face a button. Handled here rather than by a wrapping element, because
   * the circle *is* the target: a button around it would either inherit the global
   * button chrome or need a rule undoing it, and both draw a second shape around a
   * shape whose whole job is to be one clean circle.
   */
  onClick?: () => void
  /** Badges and the like, drawn over the face. */
  children?: ReactNode
}

export function Avatar({ name, url, className = 'avatar', style, title, onClick, children }: Props) {
  const [broken, setBroken] = useState(false)

  // A new URL deserves a new attempt: switching the avatar back on after one failed
  // should not be permanently stuck on initials.
  useEffect(() => setBroken(false), [url])

  const showImage = url !== null && url !== undefined && url !== '' && !broken

  return (
    <span
      className={className}
      style={style}
      title={title}
      role={onClick === undefined ? undefined : 'button'}
      tabIndex={onClick === undefined ? undefined : 0}
      onClick={onClick}
      onKeyDown={
        onClick === undefined
          ? undefined
          : (event) => {
              // Space and Enter, because `role="button"` promises a button's keyboard
              // and a span gives you neither for free.
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              onClick()
            }
      }
    >
      {showImage ? (
        <img
          src={sharpUrl(url)}
          alt=""
          draggable={false}
          /*
           * No referrer, or Google's avatar CDN refuses the request.
           * `lh3.googleusercontent.com` answers 403 to a cross-origin load that arrives
           * with a Referer header, and the site sends one by default -
           * `Referrer-Policy: strict-origin-when-cross-origin` in the nginx config.
           * GitHub's CDN does not care, which is why only the Google picture broke.
           * Nothing here needs a referrer sent to a third-party CDN anyway.
           */
          referrerPolicy="no-referrer"
          onError={() => setBroken(true)}
        />
      ) : (
        initialsOf(name)
      )}
      {children}
    </span>
  )
}
