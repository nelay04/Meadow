import { useEffect, useState } from 'react'

import BoardPage from './features/board/BoardPage'
import { AuthProvider, useAuth } from './features/auth/AuthContext'
import LoginPage from './features/auth/LoginPage'
import BoardsPage from './features/boards/BoardsPage'

/**
 * Routing is a hash and three views. A router library earns its place once there are
 * nested routes and deep links worth preserving; M1 has neither.
 */
function boardIdFromHash(): string | null {
  const match = /^#\/field\/([0-9a-f-]{36})$/i.exec(location.hash)
  return match?.[1] ?? null
}

function Shell() {
  const { user, loading } = useAuth()
  const [boardId, setBoardId] = useState<string | null>(boardIdFromHash)

  useEffect(() => {
    const onHashChange = () => setBoardId(boardIdFromHash())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  if (loading) return <main className="loading">Loading...</main>
  if (user === null) return <LoginPage />

  if (boardId !== null) {
    return (
      <BoardPage
        boardId={boardId}
        onBack={() => {
          location.hash = ''
        }}
      />
    )
  }

  return (
    <BoardsPage
      onOpen={(id) => {
        location.hash = `#/field/${id}`
      }}
    />
  )
}

export default function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  )
}
