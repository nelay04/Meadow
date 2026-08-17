import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { Avatar } from '../../ui/Avatar'
import { IconCheck } from '../../ui/icons'
import { ThemeToggle } from '../../ui/ThemeToggle'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import type { Identity, OAuthProvider, Providers } from '../../lib/api'
import { useAuth } from '../auth/AuthContext'
import { OAUTH_PROVIDERS } from '../auth/providers'

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
 * linked accounts below are records of what each provider says: refreshed on every
 * sign-in, and nothing on this page can write to them. Renaming yourself here has
 * never renamed the GitHub or Google account the name came from, and showing the two
 * apart is the clearest way to say so.
 */
export default function ProfilePage({ onBack }: Props) {
  const { user, updateProfile, logout } = useAuth()
  const toast = useToast()
  const [name, setName] = useState(user?.display_name ?? '')
  const [busy, setBusy] = useState(false)
  const [providers, setProviders] = useState<Providers | null>(null)

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
      .then((available) => {
        if (!cancelled) setProviders(available)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  if (user === null) return null

  const identities = user.identities
  const linked = OAUTH_PROVIDERS.map((provider) => ({
    ...provider,
    identity: identities[provider.id],
  }))
  // Only a linked account that actually has a picture can be chosen as the avatar,
  // which is the same rule the server enforces on the patch.
  const withPicture = linked.filter(
    (provider): provider is typeof provider & { identity: Identity } =>
      provider.identity?.avatar_url != null,
  )
  const borrowableNames = linked.filter(
    (provider) => provider.identity?.name != null && provider.identity.name !== user.display_name,
  )

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

  const chooseAvatar = async (source: 'none' | OAuthProvider) => {
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
              Your email is your account. Signing in with GitHub or Google finds this account
              when the verified email on it matches.
            </span>
          </div>
        </section>

        <section className="card">
          <h2>Display name</h2>
          <p className="hint">
            {borrowableNames.length === 0 && withPicture.length === 0
              ? 'The name other people see on a glade.'
              : 'Taken from the account you first signed in with, and yours to change. Changing it here does not touch that account.'}
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
          {borrowableNames.map(({ id, label, identity }) => (
            <button
              key={id}
              type="button"
              className="ghost profile-inline-action"
              disabled={busy}
              onClick={() => setName(identity?.name ?? '')}
            >
              Use my {label} name ({identity?.name})
            </button>
          ))}
        </section>

        <section className="card">
          <h2>Picture</h2>
          {withPicture.length === 0 ? (
            <p className="hint">
              Link a GitHub or Google account to use its picture. Until then, your initials stand
              in.
            </p>
          ) : (
            <div className="avatar-choices">
              {/*
               * Every option is visible, rather than a switch whose off state has to be
               * imagined. Each one shows the picture it selects.
               */}
              {withPicture.map(({ id, label, identity }) => (
                <button
                  key={id}
                  type="button"
                  className={user.avatar_source === id ? 'avatar-choice on' : 'avatar-choice'}
                  aria-pressed={user.avatar_source === id}
                  disabled={busy}
                  onClick={() => void chooseAvatar(id)}
                >
                  <Avatar
                    name={user.display_name}
                    url={identity.avatar_url}
                    className="avatar avatar-lg"
                  />
                  <span>{label} picture</span>
                  {user.avatar_source === id && <IconCheck size={16} />}
                </button>
              ))}

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
                  : 'Not set. This account signs in with a linked account below.'}
              </span>
            </li>
            {linked.map(({ id, label, Icon, identity }) => (
              <li key={id}>
                <span className="signin-what">
                  <Icon size={16} /> {label}
                </span>
                {identity === undefined ? (
                  <span className="faint">Not connected.</span>
                ) : (
                  <span className="faint">
                    Connected as{' '}
                    {identity.profile_url === null ? (
                      identity.username
                    ) : (
                      <a
                        href={identity.profile_url}
                        target="_blank"
                        rel="noreferrer noopener"
                      >
                        @{identity.username}
                      </a>
                    )}
                    {` since ${linkedOn(identity.linked_at)}`}
                  </span>
                )}
              </li>
            ))}
          </ul>

          {/* Connecting is the same round trip as signing in: the callback matches on
              the verified email and adds the link to whichever account holds it. */}
          {linked
            .filter(({ id, identity }) => identity === undefined && providers?.[id] === true)
            .map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                className="oauth-btn profile-connect"
                onClick={() => {
                  location.href = api.oauthSignInUrl(id, '#/profile')
                }}
              >
                <Icon size={18} />
                Connect {label}
              </button>
            ))}
          {linked.some(({ id, identity }) => identity === undefined && providers?.[id] === true) && (
            <p className="hint">
              Use an account whose verified email is {user.email}. A different email is a
              different account, and you would be signed in to that one instead.
            </p>
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
