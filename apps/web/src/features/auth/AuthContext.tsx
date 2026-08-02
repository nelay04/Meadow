import { createContext, use, useCallback, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import * as api from '../../lib/api'
import type { User } from '../../lib/api'

type AuthState = {
  user: User | null
  /** True until the initial refresh-cookie exchange settles, so the UI can wait. */
  loading: boolean
  login: (email: string, password: string) => Promise<void>
  register: (email: string, password: string, displayName: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    // The access token was in memory and is gone after a reload. The httpOnly refresh
    // cookie is not, so trade it for a new session before deciding to show the login
    // form - otherwise every refresh looks like a logout.
    void api.restoreSession().then((restored) => {
      if (cancelled) return
      setUser(restored)
      setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    setUser(await api.login(email, password))
  }, [])

  const register = useCallback(
    async (email: string, password: string, displayName: string) => {
      setUser(await api.register(email, password, displayName))
    },
    [],
  )

  const logout = useCallback(async () => {
    await api.logout()
    setUser(null)
  }, [])

  const value = useMemo(
    () => ({ user, loading, login, register, logout }),
    [user, loading, login, register, logout],
  )

  return <AuthContext value={value}>{children}</AuthContext>
}

export function useAuth(): AuthState {
  const context = use(AuthContext)
  if (context === null) throw new Error('useAuth must be used inside AuthProvider')
  return context
}
