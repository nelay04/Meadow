"""Emptying the trash, on a timer.

`app/services/trash.py` holds what the retention window means; this module is only
about when it is applied, the same split `compaction.py` makes. A board sits in the
trash with `deleted_at` set and is unreachable the whole time; when the window has
passed, the sweep does the hard delete that `DELETE /boards/{id}` used to do inline,
and the update log, snapshots, members and share links cascade away with the row.

Nothing here notifies anybody. A board whose window ran out has been invisible for the
whole of it, and there is no session holding it open to interrupt.
"""

from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.services.trash import expired_board_ids, purge_board

#: Boards purged per tick. A cap for the same reason the compaction sweep has one: a
#: backlog should be several quiet ticks rather than one transaction holding a
#: delete-cascade over hundreds of documents.
SWEEP_LIMIT = 50


def _session_factory(ctx: dict[str, Any]) -> async_sessionmaker[AsyncSession]:
    """The worker's own engine, from the context `on_startup` filled in.

    Deliberately not `app.db.SessionLocal`: an asyncpg pool belongs to the event loop
    that made it, and arq runs jobs on its own. See the longer note in
    `app/workers/compaction.py`.
    """
    factory = ctx.get("session_factory")
    if factory is None:
        raise RuntimeError("worker context is missing its session factory")
    return factory  # type: ignore[no-any-return]


async def sweep_trash(ctx: dict[str, Any]) -> int:
    """Purge every board whose stay in the trash has run out. Returns how many.

    One transaction for the batch. Either the whole tick's worth goes or none of it
    does, and a tick that fails leaves the rows to be found again by the next one -
    which is the safe direction for a job whose only effect is deletion.
    """
    async with _session_factory(ctx)() as session:
        doomed = await expired_board_ids(session, limit=SWEEP_LIMIT)
        for board_id in doomed:
            ctx["logger"].info("purging board %s from the trash", board_id)
            await purge_board(session, board_id)
        if doomed:
            await session.commit()

    return len(doomed)
