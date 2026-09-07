/**
 * How the app words a moment in time.
 *
 * Extracted from the boards list when the sessions log needed the same sentence.
 * Two screens each rounding "3 days ago" their own way is how an app ends up saying
 * "3 days ago" in one place and "last week" in another about the same instant.
 */

/** "3 days ago", the way every file browser says it. Anything recent is "just now". */
export function relativeTime(iso: string): string {
  const then = new Date(iso).getTime()
  if (!Number.isFinite(then)) return ''

  const seconds = Math.max(0, (Date.now() - then) / 1000)
  if (seconds < 90) return 'just now'

  const units: [number, Intl.RelativeTimeFormatUnit][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2592000, 'month'],
    [31536000, 'year'],
  ]

  let unit: Intl.RelativeTimeFormatUnit = 'minute'
  let divisor = 60
  for (const [size, name] of units) {
    if (seconds < size * 60 || name === 'year') {
      unit = name
      divisor = size
      break
    }
  }

  return new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(
    -Math.round(seconds / divisor),
    unit,
  )
}

/**
 * "5 September 2026 at 14:03", in the reader's own locale.
 *
 * The exact moment, for where a rounded one is not enough. On the sessions log that is
 * the whole point of the tooltip: "2 weeks ago" is the right thing to read down a list
 * and the wrong thing to answer "was that me, on the Tuesday I was away?" with.
 */
export function absoluteTime(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}
