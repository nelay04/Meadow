"""Links sent by email: activation, password reset, and redeeming either.

Two purposes, one mechanism. Both are a 256-bit random value stored as a sha256 digest,
single use, expiring, and both prove the same thing when they come back - that whoever
followed the link reads mail at that address. What differs is only what redeeming does,
so the purpose is a column rather than a second table, and it is checked on redemption:
an activation link cannot be spent at the password endpoint or the other way round.

Account activation, the original of the two:

A registration writes the account and stops there. The account holds the address, so
nobody else can register it, and it cannot be signed in to by any method until the
address answers. That is the whole point: the email is the account identity here - it is
what a GitHub or Google sign-in matches on - so an unconfirmed address is an identity
nobody has proved.

The link is a 256-bit random value, stored as a sha256 digest and single use, exactly
like a refresh token and for the same reasons. It is not a JWT: a signed token cannot be
spent, and "this link works once" is the property that matters most here.
"""

import hashlib
import secrets
from datetime import UTC, datetime, timedelta
from enum import Enum
from logging import getLogger

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import EmailVerification, User
from app.services import mail, sharing
from app.services.mail_templates import activation_mail, password_reset_mail

logger = getLogger(__name__)


ACTIVATION = "activation"
PASSWORD_RESET = "password_reset"


class Outcome(Enum):
    """Why a click on an activation link did or did not work."""

    activated = "activated"
    already_active = "already_active"
    invalid = "invalid"
    expired = "expired"


def _hash(raw: str) -> str:
    # Plain sha256, not a password KDF: this is a 256-bit random value, so there is
    # nothing to brute force and nothing to slow down.
    return hashlib.sha256(raw.encode()).hexdigest()


def activation_link(token: str) -> str:
    """The URL that goes in the mail.

    Points at the API rather than the SPA: the token is spent server-side, and a link
    that landed on a page first would put it in the browser history and the referrer of
    everything that page loads.
    """
    return f"{settings.web_base_url.rstrip('/')}/api/v1/auth/activate?token={token}"


async def issue(session: AsyncSession, user: User, purpose: str = ACTIVATION) -> str:
    """Mint a link of one purpose for this account, retiring any earlier one of it.

    Retiring matters: asking for a second mail because the first was slow should not
    leave two working keys to the same account lying in one inbox. Only links of the
    same purpose are retired - asking to reset a password should not quietly invalidate
    the activation link sitting above it in the same inbox.
    """
    await session.execute(
        update(EmailVerification)
        .where(
            EmailVerification.user_id == user.id,
            EmailVerification.purpose == purpose,
            EmailVerification.used_at.is_(None),
        )
        .values(used_at=datetime.now(UTC))
    )
    hours = (
        settings.activation_ttl_hours
        if purpose == ACTIVATION
        else settings.password_reset_ttl_hours
    )
    raw = secrets.token_urlsafe(32)
    session.add(
        EmailVerification(
            user_id=user.id,
            token_hash=_hash(raw),
            purpose=purpose,
            expires_at=datetime.now(UTC) + timedelta(hours=hours),
        )
    )
    return raw


async def send(session: AsyncSession, user: User) -> None:
    """Issue a link and mail it. Raises `MailError` if the relay would not take it."""
    token = await issue(session, user)
    await session.flush()
    subject, text, html = activation_mail(name=user.display_name, link=activation_link(token))
    await mail.send(to=user.email, subject=subject, text=text, html=html)


async def redeem(session: AsyncSession, raw: str) -> tuple[Outcome, User | None]:
    """Spend an activation link. Returns the outcome and the account it opened."""
    row = (
        await session.execute(
            select(EmailVerification).where(
                EmailVerification.token_hash == _hash(raw),
                EmailVerification.purpose == ACTIVATION,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return Outcome.invalid, None

    user = await session.get(User, row.user_id)
    if user is None:  # pragma: no cover - the FK cascades, so this cannot happen
        return Outcome.invalid, None

    if user.activated_at is not None:
        # A second click on the same mail, or a link retired by a newer one. The account
        # is open either way, so this is not a failure worth alarming anybody about.
        return Outcome.already_active, user

    if row.used_at is not None:
        return Outcome.invalid, None
    if row.expires_at <= datetime.now(UTC):
        return Outcome.expired, user

    row.used_at = datetime.now(UTC)
    user.activated_at = datetime.now(UTC)
    # The moment an account exists, so the moment any board invitation addressed to it
    # becomes a grant. Here rather than at the first sign-in, because an invitation is a
    # promise made to an *address* and this is where the address is proved: making
    # somebody also hunt down the original link would be asking them to prove it twice,
    # and the usual outcome of that is a board they were told about and cannot find.
    await sharing.apply_pending(session, user)
    return Outcome.activated, user


def reset_link(token: str) -> str:
    """Where a password reset link points.

    The app rather than the API, unlike activation: this one ends in a form, and only
    the browser can collect a new password. It goes in the fragment, so the token is
    never in a request line the server or a proxy could log.
    """
    return f"{settings.web_base_url.rstrip('/')}/#/reset/{token}"


async def send_password_reset(session: AsyncSession, user: User) -> None:
    """Issue a reset link and mail it. Raises `MailError` if the relay would not take it."""
    token = await issue(session, user, PASSWORD_RESET)
    await session.flush()
    subject, text, html = password_reset_mail(
        name=user.display_name, link=reset_link(token), has_password=user.password_hash is not None
    )
    await mail.send(to=user.email, subject=subject, text=text, html=html)


async def inspect_password_reset(
    session: AsyncSession, raw: str
) -> tuple[Outcome, User | None]:
    """Would this link work? Reads only, so the answer can be asked for twice."""
    return await _resolve_password_reset(session, raw, spend=False)


async def redeem_password_reset(session: AsyncSession, raw: str) -> tuple[Outcome, User | None]:
    """Spend a reset link, without changing anything else. The caller sets the password."""
    return await _resolve_password_reset(session, raw, spend=True)


async def _resolve_password_reset(
    session: AsyncSession, raw: str, *, spend: bool
) -> tuple[Outcome, User | None]:
    row = (
        await session.execute(
            select(EmailVerification).where(
                EmailVerification.token_hash == _hash(raw),
                EmailVerification.purpose == PASSWORD_RESET,
            )
        )
    ).scalar_one_or_none()
    if row is None:
        return Outcome.invalid, None

    user = await session.get(User, row.user_id)
    if user is None:  # pragma: no cover - the FK cascades, so this cannot happen
        return Outcome.invalid, None
    if row.used_at is not None:
        return Outcome.invalid, None
    if row.expires_at <= datetime.now(UTC):
        return Outcome.expired, user

    if spend:
        # Stamped here and nowhere else, so "used once" is one line in one place. The
        # caller commits, and a failed commit therefore leaves the link unspent rather
        # than burning it on a request that changed nothing.
        row.used_at = datetime.now(UTC)
    return Outcome.activated, user


async def activate_without_mail(session: AsyncSession, user: User) -> None:
    """Open the account immediately, for a deployment with no SMTP configured.

    A development machine that cannot send mail would otherwise produce accounts nobody
    can ever open. Loud on purpose: this is the one path where an address is trusted
    without answering, and a production deployment reaching it has a misconfiguration,
    not a feature.

    Takes the session because opening an account is opening an account: any board
    invitation waiting on this address applies here exactly as it does on the mailed
    path. A dev machine where invitations silently never land would be a feature that
    only works in production, which is the same as one nobody can test.
    """
    logger.warning(
        "no smtp configured: activating %s without confirming the address", user.id
    )
    user.activated_at = datetime.now(UTC)
    await sharing.apply_pending(session, user)
