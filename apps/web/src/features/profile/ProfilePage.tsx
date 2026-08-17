import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { Avatar } from '../../ui/Avatar'
import { IconCheck, IconGitHub } from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import { useAuth } from '../auth/AuthContext'

type Props = {
  onBack: () => void
}

function linkedOn(iso: string): string {
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

/**
 * The profile page.
 *
 * Two kinds of field live here and the layout says which is which. The top cards are
 * the user's own - their name, and which picture to use - and they are editable. The
 * GitHub entry below is a record of a linked account: it is what GitHub says, it is
 * refreshed on every sign-in, and nothing on this page can write to it. Renaming
 * yourself here has never renamed the GitHub account the name came from, and showing
 * the two apart is the clearest way to say so.
 */
export default function ProfilePage({ onBack }: Props) {
  const { user, updateProfile, logout } = useAuth()
  const toast = useToast()
  const [name, setName] = useState(user?.display_name ?? '')
  const [busy, setBusy] = useState(false)
  const [githubEnabled, setGithubEnabled] = useState(false)

  // The context is the source of truth; this input is a draft of one field of it. It
  // re-seeds when the stored value changes, which is what makes a failed save snap
  // back to what is actually stored rather than leaving a lie in the box.
  useEffect(() => {
    setName(user?.display_name ?? '')
  }, [user?.display_name])

  useEffect(() => {
    let cancelled = false
    void api
      .getProviders()
      .then((providers) => {
        if (!cancelled) setGithubEnabled(providers.github)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (user === null) return null

  const github = user.github
  const trimmed = name.trim()
  const nameChanged = trimmed !== '' && trimmed !== user.display_name

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!nameChanged) return

    setBusy(true)
    try {
      await updateProfile({ display_name: trimmed })
      toast.success('Name updated.')
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 422) {
        toast.error('That name is too long, or empty.')
      } else {
        toast.error('Could not save your name.')
      }
    } finally {
      setBusy(false)
    }
  }

  const chooseAvatar = async (source: 'github' | 'none') => {
    if (user.avatar_source === source) return
    setBusy(true)
    try {
      await updateProfile({ avatar_source: source })
    } catch {
      toast.error('Could not change your picture.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="profile">
      <header className="profile-head">
        <button type="button" className="ghost" onClick={onBack}>
          Back to glades
        </button>
        <span className="spacer" />
        <Wordmark />
        <span className="spacer" />
        <ThemeToggle />
      </header>

      <main className="profile-body">
        <h1>Profile</h1>

        <section className="card profile-identity">
          <Avatar name={user.display_name} url={user.avatar_url} className="avatar avatar-xl" />
          <div className="profile-identity-text">
            <strong>{user.display_name}</strong>
            {/* Read-only, and the sentence says why rather than leaving a greyed-out
                box to be argued with. */}
            <span className="faint">{user.email}</span>
            <span className="hint">
              Your email is your account. Signing in with GitHub finds this account when the
              verified email on it matches.
            </span>
          </div>
        </section>

        <section className="card">
          <h2>Display name</h2>
          <p className="hint">
            {github === null
              ? 'The name other people see on a glade.'
              : 'Taken from your GitHub name when you first signed in, and yours to change. Changing it here does not touch GitHub.'}
          </p>
          <form className="profile-row" onSubmit={save} noValidate>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={80}
              aria-label="Display name"
              autoComplete="name"
            />
            <button type="submit" className="primary" disabled={busy || !nameChanged}>
              Save
            </button>
          </form>
          {github?.name != null && github.name !== user.display_name && (
            <button
              type="button"
              className="ghost profile-inline-action"
              disabled={busy}
              onClick={() => setName(github.name ?? '')}
            >
              Use my GitHub name ({github.name})
            </button>
          )}
        </section>

        <section className="card">
          <h2>Picture</h2>
          {github?.avatar_url == null ? (
            <p className="hint">
              Link a GitHub account to use its picture. Until then, your initials stand in.
            </p>
          ) : (
            <div className="avatar-choices">
              {/*
               * Two options and both are visible, rather than a switch whose off state
               * has to be imagined. Each one shows the picture it selects.
               */}
              <button
                type="button"
                className={user.avatar_source === 'github' ? 'avatar-choice on' : 'avatar-choice'}
                aria-pressed={user.avatar_source === 'github'}
                disabled={busy}
                onClick={() => void chooseAvatar('github')}
              >
                <Avatar
                  name={user.display_name}
                  url={github.avatar_url}
                  className="avatar avatar-lg"
                />
                <span>GitHub picture</span>
                {user.avatar_source === 'github' && <IconCheck size={16} />}
              </button>

              <button
                type="button"
                className={user.avatar_source === 'none' ? 'avatar-choice on' : 'avatar-choice'}
                aria-pressed={user.avatar_source === 'none'}
                disabled={busy}
                onClick={() => void chooseAvatar('none')}
              >
                <Avatar name={user.display_name} className="avatar avatar-lg" />
                <span>Initials</span>
                {user.avatar_source === 'none' && <IconCheck size={16} />}
              </button>
            </div>
          )}
        </section>

        <section className="card">
          <h2>Sign-in</h2>
          <ul className="signin-list">
            <li>
              <span className="signin-what">Password</span>
              <span className="faint">
                {user.has_password
                  ? 'Set. You can sign in with your email and password.'
                  : 'Not set. This account signs in with GitHub.'}
              </span>
            </li>
            <li>
              <span className="signin-what">
                <IconGitHub size={16} /> GitHub
              </span>
              {github === null ? (
                <span className="faint">Not connected.</span>
              ) : (
                <span className="faint">
                  Connected as{' '}
                  <a
                    href={github.profile_url ?? undefined}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    @{github.username}
                  </a>
                  {github.email === null ? '' : ` (${github.email})`}
                  {` since ${linkedOn(github.linked_at)}`}
                </span>
              )}
            </li>
          </ul>

          {github === null && githubEnabled && (
            <>
              <button
                type="button"
                className="oauth-btn profile-connect"
                onClick={() => {
                  location.href = api.githubSignInUrl('#/profile')
                }}
              >
                <IconGitHub size={18} />
                Connect GitHub
              </button>
              <p className="hint">
                Use a GitHub account whose verified email is {user.email}. A different email is a
                different account, and you would be signed in to that one instead.
              </p>
            </>
          )}
        </section>

        <div className="profile-foot">
          <button type="button" className="ghost" onClick={() => void logout()}>
            Log out
          </button>
        </div>
      </main>
    </div>
  )
}
