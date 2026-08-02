import { useCallback, useEffect, useState } from 'react'

import * as api from '../../lib/api'
import type { Board } from '../../lib/api'
import { useAuth } from '../auth/AuthContext'

type Props = {
  onOpen: (boardId: string) => void
}

export default function BoardsPage({ onOpen }: Props) {
  const { user, logout } = useAuth()
  const [boards, setBoards] = useState<Board[]>([])
  const [title, setTitle] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const reload = useCallback(async () => {
    try {
      setBoards(await api.listBoards())
    } catch {
      setError('Could not load your fields.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const create = async () => {
    if (user?.default_workspace_id == null) return
    try {
      const board = await api.createBoard(user.default_workspace_id, title.trim() || 'Untitled')
      setTitle('')
      onOpen(board.id)
    } catch {
      setError('Could not create that field.')
    }
  }

  const remove = async (board: Board) => {
    if (!confirm(`Delete "${board.title}"? This cannot be undone.`)) return
    try {
      await api.deleteBoard(board.id)
      await reload()
    } catch {
      setError('Could not delete that field.')
    }
  }

  return (
    <main className="boards">
      <header>
        <div>
          <h1>Your fields</h1>
          <p className="muted">{user?.display_name}</p>
        </div>
        <button type="button" className="link" onClick={() => void logout()}>
          Log out
        </button>
      </header>

      <div className="new-board">
        <input
          value={title}
          placeholder="New field name"
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void create()
          }}
        />
        <button type="button" onClick={() => void create()}>
          Create field
        </button>
      </div>

      {error !== null && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted">Loading...</p>
      ) : boards.length === 0 ? (
        <p className="muted">No fields yet. Create one above.</p>
      ) : (
        <ul className="board-list">
          {boards.map((board) => (
            <li key={board.id}>
              <button type="button" className="board-open" onClick={() => onOpen(board.id)}>
                <span className="board-title">{board.title}</span>
                <span className={`role role-${board.role}`}>{board.role}</span>
              </button>
              {board.role === 'owner' && (
                <button type="button" className="link danger" onClick={() => void remove(board)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
