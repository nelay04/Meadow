"""Keeping `board_texts` in step with what is written on each board.

A cron pass every minute rather than a job per edit. An edit arrives as one row in
`board_updates` per keystroke burst, and a job each would read and merge the whole
board dozens of times a minute to produce the same text. The pass asks one question of
the database instead - which boards changed since they were last read - and reads only
those, so an idle deployment does one cheap query a minute and a busy board is read at
most once.

Staleness is judged by timestamps rather than update ids, and it is the snapshot's as
well as the log's: compaction deletes the rows an edit arrived in and writes their
content into a snapshot, so a board whose last edit was folded before this pass reached
it shows only as a new snapshot.

A board with a password is skipped and its row removed. Its contents are what the
password holds back, so they are not copied anywhere a search could reach them.
"""

import uuid
from datetime import datetime, timedelta
from logging import getLogger
from typing import Any

from pycrdt import merge_updates
from sqlalchemy import delete, exists, func, or_, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.models import Board, BoardSnapshot, BoardText, BoardUpdate
from app.services.board_text import board_text

logger = getLogger("meadow.worker")

# Boards read per batch, and batches per pass. Enough to backfill a deployment's
# existing boards in a few minutes without holding the worker for longer than that.
BATCH_SIZE = 50
MAX_BATCHES = 6

# `indexed_at` is stamped this far before the read began. An update's `created_at` is
# the start of the transaction that wrote it, so one that began just before the read and
# committed just after is not in what was read but is older than the read. Without the
# margin it would look indexed and stay missing until the board was next edited. With it,
# a board edited in the last two seconds is read once more on the next pass. Two is
# ample: the write it covers is a single-row insert that commits in milliseconds.
STAMP_MARGIN = timedelta(seconds=2)


async def _stale_boards(session: AsyncSession, limit: int) -> list[uuid.UUID]:
    never = BoardText.indexed_at.is_(None)
    query = (
        select(Board.id)
        .outerjoin(BoardText, BoardText.board_id == Board.id)
        .where(
            Board.deleted_at.is_(None),
            Board.password_hash.is_(None),
            or_(
                exists().where(
                    BoardUpdate.board_id == Board.id,
                    or_(never, BoardUpdate.created_at > BoardText.indexed_at),
                ),
                exists().where(
                    BoardSnapshot.board_id == Board.id,
                    or_(never, BoardSnapshot.created_at > BoardText.indexed_at),
                ),
            ),
        )
        .limit(limit)
    )
    return list((await session.execute(query)).scalars())


async def index_board(session: AsyncSession, board_id: uuid.UUID) -> bool:
    """Read one board's document and rewrite its row.

    The board row is held with a share lock while this runs, and its password is read
    under that lock. Setting a password updates the same row, so it waits for this to
    commit and then removes what was written; and if it committed first, this sees the
    password and writes nothing. Without the lock a pass that picked the board before
    the password was set could put its contents back a moment after they were removed.
    """
    guard = (
        await session.execute(
            select(Board.password_hash, Board.deleted_at)
            .where(Board.id == board_id)
            .with_for_update(read=True)
        )
    ).one_or_none()
    if guard is None or guard.password_hash is not None or guard.deleted_at is not None:
        return False

    started: datetime = (await session.execute(select(func.clock_timestamp()))).scalar_one()

    snapshot = (
        await session.execute(
            select(BoardSnapshot.state)
            .where(BoardSnapshot.board_id == board_id)
            .order_by(BoardSnapshot.created_at.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    updates = list(
        (
            await session.execute(
                select(BoardUpdate.update)
                .where(BoardUpdate.board_id == board_id)
                .order_by(BoardUpdate.id)
            )
        ).scalars()
    )
    payloads = ([snapshot] if snapshot is not None else []) + updates
    body = board_text(merge_updates(*payloads)) if payloads else ""

    stamp = started - STAMP_MARGIN
    await session.execute(
        insert(BoardText)
        .values(board_id=board_id, body=body, indexed_at=stamp)
        .on_conflict_do_update(
            index_elements=[BoardText.board_id], set_={"body": body, "indexed_at": stamp}
        )
    )
    return True


async def index_stale_boards(factory: async_sessionmaker[AsyncSession]) -> int:
    """Bring every changed board's row up to date. Returns how many were read."""
    async with factory() as session, session.begin():
        # Belt and braces for the password: the route that sets one removes the row,
        # and this catches a password set any other way.
        await session.execute(
            delete(BoardText).where(
                BoardText.board_id.in_(
                    select(Board.id).where(Board.password_hash.is_not(None))
                )
            )
        )

    read = 0
    for _ in range(MAX_BATCHES):
        async with factory() as session:
            stale = await _stale_boards(session, BATCH_SIZE)
        for board_id in stale:
            # One transaction per board, so a board whose document will not merge costs
            # its own row and not the rest of the batch. It stays stale and is tried
            # again next pass, which is where the log line will keep pointing.
            try:
                async with factory() as session, session.begin():
                    if await index_board(session, board_id):
                        read += 1
            except Exception:
                logger.exception("could not index the text of board %s", board_id)
        if len(stale) < BATCH_SIZE:
            break
    return read


async def index_search(ctx: dict[str, Any]) -> int:
    """The cron entry point."""
    from app.workers.compaction import _session_factory

    read = await index_stale_boards(_session_factory(ctx))
    if read:
        ctx["logger"].info("indexed the text of %d board(s)", read)
    return read
