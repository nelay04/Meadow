"""Personal access tokens: issuing, authenticating, changing and revoking them.

A token is its owner, narrowed. It never carries a role and never grants one: a route
that accepts a token resolves access through `app/services/permissions.py` exactly as it
would for a session, and the token can only take away from the answer.

Two kinds, as GitHub has them:

- **classic**: everything the owner can do, on every glade the owner can open.
- **fine-grained**: only the glades it names, each with its own permissions. Read comes
  with naming a glade; edit and delete are each on top of it. A glade it does not name
  answers exactly as a glade that does not exist. It may also be given `can_create`,
  which lets it make new glades; each one it makes is added to its own list with edit and
  delete, so it can work on what it made and still on nothing else.

Where a token is accepted is decided by the route, not by this module, and the default
is no. `app/auth/deps.py::current_user` refuses a token outright; only routes that ask
for `CurrentPrincipal` see one. That list is short on purpose (listing and reading
glades, creating one, minting a ws-token, reading your own profile, and a token reading
its own description), so a route added later is unreachable by a leaked token until
somebody decides otherwise.

Token management is not on it. A token cannot mint, list, change or revoke tokens, and
cannot end sessions: a stolen one must not be a way to make itself permanent, widen
itself, or lock its owner out.
"""

import hashlib
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum

from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import ApiToken, ApiTokenGrant, Board
from app.services.permissions import FULL_GRANT, TokenGrant

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

#: How many glades one fine-grained token may name.
MAX_GRANTS = 100

#: `last_used_at` is rewritten at most this often. Every request through a token would
#: otherwise be a write, and the profile page only needs to say "used today".
_TOUCH_INTERVAL = timedelta(minutes=1)


class TokenKind(StrEnum):
    classic = "classic"
    fine_grained = "fine_grained"


@dataclass(frozen=True)
class GrantSpec:
    """One glade a fine-grained token names, as it is asked for."""

    board_id: uuid.UUID
    edit: bool
    delete: bool


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


def is_classic(token: ApiToken) -> bool:
    return token.kind == TokenKind.classic


def can_create_glades(token: ApiToken) -> bool:
    """Whether this token may make a new glade.

    A classic token may, because it may do whatever its owner may. A fine-grained one may
    only when it was given the permission: making a glade adds it to the token's own
    list, and a token that widened itself without its owner ever agreeing to it would be
    a fine-grained token in name only.
    """
    return is_classic(token) or token.can_create


def grant_created(session: AsyncSession, token: ApiToken, board_id: uuid.UUID) -> None:
    """Give a fine-grained token full access to a glade it just made.

    Read, edit and delete: the token made this glade, so withholding any of them would
    leave it unable to fill in what it just asked for. It is the one way a token's list
    grows without its owner editing it, and it is bounded - `create_board` refuses once
    the list is full - so a token cannot grow its reach without limit by making glades.

    Committed by the caller, inside the transaction that creates the glade, so a glade
    made through a token is never left without the grant that opens it.
    """
    if is_classic(token):
        return
    session.add(
        ApiTokenGrant(token_id=token.id, board_id=board_id, can_edit=True, can_delete=True)
    )


async def grant_count(session: AsyncSession, token: ApiToken) -> int:
    return (
        await session.execute(
            select(func.count())
            .select_from(ApiTokenGrant)
            .where(ApiTokenGrant.token_id == token.id)
        )
    ).scalar_one()


async def grant_for(
    session: AsyncSession, token: ApiToken, board_id: uuid.UUID
) -> TokenGrant | None:
    """What this token may do on this glade before the role is applied, or None for nothing.

    None means the glade is not the token's to see, and every caller answers it the way
    it answers a glade that does not exist.
    """
    if is_classic(token):
        return FULL_GRANT
    row = await session.get(ApiTokenGrant, (token.id, board_id))
    if row is None:
        return None
    return TokenGrant(edit=row.can_edit, delete=row.can_delete)


async def grants_of(session: AsyncSession, token: ApiToken) -> dict[uuid.UUID, TokenGrant]:
    """Every glade a fine-grained token names. Empty for a classic token, which names none."""
    if is_classic(token):
        return {}
    rows = (
        await session.execute(select(ApiTokenGrant).where(ApiTokenGrant.token_id == token.id))
    ).scalars()
    return {row.board_id: TokenGrant(edit=row.can_edit, delete=row.can_delete) for row in rows}


async def grant_titles(
    session: AsyncSession, token_ids: list[uuid.UUID]
) -> dict[uuid.UUID, list[tuple[uuid.UUID, str, TokenGrant]]]:
    """Grants for several tokens at once, with each glade's title, in title order.

    One query for the whole token list rather than one per token. A glade in the trash is
    left out: it opens for nobody, so listing it as something a token may do would be a
    promise the handshake does not keep.
    """
    if not token_ids:
        return {}
    rows = await session.execute(
        select(ApiTokenGrant, Board.title)
        .join(Board, Board.id == ApiTokenGrant.board_id)
        .where(ApiTokenGrant.token_id.in_(token_ids), Board.deleted_at.is_(None))
        .order_by(Board.title, Board.id)
    )
    out: dict[uuid.UUID, list[tuple[uuid.UUID, str, TokenGrant]]] = {}
    for grant, title in rows.all():
        out.setdefault(grant.token_id, []).append(
            (grant.board_id, title, TokenGrant(edit=grant.can_edit, delete=grant.can_delete))
        )
    return out


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


def _grant_rows(token_id: uuid.UUID, grants: list[GrantSpec]) -> list[ApiTokenGrant]:
    return [
        ApiTokenGrant(
            token_id=token_id, board_id=grant.board_id, can_edit=grant.edit, can_delete=grant.delete
        )
        for grant in grants
    ]


async def issue(
    session: AsyncSession,
    *,
    user_id: uuid.UUID,
    name: str,
    kind: TokenKind,
    grants: list[GrantSpec],
    can_create: bool,
    expires_in_days: int | None,
) -> IssuedToken:
    raw = TOKEN_PREFIX + secrets.token_urlsafe(32)
    row = ApiToken(
        id=uuid.uuid4(),
        user_id=user_id,
        name=name,
        token_hash=hash_token(raw),
        prefix=raw[:DISPLAY_LENGTH],
        kind=kind.value,
        can_create=can_create,
        expires_at=(
            None if expires_in_days is None else datetime.now(UTC) + timedelta(days=expires_in_days)
        ),
    )
    session.add(row)
    # Flushed first: the grants' foreign key points at a row that has to exist.
    await session.flush()
    session.add_all(_grant_rows(row.id, grants))
    await session.commit()
    await session.refresh(row)
    return IssuedToken(row=row, raw=raw)


async def replace_grants(session: AsyncSession, token: ApiToken, grants: list[GrantSpec]) -> None:
    """Swap a fine-grained token's glades for a new set, in one transaction."""
    await session.execute(delete(ApiTokenGrant).where(ApiTokenGrant.token_id == token.id))
    session.add_all(_grant_rows(token.id, grants))
    await session.commit()


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


async def load_owned(
    session: AsyncSession, user_id: uuid.UUID, token_id: uuid.UUID
) -> ApiToken | None:
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
