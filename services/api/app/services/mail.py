"""Sending mail, and the one message this app sends.

Stdlib `smtplib` on a worker thread rather than an async SMTP client. The volume is one
message per registration, the thread is released the moment the relay answers, and the
alternative was a dependency whose only job would be to avoid this file's ten lines of
`to_thread`.

Every message goes out as `multipart/alternative`. A mail client that refuses HTML, a
screen reader, and a plain-text archive all get a version that says the same thing, and
the link is visible as text in both - a button whose destination cannot be read is
exactly what a phishing mail looks like.
"""

import smtplib
from email.message import EmailMessage
from email.utils import formataddr
from logging import getLogger

import anyio

from app.config import settings
from app.services.mail_templates import LOGO_CID, LOGO_PATH

logger = getLogger(__name__)

_LOGO_BYTES = LOGO_PATH.read_bytes()


class MailError(Exception):
    """The relay refused, or could not be reached."""


def _send_blocking(message: EmailMessage) -> None:
    timeout = settings.smtp_timeout_seconds
    if settings.smtp_ssl:
        server: smtplib.SMTP = smtplib.SMTP_SSL(
            settings.smtp_host, settings.smtp_port, timeout=timeout
        )
    else:
        server = smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=timeout)
    try:
        if settings.smtp_starttls and not settings.smtp_ssl:
            # One of TLS or STARTTLS is always on. Submitting a password in the clear
            # would hand the mailbox to anyone on the path.
            server.starttls()
        if settings.smtp_user:
            server.login(settings.smtp_user, settings.smtp_password.get_secret_value())
        server.send_message(message)
    finally:
        server.quit()


async def send(*, to: str, subject: str, text: str, html: str) -> None:
    """Deliver one message, or raise `MailError`.

    The caller decides what a failure means. For a registration it means the account is
    left unactivated and the person is told to ask for the link again, which is better
    than either losing the registration or claiming a mail was sent that was not.
    """
    if not settings.mail_enabled:
        raise MailError("no smtp host configured")

    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((settings.smtp_from_name, settings.smtp_from))
    message["To"] = to
    message.set_content(text)
    message.add_alternative(html, subtype="html")
    html_part = message.get_payload(1)
    assert isinstance(html_part, EmailMessage)  # the alternative just added, by construction
    html_part.add_related(_LOGO_BYTES, "image", "png", cid=f"<{LOGO_CID}>")

    try:
        await anyio.to_thread.run_sync(_send_blocking, message)
    except (OSError, smtplib.SMTPException) as exc:
        # The address is not logged with the failure: a bounce log that pairs addresses
        # with "this person just registered" is a list worth stealing.
        logger.warning("could not send mail: %s", exc)
        raise MailError(str(exc)) from exc
