"""The messages this app sends, as (subject, text, html).

Built here as strings rather than through a template engine: each message has a
handful of substitutions and one shared layout, and a dependency whose job is to
interpolate a handful of values is a dependency to keep updated for no return.

Email is not the web. The CSS lives in `style` attributes because Gmail strips a
`<style>` block, the layout is a table because Outlook's engine is Word's, and the
palette is the light theme's tokens copied as hex - a mail client has no
`light-dark()`, no custom properties, and no idea what theme the reader keeps.
"""

from html import escape
from pathlib import Path

# `apps/web/src/styles.css`, light theme. Copied rather than imported, because these
# have to survive a client that supports almost nothing.
_BG = "#f4f1ec"
_SURFACE = "#fffefc"
_FG = "#1b1c1f"
_MUTED = "#6a6b73"
_LINE = "#e6e0d7"
_SURFACE_2 = "#faf7f2"
_ACCENT = "#0f6cbd"
_ACCENT_INK = "#ffffff"

# The app's tagline, under the wordmark, exactly as the login card and the page
# description carry it. A mail that introduces the product differently from the screen
# it links to reads as a mail from somewhere else.
_TAGLINE = "Think Beyond the horizon..."

# Embedded rather than linked: a mail client fetching a wordmark over HTTP means either
# `web_base_url` is publicly reachable (not true in local dev) or the client blocks
# remote images by default. Same file the SPA serves its own wordmark from
# (`apps/web/public/brand/meadow-wordmark.png`), copied here so the mail service does
# not depend on the web app's static host at send time.
LOGO_PATH = Path(__file__).parent.parent / "assets" / "meadow-wordmark.png"
LOGO_CID = "meadow-logo"

# Comic Neue first: it is the app's voice everywhere else (`apps/web/src/styles.css`),
# and a mail that greets someone in Inter before handing them a Comic Neue app reads as
# though it came from somewhere else. No webfont: a mail client either ignores
# @font-face or asks the reader's permission to load it, so this falls back through
# what each platform actually has, same chain the app's own CSS uses.
_FONT = (
    "'Comic Neue', 'Comic Sans MS', -apple-system, BlinkMacSystemFont, 'Segoe UI', "
    "Roboto, Helvetica, Arial, sans-serif"
)

# The project's code face first, then whatever the reader's mail client can find. A URL
# is the one thing in here that is read character by character.
_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"


def _shell(*, heading: str, body: str, action: str, link: str, footer: str) -> str:
    """The one layout every message here uses. Extracted at the second, not the first."""
    safe_link = escape(link, quote=True)
    return f"""\
<!doctype html>
<html lang="en">
  <body style="margin:0;padding:0;background:{_BG};">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
           style="background:{_BG};padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
                 style="max-width:520px;background:{_SURFACE};border:1px solid {_LINE};
                        border-radius:16px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 0;font-family:{_FONT};">
                <img src="cid:{LOGO_CID}" alt="Meadow" height="28"
                     style="height:28px;width:auto;display:block;border:0;" />
                <div style="font-size:13px;color:{_MUTED};padding-top:6px;">
                  {_TAGLINE}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 0;font-family:{_FONT};color:{_FG};font-size:15px;
                         line-height:1.6;">
                <p style="margin:0 0 12px;">{heading}</p>
                <p style="margin:0 0 12px;">{body}</p>
              </td>
            </tr>
            <tr>
              <td align="left" style="padding:22px 32px 2px;">
                <a href="{safe_link}"
                   style="display:inline-block;background:{_ACCENT};color:{_ACCENT_INK};
                          font-family:{_FONT};font-size:15px;font-weight:400;
                          text-decoration:none;padding:12px 22px;border-radius:10px;">
                  {action}
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px 0;font-family:{_FONT};">
                <!-- The destination in full, because a button whose target cannot be
                     read is what a phishing mail looks like. Boxed and set in mono so it
                     reads as a thing being quoted rather than as a sentence that has
                     come apart: a long token wrapped mid-word looks like damage. -->
                <div style="font-size:11px;color:{_MUTED};padding-bottom:6px;">
                  Button not working? Paste this link into your browser:
                </div>
                <div style="background:{_SURFACE_2};border:1px solid {_LINE};
                            border-radius:10px;padding:10px 12px;font-family:{_MONO};
                            font-size:11px;line-height:1.5;color:{_MUTED};
                            word-break:break-all;">
                  {safe_link}
                </div>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px 28px;font-family:{_FONT};color:{_MUTED};
                         font-size:12px;line-height:1.6;">
                {footer}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
"""


def activation_mail(*, name: str, link: str) -> tuple[str, str, str]:
    subject = "Activate your Meadow account"

    text = (
        f"Hi {name},\n\n"
        "Confirm this address to finish setting up your Meadow account:\n\n"
        f"{link}\n\n"
        "The link works once and expires in 24 hours. Until you use it, the account "
        "cannot be signed in to.\n\n"
        "If you did not create a Meadow account, ignore this message. Nothing was "
        "signed in to, and the account stays closed.\n\n"
        "Meadow"
    )

    html = _shell(
        heading=f"Hi {escape(name)},",
        body=(
            "Confirm this address to finish setting up your account. Until you do, it "
            "cannot be signed in to, with a password or with GitHub or Google."
        ),
        action="Activate my account",
        link=link,
        footer=(
            "The link works once and expires in 24 hours.<br />"
            "If you did not create a Meadow account, ignore this message. Nothing was "
            "signed in to, and the account stays closed."
        ),
    )

    return subject, text, html


def password_reset_mail(*, name: str, link: str, has_password: bool) -> tuple[str, str, str]:
    """The reset mail, which is also the "you have no password yet" mail.

    An account opened through GitHub or Google has no password at all, and the wording
    follows: setting a first one and replacing an existing one are the same request here,
    and calling it a *reset* to someone who never had one would be confusing.
    """
    verb = "Reset" if has_password else "Set"
    subject = f"{verb} your Meadow password"

    text = (
        f"Hi {name},\n\n"
        f"{verb} the password on your Meadow account:\n\n"
        f"{link}\n\n"
        "The link works once and expires in an hour. Using it signs out every device "
        "that is currently signed in to this account.\n\n"
        "If you did not ask for this, ignore this message. Your password has not "
        "changed and nothing has been signed in to.\n\n"
        "Meadow"
    )

    html = _shell(
        heading=f"Hi {escape(name)},",
        body=(
            f"{verb} the password on your account with the button below."
            if has_password
            else (
                "Your account signs in with GitHub or Google and has no password yet. "
                "Set one with the button below, and you will be able to sign in with "
                "your email address as well."
            )
        ),
        action=f"{verb} my password",
        link=link,
        footer=(
            "The link works once and expires in an hour. Using it signs out every "
            "device currently signed in to this account.<br />"
            "If you did not ask for this, ignore this message. Your password has not "
            "changed."
        ),
    )
    return subject, text, html


# What a role means to somebody who has just been handed one, as a verb phrase. The
# role name alone ("editor") is our word for a database enum; this is the sentence a
# person reads in an inbox and decides whether to click on.
_ROLE_VERB = {
    "editor": "edit it with you",
    "owner": "manage it with you",
    "commenter": "read it and leave comments",
    "viewer": "read it",
}

_ROLE_NOUN = {
    "editor": "edit",
    "owner": "full",
    "commenter": "comment",
    "viewer": "read-only",
}


def board_invite_mail(
    *, name: str, inviter: str, title: str, noun: str, role: str, link: str
) -> tuple[str, str, str]:
    """"So-and-so shared a glade with you."

    Sent only to an address that already has an account, because only then is the
    access real when the mail arrives: the grant is written before this goes out, so
    the button opens the board rather than starting a negotiation. An address with no
    account gets no mail at all - see `app/services/sharing.py` for why that restraint
    is deliberate - and the person doing the inviting is handed a link instead.

    The inviter is named in the subject. An invitation from a stranger's app is spam;
    an invitation from a person you know is a message, and which one it is has to be
    legible from the inbox list without opening anything.
    """
    verb = _ROLE_VERB.get(role, _ROLE_VERB["viewer"])
    subject = f"{inviter} shared \u201c{title}\u201d with you"

    text = (
        f"Hi {name},\n\n"
        f"{inviter} shared the {noun} \u201c{title}\u201d with you, so you can {verb}.\n\n"
        f"{link}\n\n"
        "It is already in your list of glades, so this link is a shortcut rather than "
        "something you have to use.\n\n"
        "Meadow"
    )

    html = _shell(
        heading=f"Hi {escape(name)},",
        body=(
            f"{escape(inviter)} shared the {escape(noun)} "
            f"\u201c{escape(title)}\u201d with you, so you can {verb}."
        ),
        action=f"Open this {escape(noun)}",
        link=link,
        footer=(
            "It is already in your list of glades, so this link is a shortcut rather "
            "than something you have to use.<br />"
            "If you were not expecting this, you can leave it alone. Nothing of yours "
            "was shared in return."
        ),
    )

    return subject, text, html


def board_role_changed_mail(
    *, name: str, actor: str, title: str, noun: str, role: str, link: str
) -> tuple[str, str, str]:
    """"Your access to this glade changed."

    Sent on both directions of a change, promotion and demotion alike. A demotion is
    the one that actually needs saying: finding out that you can no longer type into
    something you were working in yesterday, by trying to type into it, is the version
    of this that wastes somebody's afternoon.

    Not sent when nothing changed. The caller checks that, because it is the caller
    that knows what the role was before.
    """
    access = _ROLE_NOUN.get(role, _ROLE_NOUN["viewer"])
    subject = f"Your access to \u201c{title}\u201d changed"

    text = (
        f"Hi {name},\n\n"
        f"{actor} changed your access to the {noun} \u201c{title}\u201d. "
        f"You now have {access} access.\n\n"
        f"{link}\n\n"
        "Meadow"
    )

    html = _shell(
        heading=f"Hi {escape(name)},",
        body=(
            f"{escape(actor)} changed your access to the {escape(noun)} "
            f"\u201c{escape(title)}\u201d. You now have {access} access."
        ),
        action=f"Open this {escape(noun)}",
        link=link,
        footer=(
            "Anything you had already written is still there and still yours. A change "
            "of access changes what you can do next, never what has been done."
        ),
    )

    return subject, text, html


def board_access_request_mail(
    *, name: str, asker: str, asker_email: str, title: str, noun: str, role: str, link: str
) -> tuple[str, str, str]:
    """"Somebody is asking to be let in."

    The one mail in this file that is a question rather than an announcement, and the
    only reason it exists is that nobody watches a share dialog. A request nobody sees
    is a person waiting for an answer that is never coming, which is worse than the
    refusal they got before the feature existed.

    It names the address as well as the display name, and that is the load-bearing
    detail: the owner is being asked to recognise a person, display names are chosen
    freely, and a first name alone is not something anybody can act on. The button
    opens the board, where the share dialog holds the decision - nothing is granted or
    refused from inside a mail, because a link that changes access on click is a link
    that changes it when a mail client prefetches it.
    """
    wanted = _ROLE_VERB.get(role, _ROLE_VERB["viewer"])
    subject = f"{asker} is asking for access to \u201c{title}\u201d"

    text = (
        f"Hi {name},\n\n"
        f"{asker} ({asker_email}) asked for access to the {noun} "
        f"\u201c{title}\u201d, so they can {wanted}.\n\n"
        f"{link}\n\n"
        "Open the share dialog to let them in or turn them down. Nothing has changed "
        "until you do.\n\n"
        "Meadow"
    )

    html = _shell(
        heading=f"Hi {escape(name)},",
        body=(
            f"{escape(asker)} ({escape(asker_email)}) asked for access to the "
            f"{escape(noun)} \u201c{escape(title)}\u201d, so they can {wanted}."
        ),
        action=f"Open this {escape(noun)}",
        link=link,
        footer=(
            "The request is waiting in the share dialog. Nothing has changed until you "
            "decide, and turning it down tells them so without giving them anything."
        ),
    )

    return subject, text, html
