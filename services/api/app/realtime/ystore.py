"""Postgres-backed YStore.

pycrdt ships FileYStore and SQLiteYStore only, so this implements BaseYStore against
the board_updates / board_snapshots tables. See ARCHITECTURE 3 for why the read path
looks the way it does.
"""

import hashlib
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from logging import Logger, getLogger

import anyio
from pycrdt import merge_updates
from pycrdt.store import BaseYStore
from sqlalchemy import Integer, cast, delete, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.db import SessionLocal
from app.models import BoardSnapshot, BoardUpdate

# How many snapshots to retain per board after a compaction run. Each row is full
# document state, so keeping every one grows faster than the log it replaced. More
# than one is a hedge against a corrupt write.
SNAPSHOTS_RETAINED = 3

# Namespace for the two-int advisory lock form, so compaction's key space cannot
# collide with any other advisory lock added later. Any int4 works; this is "MEAD".
ADVISORY_LOCK_NAMESPACE = 0x4D454144


def compaction_lock_key(board_id: uuid.UUID) -> int:
    """Fold a board uuid into the int4 an advisory lock key has room for.

    Application-side rather than Postgres `hashtext`, which is an internal function
    with no cross-version stability guarantee. Collisions only cost two unrelated
    boards serialising against each other, but they are near-undiagnosable after the
    fact, so this hashes the full uuid instead of truncating it.
    """
    digest = hashlib.blake2b(board_id.bytes, digest_size=4).digest()
    return int.from_bytes(digest, "big", signed=True)


class PostgresYStore(BaseYStore):
    """One store instance per board. `path` is the board id."""

    def __init__(
        self,
        path: str,
        metadata_callback: Callable[[], Awaitable[bytes] | bytes] | None = None,
        log: Logger | None = None,
    ) -> None:
        self.path = path
        self.board_id = uuid.UUID(path)
        self.metadata_callback = metadata_callback
        self.log = log or getLogger(__name__)

    async def write(self, data: bytes) -> None:
        """Append one Yjs update. Never updates in place.

        Shielded from cancellation, and that is load-bearing rather than defensive.
        YRoom spawns this with `start_soon` on the *room's* task group, and
        `YRoom.stop()` cancels that group without waiting for its children. With
        auto_clean_rooms on, the last client leaving stops the room - so an update
        that arrived moments earlier races its own persistence and loses.

        That is the exact failure ARCHITECTURE 6 rules out with "always persist on
        last-client-disconnect": a user types, closes the tab, and the edit is gone on
        reload. The shield makes a started write run to completion regardless of who
        cancels the scope around it.

        Found by tests/test_persistence.py, which disconnects immediately after
        writing. It survived M0 only because real clients stayed connected long enough
        for the write to win the race.
        """
        with anyio.CancelScope(shield=True):
            async with SessionLocal() as session:
                session.add(BoardUpdate(board_id=self.board_id, update=data))
                await session.commit()

    async def read(self) -> AsyncIterator[tuple[bytes, bytes, float]]:
        """Yield the latest snapshot, then every surviving update row.

        There is deliberately no `id > up_to_update_id` filter. Compaction deletes
        exactly the rows it folded, so whatever survives is exactly what the snapshot
        does not contain. Filtering by a watermark strands rows that committed out of
        sequence order and loses them permanently.
        """
        async with SessionLocal() as session:
            snapshot = (
                await session.execute(
                    select(BoardSnapshot)
                    .where(BoardSnapshot.board_id == self.board_id)
                    .order_by(BoardSnapshot.created_at.desc())
                    .limit(1)
                )
            ).scalar_one_or_none()

            if snapshot is not None:
                yield snapshot.state, b"", snapshot.created_at.timestamp()

            rows = (
                await session.execute(
                    select(BoardUpdate)
                    .where(BoardUpdate.board_id == self.board_id)
                    .order_by(BoardUpdate.id)
                )
            ).scalars()

            for row in rows:
                yield row.update, b"", row.created_at.timestamp()


async def compact_board(
    board_id: uuid.UUID, session_factory: async_sessionmaker[AsyncSession] | None = None
) -> int:
    """Fold surviving updates into a new snapshot. Returns rows folded.

    Not scheduled until M5; exercised manually in M0 to prove the transaction shape.

    Serialised by a Postgres transaction-level advisory lock, per ARCHITECTURE 3: it
    releases on commit or rollback, so a worker killed mid-run cannot strand a board
    behind a TTL, and the lock lives in the same transaction as the work it guards.

    `session_factory` exists because this does not run inside the API process. From
    M5 it is an arq job with its own event loop and its own engine, and an asyncpg
    pool belongs to the loop that first used it. Defaults to the API's for the manual
    and test call paths.
    """
    factory = session_factory or SessionLocal
    async with factory() as session, session.begin():
        # Two-int form. Both arguments are int4, and asyncpg would otherwise send
        # Python ints as int8 and resolve to the single-bigint overload instead.
        await session.execute(
            select(
                func.pg_advisory_xact_lock(
                    cast(literal(ADVISORY_LOCK_NAMESPACE), Integer),
                    cast(literal(compaction_lock_key(board_id)), Integer),
                )
            )
        )

        rows = list(
            (
                await session.execute(
                    select(BoardUpdate)
                    .where(BoardUpdate.board_id == board_id)
                    .order_by(BoardUpdate.id)
                )
            ).scalars()
        )
        if not rows:
            return 0

        merged_ids = [row.id for row in rows]

        snapshot = (
            await session.execute(
                select(BoardSnapshot)
                .where(BoardSnapshot.board_id == board_id)
                .order_by(BoardSnapshot.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        payloads = [row.update for row in rows]
        if snapshot is not None:
            payloads.insert(0, snapshot.state)
        state = merge_updates(*payloads)

        # Insert before delete, in one transaction. A crash between them costs a
        # harmless duplicate re-apply; the reverse order loses updates.
        session.add(
            BoardSnapshot(
                board_id=board_id,
                state=state,
                up_to_update_id=max(merged_ids),
            )
        )
        await session.flush()

        await session.execute(
            delete(BoardUpdate).where(
                BoardUpdate.board_id == board_id,
                BoardUpdate.id.in_(merged_ids),
            )
        )

        keep = (
            select(BoardSnapshot.id)
            .where(BoardSnapshot.board_id == board_id)
            .order_by(BoardSnapshot.created_at.desc())
            .limit(SNAPSHOTS_RETAINED)
        )
        await session.execute(
            delete(BoardSnapshot).where(
                BoardSnapshot.board_id == board_id,
                BoardSnapshot.id.not_in(keep.scalar_subquery()),
            )
        )

        return len(merged_ids)
