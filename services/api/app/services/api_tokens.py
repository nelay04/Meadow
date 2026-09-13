"""Personal access tokens: issuing, authenticating and revoking them.

A token is its owner, narrowed. It never carries a role and never grants one: a route
that accepts a token resolves access through `app/services/permissions.py` exactly as it
would for a session, and the token can only take away from the answer - writing, through
`scope`, and every board it does not name, through `board_ids`.

Where a token is accepted is decided by the route, not by this module, and the default
is no. `app/auth/deps.py::current_user` refuses a token outright; only routes that ask
for `CurrentPrincipal` see one. That list is short on purpose (listing and reading
boards, creating one, minting a ws-token, reading your own profile), so a route added
later is unreachable by a leaked token until somebody decides otherwise.

Token management is not on it. A token cannot mint, list or revoke tokens, and cannot
end sessions: a stolen one must not be a way to make itself permanent or to lock its
owner out.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApiToken

#: What every raw token starts with. Recognisable on purpose: secret scanners on GitHub
#: and elsewhere match on a prefix, and a leaked token that looks like any other random
#: string is one nobody is told about.
TOKEN_PREFIX = "mdw_"

#: How much of the raw token is kept in the clear, prefix included, so a list of tokens
#: can say which is which. Eight random characters identify a token among one person's
#: handful and are no help at all in guessing the rest of it.
DISPLAY_LENGTH = len(TOKEN_PREFIX) + 8

#: A ceiling on live tokens per account. Generous for real use (one per machine or
#: agent) and low enough that a script minting in a loop is a mistake that stops.
MAX_LIVE_TOKENS = 25

#: `last_used_at` is rewritten at most this often. Every request through a token would
#: otherwise be a write, and the profile page only needs to say "used today".
_TOUCH_INTERVAL = timedelta(minutes=1)


class TokenScope(StrEnum):
    read = "read"
    write = "write"


@dataclass(frozen=True)
class IssuedToken:
    row: ApiToken
    #: The raw secret. Returned to the caller once, at issue, and never stored.
    raw: str


def hash_token(raw: str) -> str:
    # Plain sha256 for the reason refresh tokens use it: the input is 256 random bits,
    # so there is nothing a slow hash would protect.
    return hashlib.sha256(raw.encode()).hexdigest()


def looks_like_token(credential: str) -> bool:
    return credential.startswith(TOKEN_PREFIX)


def is_live(token: ApiToken, now: datetime | None = None) -> bool:
    now = now or datetime.now(UTC)
    if token.revoked_at is not None:
        return False
    return token.expires_at is None or token.expires_at > now


def allows_board(token: ApiToken, board_id: uuid.UUID) -> bool:
    return token.board_ids is None or board_id in token.board_ids


def is_read_only(token: ApiToken) -> bool:
    return token.scope != TokenScope.write


async def list_live(session: AsyncSession, user_id: uuid.UUID) -> list[ApiToken]:
    now = datetime.now(UTC)
    rows = (
        await session.execute(
            select(ApiToken)
            .where(ApiToken.user_id == user_id, ApiToken.revoked_at.is_(None))
            .order_by(ApiToken.created_at.desc())
        )
    ).scalars()
    return [row for row in rows if is_live(row, now)]


async def issue(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    name: str,
    scope: TokenScope,
    board_ids: list[uuid.UUID] | None,
    expires_in_days: int | None,
) -> IssuedToken:
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = ApiToken(
        user_id=user_id,
        name=name,
        token_hash=hash_token(raw),
        prefix=raw[:DISPLAY_LENGTH],
        scope=scope.value,
        board_ids=board_ids,
        expires_at=(
            None if expires_in_days is None else datetime.now(UTC) + timedelta(days=expires_in_days)
        ),
    )
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return IssuedToken(row=row, raw=raw)


async def authenticate(session: AsyncSession, raw: str) -> ApiToken | None:
    """The live token behind a raw value, or None. Records the use, lightly."""
    if not looks_like_token(raw):
        return None
    token = (
        await session.execute(select(ApiToken).where(ApiToken.token_hash == hash_token(raw)))
    ).scalar_one_or_none()
    if token is None or not is_live(token):
        return None

    now = datetime.now(UTC)
    if token.last_used_at is None or now - token.last_used_at > _TOUCH_INTERVAL:
        token.last_used_at = now
        await session.commit()
        await session.refresh(token)
    return token


async def load_live(
    session: AsyncSession, token_id: uuid.UUID, user_id: uuid.UUID
) -> ApiToken | None:
    """The token a ws-token was minted through, if it is still good.

    Scoped to the user as well as the id. A ws-token is signed, so the pair cannot be
    forged; asking for both anyway means a mistake elsewhere cannot hand one account's
    socket another account's token.
    """
    token = await session.get(ApiToken, token_id)
    if token is None or token.user_id != user_id or not is_live(token):
        return None
    return token


async def revoke(session: AsyncSession, user_id: uuid.UUID, token_id: uuid.UUID) -> bool:
    result = await session.execute(
        update(ApiToken)
        .where(
            ApiToken.id == token_id,
            ApiToken.user_id == user_id,
            ApiToken.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    await session.commit()
    return bool(getattr(result, "rowcount", 0))
