"""Minting, setting and clearing the browser session.

Extracted from the auth router when GitHub sign-in arrived, because that flow ends in
a redirect rather than a JSON response and would otherwise have grown a second copy of
the rotation rules. There is one place that issues a session, and both the password
form and the OAuth callback go through it.
"""

import ipaddress
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import Request, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import create_access_token, hash_refresh_token, new_refresh_token
from app.config import settings
from app.models import RefreshToken, User
from app.schemas.auth import TokenPair

# The cookie is scoped to the auth routes: it is only ever presented to /refresh and
# /logout, so no other endpoint has any reason to receive the long-lived credential.
REFRESH_COOKIE_PATH = "/api/v1/auth"


def client_ip(request: Request) -> str | None:
    """The peer address, but only if it really is one.

    `ip` is an inet column, so anything unparseable fails the insert and takes the
    whole login with it. ASGI does not promise a numeric host - the test client sends
    a name, and a mangled proxy header would do the same in production. Audit metadata
    is never worth failing an auth request over.
    """
    if request.client is None:
        return None
    try:
        ipaddress.ip_address(request.client.host)
    except ValueError:
        return None
    return request.client.host


async def session_user(db: AsyncSession, request: Request) -> User | None:
    """Who is signed in, judged by the refresh cookie alone.

    For the one flow that leaves the site and comes back: connecting a provider from the
    profile page is a top-level navigation, so there is no access token to send in a
    header. The refresh cookie is presented, it is scoped to these routes already, and a
    live unrevoked one is exactly the proof "there is a session here" needs. It is only
    read, never rotated - rotating on a navigation would race the app's own refresh.
    """
    raw = request.cookies.get(settings.refresh_cookie_name)
    if raw is None:
        return None

    row = (
        await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw))
        )
    ).scalar_one_or_none()
    if row is None or row.revoked_at is not None or row.expires_at <= datetime.now(UTC):
        return None
    return await db.get(User, row.user_id)


def set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        settings.refresh_cookie_name,
        raw_token,
        max_age=settings.refresh_token_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        samesite="lax",
        path=REFRESH_COOKIE_PATH,
    )


def clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(settings.refresh_cookie_name, path=REFRESH_COOKIE_PATH)


async def issue_session(
    session: AsyncSession,
    response: Response,
    request: Request,
    user: User,
    family_id: uuid.UUID,
    family_started_at: datetime | None = None,
) -> TokenPair:
    """Mint an access token and a fresh refresh token in `family_id`'s lineage.

    `family_started_at` is when this browser signed in, and a rotation must pass the
    one off the token it is replacing. Omitting it leaves the column to its database
    default, which is right for a login and wrong for a refresh - a refresh that let it
    default would make every session look like it began fifteen minutes ago.

    Left to the default rather than set to `now` here on purpose: `created_at` is
    defaulted by the database too, and the sessions list compares the two. Timing one
    in Python and the other in Postgres made a session that had just signed in read as
    having done so after it was last active.
    """
    now = datetime.now(UTC)
    raw_refresh, token_hash = new_refresh_token()
    token = RefreshToken(
        user_id=user.id,
        token_hash=token_hash,
        family_id=family_id,
        expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        # Rewritten on every rotation rather than fixed at login: a browser that
        # updates itself is the same session, and the sessions list should say what it
        # is now rather than what it was a month ago.
        user_agent=request.headers.get("user-agent"),
        ip=client_ip(request),
    )
    if family_started_at is not None:
        token.family_started_at = family_started_at
    session.add(token)
    await session.commit()

    access_token, expires_at = create_access_token(user.id)
    set_refresh_cookie(response, raw_refresh)
    return TokenPair(
        access_token=access_token, expires_in=expires_at - int(datetime.now(UTC).timestamp())
    )
