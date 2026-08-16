/**
 * The brand marks.
 *
 * Two assets, one source of truth for which is used where. The wordmark carries the
 * name and needs no text beside it; the square mark is for anywhere the name would
 * not fit, and it is the same art the favicon is cut from.
 *
 * Both are PNGs with transparency and a neon glow, so they sit on the cream and the
 * navy surface without a plate behind them.
 */

type Props = { className?: string }

/** The full "meadow" wordmark. Sized by CSS height; the width follows. */
export function Wordmark({ className = 'wordmark' }: Props) {
  return <img src="/brand/meadow-wordmark.png" alt="Meadow" className={className} />
}

/** The square sprout-m mark. Decorative wherever a Wordmark or a heading names the app. */
export function Mark({ className = 'mark', alt = '' }: Props & { alt?: string }) {
  return <img src="/brand/meadow-mark.png" alt={alt} aria-hidden={alt === ''} className={className} />
}
