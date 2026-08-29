import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'

import { Wordmark } from '../../ui/Brand'
import { Avatar } from '../../ui/Avatar'
import { IconAuto, IconBack, IconCheck, IconMoon, IconSun } from '../../ui/icons'
import {
  PAPERS,
  PAPER_EVENT,
  PAPER_LABEL,
  type Paper,
  readPaperPreference,
  writePaperPreference,
} from '../../ui/paper'
import { THEME_EVENT, type Theme, applyTheme, readTheme } from '../../ui/theme'
import { useToast } from '../../ui/Toaster'
import * as api from '../../lib/api'
import { ApiError } from '../../lib/api'
import type { Identity, OAuthProvider, Providers } from '../../lib/api'
import { useAuth } from '../auth/AuthContext'
import { OAUTH_PROVIDERS } from '../auth/providers'

type Props = {
  onBack: () => void
}

const THEME_CHOICES: { id: Theme; label: string; Icon: typeof IconSun }[] = [
  { id: 'system', label: 'Match system', Icon: IconAuto },
  { id: 'light', label: 'Light', Icon: IconSun },
  { id: 'dark', label: 'Dark', Icon: IconMoon },
]

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
  const { user, updateProfile, logout, signInError, clearSignInError, signInNotice, clearSignInNotice } =
    useAuth()
  const toast = useToast()
  const [name, setName] = useState(user?.display_name ?? '')
  const [busy, setBusy] = useState(false)
  // Its own flag rather than the shared `busy`: this request waits on a mail relay,
  // which is seconds rather than milliseconds, and the button has to say so.
  const [sendingPassword, setSendingPassword] = useState(false)
  const [passwordLinkSent, setPasswordLinkSent] = useState(false)
  const [providers, setProviders] = useState<Providers | null>(null)
  // Read once, from the same place the toggle used to read it, so a theme chosen in an
  // earlier session is the one shown as chosen here.
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [paper, setPaper] = useState<Paper>(readPaperPreference)

  /*
   * Both are settings of this browser rather than of this page, so this page is not the
   * only thing that can move them: another tab's profile can, and `ui/paper.ts` turns
   * a cross-tab `storage` event into the same event a local change fires. Without this
   * the radios here would sit on a stale answer while the rest of the app had already
   * changed.
   */
  useEffect(() => {
    const onPaper = (): void => setPaper(readPaperPreference())
    const onTheme = (): void => setTheme(readTheme())
    window.addEventListener(PAPER_EVENT, onPaper)
    window.addEventListener(THEME_EVENT, onTheme)
    return () => {
      window.removeEventListener(PAPER_EVENT, onPaper)
      window.removeEventListener(THEME_EVENT, onTheme)
    }
  }, [])

  // The context is the source of truth; this input is a draft of one field of it. It
  // re-seeds when the stored value changes, which is what makes a failed save snap
  // back to what is actually stored rather than leaving a lie in the box.
  useEffect(() => {
    setName(user?.display_name ?? '')
  }, [user?.display_name])

  /*
   * Connecting a provider leaves the site and comes back here, so the answer arrives in
   * the context rather than from a call this page made. Shown as a toast because the
   * page is already full of the thing it is about, and taken off the context so it
   * cannot reappear on the next visit.
   */
  useEffect(() => {
    if (signInError === null) return
    toast.error(signInError)
    clearSignInError()
  }, [signInError, clearSignInError, toast])

  useEffect(() => {
    if (signInNotice === null) return
    toast.success(signInNotice)
    clearSignInNotice()
  }, [signInNotice, clearSignInNotice, toast])

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

  const sendPasswordLink = async () => {
    setSendingPassword(true)
    try {
      await api.requestPasswordChange()
      // Both, on purpose. The toast is the thing that catches the eye at the moment it
      // happens; the line under the row is what is still there a few seconds later,
      // when the question is "did I actually press that".
      setPasswordLinkSent(true)
      toast.success(`Email sent to ${user.email}. The link expires in an hour.`)
    } catch (caught) {
      setPasswordLinkSent(false)
      if (caught instanceof ApiError && caught.status === 503) {
        toast.error('This deployment cannot send email yet, so no link could be sent.')
      } else if (caught instanceof ApiError && caught.status === 502) {
        toast.error('The email could not be sent. Try again in a moment.')
      } else if (caught instanceof ApiError && caught.status === 429) {
        toast.error('That link was just requested. Check your inbox, or wait a while.')
      } else {
        toast.error('Could not send that. Try again in a moment.')
      }
    } finally {
      setSendingPassword(false)
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
        {/* The same mark as the board view's, rather than a worded button. Every
            other screen in the app leaves by this arrow in this corner, and one page
            spelling it out reads as a different kind of page. */}
        <button
          type="button"
          className="icon ghost"
          onClick={onBack}
          title="Back to your glades"
          aria-label="Back to your glades"
        >
          <IconBack />
        </button>
        <span className="spacer" />
        <Wordmark />
        <span className="spacer" />
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
              when the verified email on it matches, and refuses when it does not.
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
              <span className="signin-state">
                <span className="faint">
                  {user.has_password
                    ? 'Set. You can sign in with your email and password.'
                    : 'Not set. This account signs in with a linked account below.'}
                </span>
                {/* Changing one and adding a first one are the same request: a link in
                    the post, because the thing that authorises a new password is control
                    of the address, not being signed in on this tab. */}
                <button
                  type="button"
                  className="ghost profile-connect"
                  disabled={sendingPassword}
                  onClick={() => void sendPasswordLink()}
                >
                  {sendingPassword
                    ? 'Sending...'
                    : user.has_password
                      ? 'Change'
                      : 'Set a password'}
                </button>
              </span>
              {passwordLinkSent && (
                <span className="hint">
                  Check the inbox for {user.email} and follow the link in the email. It works
                  once and expires in an hour.
                </span>
              )}
            </li>
            {linked.map(({ id, label, Icon, identity }) => (
              <li key={id}>
                <span className="signin-what">
                  <Icon size={16} /> {label}
                </span>
                {identity === undefined ? (
                  <span className="signin-state">
                    <span className="faint">Not connected.</span>
                    {/* The button belongs to its row: connecting is the same round trip
                        as signing in, and which provider it is about should not have to
                        be carried from a list up here to a stack of buttons below. */}
                    {providers?.[id] === true && (
                      <button
                        type="button"
                        className="ghost profile-connect"
                        onClick={() => {
                          location.href = api.oauthSignInUrl(id, { next: '#/profile', intent: 'link' })
                        }}
                      >
                        Connect
                      </button>
                    )}
                  </span>
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

          {linked.some(({ id, identity }) => identity === undefined && providers?.[id] === true) && (
            <p className="hint">
              Connecting uses the email as the key: sign in with an account whose verified
              email is {user.email}. A different address is refused rather than linked, and
              you stay signed in as yourself either way.
            </p>
          )}
        </section>

        {/*
          Appearance.
          This was a single icon in the sidebar that cycled three states, which is the
          right control when it has to fit beside a name and the wrong one anywhere
          there is room: cycling makes you press a button twice to find out what it
          does, and it never showed the two options you were not on. A settings page
          has room, so all three are on screen and the current one is simply marked.
        */}
        <section className="card">
          <h2>Appearance</h2>
          <p className="hint">
            Applies to this browser only, and takes effect as you choose it. Matching
            the system follows it when it changes, including at sunset.
          </p>
          <div className="theme-choices" role="radiogroup" aria-label="Theme">
            {THEME_CHOICES.map((choice) => (
              <button
                key={choice.id}
                type="button"
                role="radio"
                aria-checked={theme === choice.id}
                className={theme === choice.id ? 'theme-choice active' : 'theme-choice'}
                onClick={() => {
                  setTheme(choice.id)
                  applyTheme(choice.id)
                }}
              >
                <choice.Icon size={20} />
                <span>{choice.label}</span>
              </button>
            ))}
          </div>
        </section>

        {/*
          The stock every diary is printed on.
          The same setting as the paper menu in a lea's own toolbar, not a default
          underneath it: either control moves this one value. It is a preference of this
          browser rather than something written into a document, so it is how leas look
          to you and changes nothing for anyone you share one with.
        */}
        <section className="card">
          <h2>Diary paper</h2>
          <p className="hint">
            What every lea is printed on, for you. The paper menu on a lea itself is the
            same setting, so changing it in either place changes both. Matching the theme
            gives a page that turns dark with the rest of the app; the others stay what
            they are in both.
          </p>
          <div className="theme-choices" role="radiogroup" aria-label="Diary paper">
            {PAPERS.map((choice) => (
              <button
                key={choice}
                type="button"
                role="radio"
                aria-checked={paper === choice}
                className={paper === choice ? 'theme-choice active' : 'theme-choice'}
                onClick={() => {
                  setPaper(choice)
                  writePaperPreference(choice)
                }}
              >
                <span className="paper-swatch" data-paper={choice} aria-hidden="true" />
                <span>{PAPER_LABEL[choice]}</span>
              </button>
            ))}
          </div>
        </section>

        {/* After Sign-in, because it is the other half of the same subject: how this
            account gets in, and how it gets out. */}
        <section className="card profile-signout">
          <div className="profile-signout-text">
            <h2>Log out</h2>
            <p className="hint">Ends the session on this device only. Your glades stay put.</p>
          </div>
          <button type="button" className="danger" onClick={() => void logout()}>
            Log out
          </button>
        </section>
      </main>
    </div>
  )
}
