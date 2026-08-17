import { useEffect, useRef } from 'react'

type SplashVideoProps = {
  onDone: () => void
}

/**
 * Full-screen entry video that plays once after login or register.
 * Non-interactive: no controls, no pointer events, no text selection.
 * Calls onDone when the video ends or if it fails to play.
 */
export function SplashVideo({ onDone }: SplashVideoProps) {
  const ref = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return

    const finish = () => onDone()
    el.addEventListener('ended', finish)
    el.addEventListener('error', finish)

    // Play may be blocked by browser policy on some browsers but
    // that is acceptable - error listener above will call onDone.
    void el.play().catch(() => onDone())

    return () => {
      el.removeEventListener('ended', finish)
      el.removeEventListener('error', finish)
    }
  }, [onDone])

  return (
    <div className="splash-video-wrap">
      <video
        ref={ref}
        className="splash-video"
        src="/brand/mewdow_entry.mp4"
        muted
        playsInline
        disablePictureInPicture
        disableRemotePlayback
        preload="auto"
      />
      <button className="splash-skip" type="button" onClick={() => onDone()}>
        Skip
      </button>
    </div>
  )
}
