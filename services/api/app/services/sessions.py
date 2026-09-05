"""The signed-in-browsers list, and ending one of them.

A session here is a refresh-token *family*. That is not a new concept invented for this
screen - it is what the rotation lineage has always been. One browser signs in once,
gets a family, and rotates within it for as long as it stays signed in; logging out
revokes the family; a second browser gets a second family. So "where am I signed in?"
is answered by asking which families still have a live token, and no second notion of
a session had to be introduced beside the one that already governs access.

`family_started_at` is carried forward by every rotation, which is what lets a single
live row answer the whole question: signed in then, last renewed at `created_at`, from
this user agent and this address.
"""

import uuid
from datetime import UTC, datetime

from fastapi import Request
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import hash_refresh_token
from app.config import settings
from app.models import RefreshToken
from app.schemas.auth import SessionOut
from app.services.useragent import parse as parse_user_agent


async def current_family_id(db: AsyncSession, request: Request) -> uuid.UUID | None:
    """Which family the caller's own browser is holding, from the refresh cookie.

    The access token cannot answer this. It is deliberately family-blind (see
    `auth/tokens.py`) and adding a lineage claim to it would put a session identifier
    into a credential that is handed to every endpoint. The cookie is already scoped to
    `/api/v1/auth`, which is where these routes live, so it arrives here on its own.

    Read only, never rotated: marking the current session must not race the app's own
    refresh, and this is a question about the session rather than a use of it.
    """
    raw = request.cookies.get(settings.refresh_cookie_name)
    if raw is None:
        return None
    row = (
        await db.execute(
            select(RefreshToken).where(RefreshToken.token_hash == hash_refresh_token(raw))
        )
    ).scalar_one_or_none()
    if row is None or row.revoked_at is not None:
        return None
    return row.family_id


async def list_for_user(
    db: AsyncSession, user_id: uuid.UUID, current: uuid.UUID | None
) -> list[SessionOut]:
    """Every browser still signed in to this account, most recently active first.

    Rotation revokes the row it replaces, so a family has one live token and the
    de-duplication below is belt and braces rather than load-bearing. It is here
    because a duplicate would otherwise draw the same browser twice, which reads as
    somebody else being signed in.
    """
    now = datetime.now(UTC)
    rows = (
        await db.execute(
            select(RefreshToken)
            .where(
                RefreshToken.user_id == user_id,
                RefreshToken.revoked_at.is_(None),
                RefreshToken.expires_at > now,
            )
            .order_by(RefreshToken.created_at.desc())
        )
    ).scalars()

    out: list[SessionOut] = []
    seen: set[uuid.UUID] = set()
    for row in rows:
        if row.family_id in seen:
            continue
        seen.add(row.family_id)
        client = parse_user_agent(row.user_agent)
        out.append(
            SessionOut(
                id=row.family_id,
                current=row.family_id == current,
                browser=client.browser,
                os=client.os,
                device=client.device,
                label=client.label(),
                user_agent=row.user_agent,
                ip=str(row.ip) if row.ip is not None else None,
                signed_in_at=row.family_started_at,
                last_active_at=row.created_at,
                expires_at=row.expires_at,
            )
        )
    return out


async def revoke(db: AsyncSession, user_id: uuid.UUID, family_id: uuid.UUID) -> bool:
    """End one session. False if the caller does not own a live one with that id.

    Scoped to `user_id` in the statement rather than checked first: this is the one
    place a user names somebody else's identifier, so the ownership test belongs in the
    same query as the write and not in a branch above it.
    """
    revoked = (
        (
            await db.execute(
                update(RefreshToken)
                .where(
                    RefreshToken.user_id == user_id,
                    RefreshToken.family_id == family_id,
                    RefreshToken.revoked_at.is_(None),
                )
                .values(revoked_at=datetime.now(UTC))
                # RETURNING rather than a row count, so "did anything match" is answered by
                # the statement itself and not by a driver attribute.
                .returning(RefreshToken.id)
            )
        )
        .scalars()
        .all()
    )
    await db.commit()
    return len(revoked) > 0


async def revoke_others(db: AsyncSession, user_id: uuid.UUID, keep: uuid.UUID | None) -> int:
    """Sign out everywhere else. Returns how many sessions ended.

    The count is of families, not tokens: a family has one live token, but saying "3
    tokens revoked" to somebody who pressed a button labelled "sign out everywhere
    else" would be answering a different question.
    """
    now = datetime.now(UTC)
    doomed = select(RefreshToken.family_id).where(
        RefreshToken.user_id == user_id,
        RefreshToken.revoked_at.is_(None),
        RefreshToken.expires_at > now,
    )
    if keep is not None:
        doomed = doomed.where(RefreshToken.family_id != keep)
    families = set((await db.execute(doomed)).scalars())
    if not families:
        return 0

    await db.execute(
        update(RefreshToken)
        .where(
            RefreshToken.user_id == user_id,
            RefreshToken.family_id.in_(families),
            RefreshToken.revoked_at.is_(None),
        )
        .values(revoked_at=now)
    )
    await db.commit()
    return len(families)
