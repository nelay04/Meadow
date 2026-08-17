import { useEffect, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'

/**
 * A person's face: their picture when there is one, their initials when there is not.
 *
 * One component rather than the three copies of `initials()` this replaces, because
 * the picture half has a failure mode the initials half does not. A GitHub avatar is
 * a remote URL on someone else's CDN: it can 404 after an account is renamed, and it
 * can be blocked. `onError` falls back to the initials instead of leaving the broken
 * image glyph, which is the whole reason this is a component and not a template.
 */
export function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase()
}

type Props = {
  name: string
  url?: string | null
  className?: string
  style?: CSSProperties
  title?: string
  /** Badges and the like, drawn over the face. */
  children?: ReactNode
}

export function Avatar({ name, url, className = 'avatar', style, title, children }: Props) {
  const [broken, setBroken] = useState(false)

  // A new URL deserves a new attempt: switching the avatar back on after one failed
  // should not be permanently stuck on initials.
  useEffect(() => setBroken(false), [url])

  const showImage = url !== null && url !== undefined && url !== '' && !broken

  return (
    <span className={className} style={style} title={title}>
      {showImage ? (
        <img src={url} alt="" draggable={false} onError={() => setBroken(true)} />
      ) : (
        initialsOf(name)
      )}
      {children}
    </span>
  )
}
