import { useEffect, useState } from 'react'

import BoardPage from './features/board/BoardPage'
import JoinPage from './features/board/JoinPage'
import { ConfirmProvider } from './ui/ConfirmDialog'
import { PromptProvider } from './ui/PromptDialog'
import { ToastProvider } from './ui/Toaster'
import { AuthProvider, useAuth } from './features/auth/AuthContext'
import LoginPage from './features/auth/LoginPage'
import ResetPasswordPage from './features/auth/ResetPasswordPage'
import BoardsPage from './features/boards/BoardsPage'
import { BOARD_PATH_SEGMENTS, boardPath } from './features/boards/kinds'
import { shareToken } from './lib/shareLink'
import ProfilePage from './features/profile/ProfilePage'
import { SplashVideo } from './ui/SplashVideo'

/**
 * Routing is a hash and five views. A router library earns its place once there are
 * nested routes and deep links worth preserving; this still has neither.
 */
type Route =
  | { name: 'boards' }
  | { name: 'board'; boardId: string }
  | { name: 'profile' }
  | { name: 'reset'; token: string }
  | { name: 'join'; token: string }

/*
 * One route per kind of board, all matching the same view.
 *
 * The segment is the kind - `#/glade/...`, `#/lea/...` - because the address bar is
 * the one piece of this app a person reads and sends on. It is not load-bearing: the
 * board view learns the real kind from the server and rewrites the hash if the link
 * disagreed, so an old link, a hand-edited one, or a link to a board somebody has
 * since changed all still open the right thing.
 */
const BOARD_ROUTE = new RegExp(`^#/(?:${BOARD_PATH_SEGMENTS.join('|')})/([0-9a-f-]{36})$`, 'i')

function routeFromHash(): Route {
  const board = BOARD_ROUTE.exec(location.hash)
  if (board !== null) return { name: 'board', boardId: board[1] }
  if (/^#\/profile\/?$/.test(location.hash)) return { name: 'profile' }
  // The password reset link from the mail. The token lives in the fragment, so it never
  // reaches a server log on the way here.
  const reset = /^#\/reset\/([A-Za-z0-9_-]{16,256})$/.exec(location.hash)
  if (reset !== null) return { name: 'reset', token: reset[1] }
  // A board invitation for an address with no account yet. Same shape of token and,
  // like the reset link, in the fragment: this one is read by the page and never posted
  // anywhere, so there is no reason to put it in a request line.
  const join = /^#\/join\/([A-Za-z0-9_-]{16,256})$/.exec(location.hash)
  if (join !== null) return { name: 'join', token: join[1] }
  return { name: 'boards' }
}

function Shell() {
  const { user, loading, justRegistered, clearJustRegistered } = useAuth()
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  // Neither the reset screen nor the join screen waits on a session, so neither must be
  // covered by the loader that exists to hide a half-restored one.
  const showLoader = loading && route.name !== 'reset' && route.name !== 'join'

  // Only a brand new account gets the splash, and it is skippable. A returning user
  // signing in has seen it, and a video between them and their glades every time is a
  // toll rather than a welcome.
  if (justRegistered) {
    return <SplashVideo onDone={clearJustRegistered} />
  }

  // Determine the page content underneath.
  let page: React.ReactNode = null
  if (route.name === 'reset') {
    // Ahead of the session check on purpose: whoever followed this link is proving the
    // account is theirs, and being signed in as somebody else does not change that.
    page = (
      <ResetPasswordPage
        token={route.token}
        onDone={() => {
          location.hash = ''
        }}
      />
    )
  } else if (route.name === 'join') {
    // Ahead of the session check as well, and for a related reason: the whole audience
    // for an invitation link is people who do not have an account here yet, and sending
    // them to a login form first would answer a question they never asked.
    page = (
      <JoinPage
        token={route.token}
        onDone={() => {
          location.hash = ''
        }}
      />
    )
  } else if (loading) {
    page = null
  } else if (user === null && !(route.name === 'board' && shareToken() !== null)) {
    /*
     * The one place a signed-out visitor is let past.
     *
     * A public share link opens the board itself, with no account and no sign-in - that
     * is what makes it worth posting anywhere. The token only gets them as far as
     * *rendering* the view: everything it can actually do is decided by the server, at
     * the ws-token mint and again at the handshake, and a token for a board that is no
     * longer public opens an empty view that says so.
     */
    page = <LoginPage />
  } else if (route.name === 'board') {
    page = (
      <BoardPage
        boardId={route.boardId}
        onBack={() => {
          location.hash = ''
        }}
      />
    )
  } else if (route.name === 'profile') {
    page = (
      <ProfilePage
        onBack={() => {
          location.hash = ''
        }}
      />
    )
  } else {
    page = (
      <BoardsPage
        onOpen={(id, kind) => {
          location.hash = boardPath(kind, id)
        }}
      />
    )
  }

  return (
    <>
      {page}
      {showLoader && (
        <div className="loader-screen">
          <div className="loader-wordmark">
            <img
              src="/brand/meadow-wordmark.png"
              alt="Meadow"
              draggable={false}
            />
          </div>
        </div>
      )}
    </>
  )
}

export default function App() {
  /*
   * Both providers sit outside the auth boundary, so the login screen can talk too. A
   * failed sign-in is exactly the kind of thing a toast is for, and a provider mounted
   * inside `Shell` would be remounted by every view change underneath it, taking any
   * toast still on screen with it.
   */
  return (
    <ToastProvider>
      <ConfirmProvider>
        <PromptProvider>
          <AuthProvider>
            <Shell />
          </AuthProvider>
        </PromptProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
