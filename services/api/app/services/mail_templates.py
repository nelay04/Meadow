"""The messages this app sends, as (subject, text, html).

Built here as strings rather than through a template engine: there is one message, it
has three substitutions, and a dependency whose job is to interpolate three values is a
dependency to keep updated for no return.

Email is not the web. The CSS lives in `style` attributes because Gmail strips a
`<style>` block, the layout is a table because Outlook's engine is Word's, and the
palette is the light theme's tokens copied as hex - a mail client has no
`light-dark()`, no custom properties, and no idea what theme the reader keeps.
"""

from html import escape

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

# Inter first, then what each platform actually has. No webfont: a mail client either
# ignores @font-face or asks the reader's permission to load it.
_FONT = (
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
)

# The project's code face first, then whatever the reader's mail client can find. A URL
# is the one thing in here that is read character by character.
_MONO = "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"


def _shell(*, heading: str, body: str, action: str, link: str, footer: str) -> str:
    """The one layout both messages use. Extracted at the second message, not the first."""
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
                <div style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:{_FG};">
                  Meadow
                </div>
                <div style="font-size:13px;color:{_MUTED};padding-top:2px;">
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
                          font-family:{_FONT};font-size:15px;font-weight:600;
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
