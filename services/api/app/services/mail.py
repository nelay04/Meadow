"""Sending mail, and the one seam every message in this app goes through.

Two ways out, chosen by `MEADOW_MAIL_PROVIDER`:

- `smtp` hands the message to a relay. Stdlib `smtplib` on a worker thread rather than
  an async SMTP client. The volume is one message per registration, the thread is
  released the moment the relay answers, and the alternative was a dependency whose only
  job would be to avoid this file's ten lines of `to_thread`.
- `resend` posts it to the Resend API over the `httpx` client this app already carries
  for the OAuth exchanges. The vendor SDK would do the same POST synchronously and cost
  another dependency plus another `to_thread`, so the request is written out here.

`send` is the only thing callers see, and it fails the same way whichever provider is
behind it - the caller decides what a failure means, and it should not have to know.

Every message goes out with both a plain-text and an HTML body. A mail client that
refuses HTML, a screen reader, and a plain-text archive all get a version that says the
same thing, and the link is visible as text in both - a button whose destination cannot
be read is exactly what a phishing mail looks like.

Neither provider attaches anything. The wordmark is linked from `settings.mail_logo_url`,
so both build the same two-part message and a reader cannot tell which one carried it.
"""

import smtplib
from email.message import EmailMessage
from email.utils import formataddr
from logging import getLogger

import anyio
import httpx

from app.config import settings

logger = getLogger(__name__)

_RESEND_ENDPOINT = "https://api.resend.com/emails"


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


async def _send_smtp(*, to: str, subject: str, text: str, html: str) -> None:
    message = EmailMessage()
    message["Subject"] = subject
    message["From"] = formataddr((settings.smtp_from_name, settings.smtp_from))
    message["To"] = to
    message.set_content(text)
    message.add_alternative(html, subtype="html")

    try:
        await anyio.to_thread.run_sync(_send_blocking, message)
    except (OSError, smtplib.SMTPException) as exc:
        raise MailError(str(exc)) from exc


async def _send_resend(*, to: str, subject: str, text: str, html: str) -> None:
    payload = {
        "from": formataddr((settings.resend_from_name, settings.resend_from)),
        "to": [to],
        "subject": subject,
        "text": text,
        "html": html,
    }
    headers = {"Authorization": f"Bearer {settings.resend_api_key.get_secret_value()}"}

    try:
        async with httpx.AsyncClient(timeout=settings.resend_timeout_seconds) as client:
            response = await client.post(_RESEND_ENDPOINT, json=payload, headers=headers)
    except httpx.HTTPError as exc:
        raise MailError(str(exc)) from exc

    if response.status_code >= 400:
        # Resend answers a refusal with a JSON body naming the reason - an unverified
        # sending domain, a dead key. That reason is the whole value of the log line, so
        # it is kept; the recipient is not, for the reason in `send`.
        raise MailError(f"resend returned {response.status_code}: {response.text[:200]}")


async def send(*, to: str, subject: str, text: str, html: str) -> None:
    """Deliver one message, or raise `MailError`.

    The caller decides what a failure means. For a registration it means the account is
    left unactivated and the person is told to ask for the link again, which is better
    than either losing the registration or claiming a mail was sent that was not.
    """
    if not settings.mail_enabled:
        raise MailError("no mail provider configured")

    provider = settings.mail_provider_name
    try:
        if provider == "resend":
            await _send_resend(to=to, subject=subject, text=text, html=html)
        else:
            await _send_smtp(to=to, subject=subject, text=text, html=html)
    except MailError as exc:
        # The address is not logged with the failure: a bounce log that pairs addresses
        # with "this person just registered" is a list worth stealing.
        logger.warning("could not send mail via %s: %s", provider, exc)
        raise
