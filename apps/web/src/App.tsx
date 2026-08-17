import { useEffect, useState } from 'react'

import BoardPage from './features/board/BoardPage'
import { ConfirmProvider } from './ui/ConfirmDialog'
import { ToastProvider } from './ui/Toaster'
import { AuthProvider, useAuth } from './features/auth/AuthContext'
import LoginPage from './features/auth/LoginPage'
import BoardsPage from './features/boards/BoardsPage'
import ProfilePage from './features/profile/ProfilePage'
import { SplashVideo } from './ui/SplashVideo'

/**
 * Routing is a hash and four views. A router library earns its place once there are
 * nested routes and deep links worth preserving; this still has neither.
 */
type Route = { name: 'boards' } | { name: 'glade'; boardId: string } | { name: 'profile' }

function routeFromHash(): Route {
  // `field` is the old spelling of the same route, kept readable so a tab left
  // open on one still resolves. Only `glade` is ever written.
  const glade = /^#\/(?:glade|field)\/([0-9a-f-]{36})$/i.exec(location.hash)
  if (glade !== null) return { name: 'glade', boardId: glade[1] }
  if (/^#\/profile\/?$/.test(location.hash)) return { name: 'profile' }
  return { name: 'boards' }
}

function Shell() {
  const { user, loading, freshLogin, clearFreshLogin } = useAuth()
  const [route, setRoute] = useState<Route>(routeFromHash)

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const showLoader = loading

  if (freshLogin) {
    return <SplashVideo onDone={clearFreshLogin} />
  }

  // Determine the page content underneath.
  let page: React.ReactNode = null
  if (loading) {
    page = null
  } else if (user === null) {
    page = <LoginPage />
  } else if (route.name === 'glade') {
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
        onOpen={(id) => {
          location.hash = `#/glade/${id}`
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
        <AuthProvider>
          <Shell />
        </AuthProvider>
      </ConfirmProvider>
    </ToastProvider>
  )
}
