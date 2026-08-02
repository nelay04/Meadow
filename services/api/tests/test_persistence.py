"""Durability of the CRDT log, and the compaction transaction from ARCHITECTURE 3."""

import asyncio
import uuid

import asyncpg
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient

from tests.conftest import TEST_DATABASE_URL, Actor, _asyncpg_dsn
from tests.wsclient import board_objects, write_object


def compact(board_id: str) -> int:
    """Run compaction the way the M5 worker will: its own loop, its own engine.

    The API's engine is bound to the TestClient's event loop, and an asyncpg pool
    cannot be shared across loops.
    """
    from app.realtime.ystore import compact_board

    async def run() -> int:
        engine = create_async_engine(TEST_DATABASE_URL)
        try:
            return await compact_board(uuid.UUID(board_id), async_sessionmaker(engine))
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _count_updates(board_id: str) -> int:
    async def run() -> int:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            value: int = await conn.fetchval(
                "select count(*) from board_updates where board_id = $1", uuid.UUID(board_id)
            )
            return value
        finally:
            await conn.close()

    return asyncio.run(run())


def test_last_client_disconnect_persists_the_update(client: TestClient, owner: Actor) -> None:
    """A write followed immediately by a disconnect must survive.

    This is the regression test for the cancellation race in PostgresYStore.write.
    YRoom spawns the store write on the room's task group, and stopping the room -
    which auto_clean_rooms does the moment the last client leaves - cancels that group
    without waiting. Without the shield in `write`, this test finds zero rows.

    It is the ordinary case, not an exotic one: a user makes an edit and closes the
    tab. ARCHITECTURE 6 requires persistence on last-client-disconnect precisely here.
    """
    board_id = owner.create_board()
    write_object(client, owner, board_id, alpha={"id": "alpha", "type": "rect"})

    assert _count_updates(board_id) > 0, "update lost between the last write and disconnect"
    assert "alpha" in board_objects(client, owner, board_id)


def test_state_reloads_from_postgres_after_room_eviction(
    client: TestClient, owner: Actor
) -> None:
    """Second connection must rebuild from the database, not from a cached room."""
    board_id = owner.create_board()
    write_object(client, owner, board_id, alpha={"id": "alpha", "type": "rect"})

    from app.main import app

    # auto_clean_rooms evicts on last disconnect, so the room is already gone and the
    # read below can only come from board_updates / board_snapshots.
    assert board_id not in app.state.ws_server.rooms

    assert set(board_objects(client, owner, board_id)) == {"alpha"}


def test_compaction_folds_updates_without_losing_any(client: TestClient, owner: Actor) -> None:
    """Compaction replaces the log with a snapshot and the document is unchanged.

    Also asserts the read path does not filter by `up_to_update_id`: after compaction
    the surviving rows are exactly what the snapshot lacks, and a watermark filter is
    the data-loss bug ARCHITECTURE 3 spends a page on.
    """
    board_id = owner.create_board()
    for index in range(3):
        write_object(client, owner, board_id, **{f"obj{index}": {"id": f"obj{index}"}})

    assert _count_updates(board_id) >= 3

    folded = compact(board_id)
    assert folded >= 3
    assert _count_updates(board_id) == 0, "compaction must delete exactly the rows it folded"

    assert set(board_objects(client, owner, board_id)) == {"obj0", "obj1", "obj2"}

    # A second run has nothing to do. Re-snapshotting an empty log every night would
    # grow board_snapshots without bound.
    assert compact(board_id) == 0


def test_updates_after_compaction_are_kept(client: TestClient, owner: Actor) -> None:
    """A write landing after a snapshot must survive the next load."""
    board_id = owner.create_board()
    write_object(client, owner, board_id, before={"id": "before"})
    compact(board_id)

    write_object(client, owner, board_id, after={"id": "after"})

    assert set(board_objects(client, owner, board_id)) == {"before", "after"}
