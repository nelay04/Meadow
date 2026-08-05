"""Snapshot compaction, scheduled.

ARCHITECTURE 3 is blunt about why this exists: Yjs update logs grow without bound and
will fill the VPS disk. Every edit appends a row, a busy board produces one per
keystroke, and nothing else ever removes them.

The fold itself lives in `realtime/ystore.py::compact_board`, next to the read path it
has to stay consistent with. This module is only about *when* it runs.

Two entry points, deliberately:

- `sweep_boards`, a cron job, finds boards whose log has grown past the threshold and
  enqueues one job each. Enqueuing rather than folding inline keeps one enormous board
  from blocking every other board's turn.
- `compact_board_job` folds a single board. Safe to run concurrently with itself and
  with live edits; the advisory lock and the transaction shape in `compact_board` are
  what make that true, not anything here.
"""

import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.config import settings
from app.models import BoardUpdate
from app.realtime.ystore import compact_board

# Below this, folding costs more than it saves: the snapshot row is full document
# state, so compacting a board with five updates replaces five small rows with one
# large one.
COMPACTION_THRESHOLD = 200

# Boards enqueued per sweep. A cap rather than everything at once, so a backlog is
# worked through over several ticks instead of flooding the queue in one.
SWEEP_LIMIT = 50


def _session_factory(ctx: dict[str, Any]) -> async_sessionmaker[AsyncSession]:
    """The worker's own engine, not the API's.

    An asyncpg pool belongs to the event loop that created it. arq runs jobs on its own
    loop, so reusing `app.db.SessionLocal` here works right up until it deadlocks under
    load, which is the worst way for it to fail.
    """
    factory = ctx.get("session_factory")
    if factory is None:
        raise RuntimeError("worker context is missing its session factory")
    return factory  # type: ignore[no-any-return]


async def compact_board_job(ctx: dict[str, Any], board_id: str) -> int:
    """Fold one board's update log into a snapshot. Returns rows folded."""
    folded = await compact_board(uuid.UUID(board_id), session_factory=_session_factory(ctx))
    if folded:
        ctx["logger"].info("compacted board %s, folded %d updates", board_id, folded)
    return folded


async def sweep_boards(ctx: dict[str, Any]) -> int:
    """Enqueue compaction for every board whose log has grown too long.

    Counts per board in one grouped query rather than per board in a loop, because the
    sweep runs on a timer against every board that has ever been edited and a
    per-board round trip would dominate it.
    """
    factory = _session_factory(ctx)

    async with factory() as session:
        rows = (
            await session.execute(
                select(BoardUpdate.board_id, func.count(BoardUpdate.id).label("updates"))
                .group_by(BoardUpdate.board_id)
                .having(func.count(BoardUpdate.id) >= COMPACTION_THRESHOLD)
                .order_by(func.count(BoardUpdate.id).desc())
                .limit(SWEEP_LIMIT)
            )
        ).all()

    redis = ctx.get("redis")
    for board_id, updates in rows:
        ctx["logger"].info("queueing compaction for board %s (%d updates)", board_id, updates)
        if redis is not None:
            # A per-board job id, so a board already queued from the previous tick is
            # not queued twice. arq drops a duplicate id rather than running it again.
            await redis.enqueue_job(
                "compact_board_job", str(board_id), _job_id=f"compact:{board_id}"
            )

    return len(rows)


async def on_startup(ctx: dict[str, Any]) -> None:
    engine = create_async_engine(settings.database_url, pool_pre_ping=True)
    ctx["engine"] = engine
    ctx["session_factory"] = async_sessionmaker(engine, expire_on_commit=False)


async def on_shutdown(ctx: dict[str, Any]) -> None:
    engine = ctx.get("engine")
    if engine is not None:
        await engine.dispose()
