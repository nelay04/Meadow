/**
 * The wordmark over a veil, for the moments the app knows nothing yet.
 *
 * Two places show it and they are the same moment seen twice: a session being
 * restored, and a glade waiting to hear whether it may be opened. Shared so they
 * cannot drift, because a second loading screen that looks slightly different reads
 * as a second kind of waiting.
 */
export function LoaderScreen() {
  return (
    <div className="loader-screen">
      <div className="loader-wordmark">
        <img src="/brand/meadow-wordmark.png" alt="Meadow" draggable={false} />
      </div>
    </div>
  )
}
