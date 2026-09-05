"""The trash: how long a deleted board stays recoverable, and what emptying it means.

Deleting a glade or a lea moves it here rather than removing it. The row keeps its
place, its CRDT log, its snapshots, its members and its share link; what changes is
`boards.deleted_at`, which `resolve_role` refuses on, so the board is unreachable from
every route and from the websocket handshake at once. Restoring is that column going
back to null, and nothing else has to be put back because nothing was taken apart.

Two things end a stay here: the owner emptying it by hand, and the window running out.
Both go through `purge_board` below, so a permanent delete is one piece of code with
one meaning - the hard delete this app did on every delete before there was a trash.

The window is `settings.trash_retention_hours`, in hours rather than days because a
deployment wanting to watch the sweep work should not have to wait a day to see it,
and because the test suite has to. Zero is a legal value and means a delete is final
immediately: the pre-trash behaviour, kept reachable rather than special-cased.
"""

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Board


def retention() -> timedelta:
    """How long a deleted board is kept. Never negative, whatever the setting says."""
    return timedelta(hours=max(0, settings.trash_retention_hours))


def purge_after(deleted_at: datetime) -> datetime:
    """When this board stops being recoverable.

    Sent to the client so a card can say how long is left, and used by the sweep to
    decide. One function for both, so the countdown on screen and the deletion that
    ends it can never disagree by an hour.
    """
    # Rows written before this column was timezone-aware anywhere would compare
    # against an aware `now` and raise. Treat a naive timestamp as UTC, which is what
    # Postgres stored.
    at = deleted_at if deleted_at.tzinfo is not None else deleted_at.replace(tzinfo=UTC)
    return at + retention()


def expired(deleted_at: datetime, *, now: datetime | None = None) -> bool:
    return purge_after(deleted_at) <= (now or datetime.now(UTC))


async def purge_board(session: AsyncSession, board_id: uuid.UUID) -> None:
    """Delete a board for good. Updates, snapshots and grants cascade with it.

    Does not commit: the caller decides how much is one transaction, which is what lets
    the sweep purge a batch atomically.
    """
    await session.execute(delete(Board).where(Board.id == board_id))


async def expired_board_ids(
    session: AsyncSession, *, limit: int, now: datetime | None = None
) -> list[uuid.UUID]:
    """Boards whose window has passed, oldest deletion first.

    Ordered so a backlog is worked through in the order things were thrown away rather
    than in whatever order the index hands them back, and capped so one enormous
    backlog is several ticks of the sweep instead of one very long transaction.
    """
    cutoff = (now or datetime.now(UTC)) - retention()
    rows = await session.execute(
        select(Board.id)
        .where(Board.deleted_at.is_not(None), Board.deleted_at <= cutoff)
        .order_by(Board.deleted_at)
        .limit(limit)
    )
    return list(rows.scalars())
