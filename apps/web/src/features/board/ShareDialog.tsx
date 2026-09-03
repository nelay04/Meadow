/**
 * Who can open this glade, and how you tell them.
 *
 * Two halves, and the split is the whole design. The top half is *general access* -
 * one setting that decides whether the address is an address or a key. The bottom half
 * is *particular people*, named by their email. They are not two ways of doing one
 * thing: making a board public is a decision about strangers, and inviting Priya is a
 * decision about Priya, and a dialog that mixed them would make one of them happen by
 * accident.
 *
 * The one genuinely unusual thing here is what happens when you invite an address that
 * has no account. Every product in this category mails it anyway. This one does not,
 * and says so out loud: it hands the owner a registration link to pass on themselves.
 * The reason is not politeness. Mailing an arbitrary unverified address that somebody
 * typed into a form is an open relay wearing our from-address, and it is how a young
 * domain ends up on a blocklist - after which none of the *real* mail, the activation
 * links people are waiting on, arrives either. So the restraint protects the thing it
 * looks like it is getting in the way of.
 *
 * Owner only. Every control in here decides who else may be here, and an editor
 * handing out editor links would be granting more than they were granted.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import * as api from '../../lib/api'
import type { BoardRole, InviteResult, ShareMode, ShareState } from '../../lib/api'
import { Avatar } from '../../ui/Avatar'
import { useConfirm } from '../../ui/ConfirmDialog'
import { useToast } from '../../ui/Toaster'
import {
  IconCheck,
  IconCopy,
  IconEye,
  IconFacebook,
  IconGlobe,
  IconLinkedIn,
  IconLock,
  IconMail,
  IconPencil,
  IconRotate,
  IconTelegram,
  IconTrash,
  IconWhatsApp,
  IconX,
} from '../../ui/icons'

type Props = {
  boardId: string
  /** The board's name, for the heading and for what the social buttons say. */
  title: string
  /** "glade" or "lea", lowercase. The dialog talks about the thing, not about "boards". */
  noun: string
  onClose: () => void
  /**
   * Fired whenever something the board view is also showing has changed: the lock, or
   * the sharing mode. The view re-reads rather than being handed a patch, because the
   * server is the authority on all three and it has just answered with all three.
   */
  onChanged: (state: ShareState) => void
}

/** The two roles a link or an invitation may carry. Owner is never one of them. */
const SHAREABLE: { id: BoardRole; label: string; hint: string; Icon: typeof IconEye }[] = [
  { id: 'viewer', label: 'Can view', hint: 'Read and follow along. No edits.', Icon: IconEye },
  { id: 'editor', label: 'Can edit', hint: 'Draw, write, and move things.', Icon: IconPencil },
]

/**
 * Where each button posts, given a URL and a line of text.
 *
 * All of them are plain `https://` intent URLs opened in a new tab - no SDK, no script
 * tag, no pixel. That is not only a bundle-size decision: an embedded share widget is
 * a third party watching everyone who opens this dialog, on a page that is otherwise
 * entirely first-party.
 *
 * Facebook and LinkedIn take a URL and nothing else. They read the destination's own
 * metadata for the words, and any text passed alongside is discarded - so no text is
 * passed, rather than passing some and having it silently vanish.
 */
const SOCIALS: {
  id: string
  label: string
  Icon: typeof IconWhatsApp
  href(url: string, text: string): string
}[] = [
  {
    id: 'whatsapp',
    label: 'WhatsApp',
    Icon: IconWhatsApp,
    href: (url, text) => `https://wa.me/?text=${encodeURIComponent(`${text} ${url}`)}`,
  },
  {
    id: 'x',
    label: 'X',
    Icon: IconX,
    href: (url, text) =>
      `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`,
  },
  {
    id: 'telegram',
    label: 'Telegram',
    Icon: IconTelegram,
    href: (url, text) =>
      `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`,
  },
  {
    id: 'facebook',
    label: 'Facebook',
    Icon: IconFacebook,
    href: (url) => `https://www.facebook.com/sharer/sharer.php?u=${encodeURIComponent(url)}`,
  },
  {
    id: 'linkedin',
    label: 'LinkedIn',
    Icon: IconLinkedIn,
    href: (url) =>
      `https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(url)}`,
  },
]

/**
 * Copy, by whichever route the browser allows.
 *
 * `navigator.clipboard` is unavailable on plain http beyond localhost, which is most
 * development and every deployment behind an un-TLS'd proxy - exactly where somebody
 * is most likely to be testing this. The fallback is deprecated and still works
 * everywhere, and a copy button that silently does nothing is worse than either.
 */
async function copy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // Fall through.
  }
  try {
    const field = document.createElement('textarea')
    field.value = text
    // Off-screen rather than hidden: `display: none` cannot be selected from.
    field.style.position = 'fixed'
    field.style.opacity = '0'
    document.body.append(field)
    field.select()
    const done = document.execCommand('copy')
    field.remove()
    return done
  } catch {
    return false
  }
}

/** A field showing a URL, with the button that copies it. */
function CopyRow({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false)
  const toast = useToast()

  // The tick reverts on its own. A button that stays "Copied" forever stops being a
  // button and starts being a label.
  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 1800)
    return () => clearTimeout(timer)
  }, [copied])

  return (
    <div className="copy-row">
      <input
        className="copy-field"
        value={value}
        readOnly
        aria-label={label}
        onFocus={(event) => event.currentTarget.select()}
      />
      <button
        type="button"
        className={copied ? 'copy-button copied' : 'copy-button'}
        onClick={() => {
          void copy(value).then((ok) => {
            if (ok) setCopied(true)
            // Not a toast on success: the button says so, right where the eye already
            // is. A toast is for the failure, which happens away from the pointer.
            else toast.error('Could not reach the clipboard. Select the link and copy it.')
          })
        }}
      >
        {copied ? <IconCheck size={15} /> : <IconCopy size={15} />}
        <span>{copied ? 'Copied' : 'Copy'}</span>
      </button>
    </div>
  )
}

export function ShareDialog({ boardId, title, noun, onClose, onChanged }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null)
  const toast = useToast()
  const confirm = useConfirm()

  const [share, setShare] = useState<ShareState | null>(null)
  const [failed, setFailed] = useState(false)
  /** Set while a request is in flight, so the controls cannot be double-fired. */
  const [busy, setBusy] = useState(false)

  const [email, setEmail] = useState('')
  const [inviteRole, setInviteRole] = useState<BoardRole>('editor')
  /**
   * The last invite's answer, kept on screen rather than toasted.
   *
   * A toast is wrong for the "no account yet" case specifically: it carries a link the
   * person now has to copy, and a message that dismisses itself while you are reaching
   * for it is a message that loses the only copy of something.
   */
  const [result, setResult] = useState<InviteResult | null>(null)

  useEffect(() => {
    const dialog = dialogRef.current
    if (dialog !== null && !dialog.open) dialog.showModal()
  }, [])

  const apply = useCallback(
    (next: ShareState) => {
      setShare(next)
      onChanged(next)
    },
    [onChanged],
  )

  useEffect(() => {
    let cancelled = false
    api
      .getShare(boardId)
      .then((state) => {
        if (!cancelled) apply(state)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [boardId, apply])

  /** Run one request, keeping the dialog from firing a second while it is out. */
  const run = useCallback(
    async (work: () => Promise<ShareState>, failure: string) => {
      setBusy(true)
      try {
        apply(await work())
      } catch (error) {
        toast.error(error instanceof Error ? error.message : failure)
      } finally {
        setBusy(false)
      }
    },
    [apply, toast],
  )

  const setMode = (mode: ShareMode, role: BoardRole) =>
    void run(() => api.setShare(boardId, mode, role), 'Could not change who can open this.')

  const rotate = async () => {
    const sure = await confirm({
      title: 'Replace the link?',
      body:
        'Every copy of the current link stops working, including ones already sent.' +
        ' Anyone reading it right now is disconnected.',
      confirmLabel: 'Replace it',
      tone: 'danger',
    })
    if (!sure) return
    void run(() => api.rotateShareLink(boardId), 'Could not replace the link.')
  }

  const invite = async () => {
    const address = email.trim()
    if (address === '') return
    setBusy(true)
    try {
      const answer = await api.inviteToBoard(boardId, address, inviteRole)
      setResult(answer)
      setEmail('')
      if (answer.status === 'granted') {
        toast.success(
          answer.mailed
            ? `Shared with ${answer.display_name ?? answer.email}, and they have been emailed.`
            : `Shared with ${answer.display_name ?? answer.email}, but the email could not be sent.`,
        )
      }
      if (answer.status === 'member') {
        toast.info(`${answer.display_name ?? answer.email} already has that access.`)
      }
      // The pending case says nothing here. Its whole message is the card below, and a
      // toast on top of it would be the same news twice.
      apply(await api.getShare(boardId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not send that invitation.')
    } finally {
      setBusy(false)
    }
  }

  const changeRole = async (userId: string, role: BoardRole) => {
    setBusy(true)
    try {
      await api.setMemberRole(boardId, userId, role)
      apply(await api.getShare(boardId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not change that role.')
    } finally {
      setBusy(false)
    }
  }

  const removeMember = async (userId: string, name: string) => {
    const sure = await confirm({
      title: `Remove ${name}?`,
      body: `They lose access to this ${noun} immediately, including any tab they have open.`,
      confirmLabel: 'Remove',
      tone: 'danger',
    })
    if (!sure) return
    setBusy(true)
    try {
      await api.removeMember(boardId, userId)
      apply(await api.getShare(boardId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not remove them.')
    } finally {
      setBusy(false)
    }
  }

  const revoke = async (invitationId: string) => {
    setBusy(true)
    try {
      await api.revokeInvitation(boardId, invitationId)
      apply(await api.getShare(boardId))
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not withdraw it.')
    } finally {
      setBusy(false)
    }
  }

  const isPublic = share?.mode === 'public'
  // Public shows the capability URL; restricted shows the plain address, which opens
  // for the people already on the list and for nobody else. Same field either way, so
  // "copy link" always means the link that currently works.
  const linkValue = (isPublic ? share?.link_url : share?.url) ?? ''
  const socialText = `${title} - a ${noun} on Meadow`

  return (
    <dialog
      ref={dialogRef}
      className="modal share-modal"
      aria-labelledby="share-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
      onMouseDown={(event) => {
        if (event.target === dialogRef.current) onClose()
      }}
    >
      <div className="modal-card share-card">
        <h2 id="share-title">Share “{title}”</h2>

        {failed && (
          <p className="modal-body">
            Only the owner of a {noun} can change who it is shared with.
          </p>
        )}

        {share !== null && (
          <>
            <section className="share-section">
              <h3>General access</h3>

              {/*
                One row, two segments, and a sentence under it.

                This was two large cards, each with its own heading and its own line of
                explanation, and then - when the board was public - a third row below
                repeating "Anyone with the link" beside the role control. Four lines of
                type and a duplicated label for a choice between two things, at the top
                of a dialog that already holds a URL, a send row, an invite form and a
                list of people. The choice is binary and it is a *setting*, so it gets
                the control every other setting in this app gets, and the explanation is
                one line that changes with the answer rather than two that stand whether
                they apply or not.
              */}
              <div
                className="segmented access-modes"
                role="radiogroup"
                aria-label="General access"
              >
                <button
                  type="button"
                  role="radio"
                  aria-checked={!isPublic}
                  className={isPublic ? '' : 'active'}
                  disabled={busy}
                  onClick={() => setMode('restricted', share.role)}
                >
                  <IconLock size={14} />
                  Restricted
                </button>

                <button
                  type="button"
                  role="radio"
                  aria-checked={isPublic}
                  className={isPublic ? 'active' : ''}
                  disabled={busy}
                  onClick={() => setMode('public', share.role)}
                >
                  <IconGlobe size={14} />
                  Anyone with the link
                </button>
              </div>

              {/* The consequence on the left, and - when there is a link to strangers -
                  what it hands them on the right. One row, because they are one
                  sentence: anyone with the link can view. */}
              <div className="access-line">
                <p className="share-note">
                  {isPublic
                    ? `Anyone who has the link opens this ${noun} as a guest, with no sign-in.`
                    : 'Only the people listed below can open it, signed in or not.'}
                </p>

                {isPublic && (
                  <div className="segmented" role="radiogroup" aria-label="What the link grants">
                    {SHAREABLE.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={share.role === option.id}
                        className={share.role === option.id ? 'active' : ''}
                        disabled={busy}
                        title={option.hint}
                        onClick={() => setMode('public', option.id)}
                      >
                        <option.Icon size={14} />
                        {option.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <CopyRow value={linkValue} label={`Link to this ${noun}`} />

              <div className="socials" aria-label="Share this link">
                {SOCIALS.map((social) => (
                  <a
                    key={social.id}
                    className="social"
                    href={social.href(linkValue, socialText)}
                    target="_blank"
                    // noopener because the opened page gets a handle on this one
                    // otherwise; noreferrer so a share does not tell the network where
                    // this deployment lives.
                    rel="noopener noreferrer"
                    title={`Share on ${social.label}`}
                    aria-label={`Share on ${social.label}`}
                  >
                    <social.Icon size={17} />
                  </a>
                ))}
                <a
                  className="social"
                  href={`mailto:?subject=${encodeURIComponent(socialText)}&body=${encodeURIComponent(linkValue)}`}
                  title="Share by email"
                  aria-label="Share by email"
                >
                  <IconMail size={17} />
                </a>
                {share.link_url !== null && (
                  <button
                    type="button"
                    className="social rotate"
                    disabled={busy}
                    onClick={() => void rotate()}
                    title="Replace the link"
                    aria-label="Replace the link"
                  >
                    <IconRotate size={16} />
                  </button>
                )}
              </div>
            </section>

            <section className="share-section">
              <h3>Invite someone</h3>

              <div className="invite-row">
                <input
                  type="email"
                  className="invite-email"
                  placeholder="name@example.com"
                  aria-label="Email address"
                  value={email}
                  disabled={busy}
                  onChange={(event) => setEmail(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      void invite()
                    }
                  }}
                />
                {/* The address gets the whole first line and what it grants gets the
                    second. Three controls abreast left the email field the narrowest
                    thing on the row, and an email field too short to show an email is
                    the one field in this dialog that cannot afford it. */}
                <div className="invite-terms">
                  <div className="segmented" role="radiogroup" aria-label="What they get">
                    {SHAREABLE.map((option) => (
                      <button
                        key={option.id}
                        type="button"
                        role="radio"
                        aria-checked={inviteRole === option.id}
                        className={inviteRole === option.id ? 'active' : ''}
                        disabled={busy}
                        onClick={() => setInviteRole(option.id)}
                      >
                        <option.Icon size={14} />
                        {option.label}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    className="primary"
                    disabled={busy || email.trim() === ''}
                    onClick={() => void invite()}
                  >
                    Invite
                  </button>
                </div>
              </div>

              {result?.status === 'pending' && result.link !== null && (
                <div className="invite-pending" role="status">
                  <p>
                    <strong>{result.email}</strong> has no Meadow account yet, so nothing
                    was emailed. Send them this link yourself - it takes them to
                    registration, and the {noun} is waiting once they finish.
                  </p>
                  <CopyRow value={result.link} label="Invitation link" />
                </div>
              )}
            </section>

            <section className="share-section">
              <h3>People with access</h3>

              <ul className="people">
                {share.members.map((member) => (
                  <li key={member.user_id} className="person">
                    <Avatar name={member.display_name} url={member.avatar_url} />
                    <span className="person-who">
                      <strong>{member.display_name}</strong>
                      <small>{member.email}</small>
                    </span>

                    {member.role === 'owner' ? (
                      // No control at all rather than a disabled one. An owner cannot
                      // be demoted here, and a greyed-out dropdown invites the click
                      // that proves it.
                      <span className="role role-owner">Owner</span>
                    ) : (
                      <>
                        <select
                          className="person-role"
                          aria-label={`Access for ${member.display_name}`}
                          value={member.role}
                          disabled={busy}
                          onChange={(event) =>
                            void changeRole(member.user_id, event.target.value as BoardRole)
                          }
                        >
                          <option value="viewer">Can view</option>
                          <option value="editor">Can edit</option>
                        </select>
                        <button
                          type="button"
                          className="icon ghost"
                          disabled={busy}
                          title={`Remove ${member.display_name}`}
                          aria-label={`Remove ${member.display_name}`}
                          onClick={() =>
                            void removeMember(member.user_id, member.display_name)
                          }
                        >
                          <IconTrash size={15} />
                        </button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            </section>

            {share.invitations.length > 0 && (
              <section className="share-section">
                <h3>Waiting to join</h3>
                <p className="share-note">
                  No account at these addresses yet, and nothing was emailed to them.
                  Each link is the only copy - pass it on however you normally reach
                  them.
                </p>

                <ul className="people">
                  {share.invitations.map((invitation) => (
                    <li key={invitation.id} className="person pending">
                      <span className="person-who">
                        <strong>{invitation.email}</strong>
                        <small>
                          {invitation.role === 'editor' ? 'Can edit' : 'Can view'} once they
                          register
                        </small>
                      </span>
                      <CopyRow value={invitation.link} label="Invitation link" />
                      <button
                        type="button"
                        className="icon ghost"
                        disabled={busy}
                        title="Withdraw this invitation"
                        aria-label={`Withdraw the invitation to ${invitation.email}`}
                        onClick={() => void revoke(invitation.id)}
                      >
                        <IconTrash size={15} />
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" className="primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </dialog>
  )
}

