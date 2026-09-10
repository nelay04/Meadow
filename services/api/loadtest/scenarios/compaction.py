"""Compaction throughput: how fast the update log folds, and how much it saves.

The third unmeasured row. ARCHITECTURE 3's reason for compaction is disk: every edit
appends a `board_updates` row, a busy board writes one per keystroke, and nothing else
ever removes them. The fold replaces the surviving rows with one snapshot.

So there are two numbers, and the compression ratio is the one that justifies the
feature while the rate is the one that says whether the worker can keep up:

* **ratio** - log bytes before over snapshot bytes after. Yjs updates carry structural
  overhead per update that the folded document does not, so a log of many small writes
  should collapse hard. If it does not, compaction is not paying for itself.
* **rate** - updates folded per second. The sweep enqueues a job per board past the
  threshold, so this bounds how many busy boards one worker can service per tick.

Measured against the real `compact_board`, over a log built by real websocket writes,
because the fold's cost is dominated by decoding and merging genuine Yjs updates and a
synthetic log of identical blobs would merge far too cheaply.
"""

from __future__ import annotations

import time
import uuid
from typing import Any

import httpx
from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from loadtest.client import Peer, Target, register, shape
from loadtest.metrics import Series


async def _log_stats(factory: Any, board_id: str) -> dict[str, Any]:
    """Row count and total payload bytes in the board's update log.

    `update` is a reserved word, hence the quoted identifier. Raw SQL rather than the
    ORM because `octet_length` over the whole log is the measurement, and loading the
    rows to size them in Python would move megabytes to count them.
    """
    async with factory() as session:
        row = (
            await session.execute(
                text(
                    'select count(*) as rows, '
                    'coalesce(sum(octet_length("update")), 0) as bytes '
                    'from board_updates where board_id = :b'
                ),
                {"b": board_id},
            )
        ).one()
        snap = (
            await session.execute(
                text(
                    "select count(*) as rows, coalesce(sum(octet_length(state)), 0) as bytes "
                    "from board_snapshots where board_id = :b"
                ),
                {"b": board_id},
            )
        ).one()
        return {
            "rows": int(row.rows),
            "bytes": int(row.bytes),
            "snapshot_rows": int(snap.rows),
            "snapshot_bytes": int(snap.bytes),
            # What the board costs on disk right now: the unfolded log plus whatever
            # snapshot it has been folded into. This is the number compaction is
            # supposed to reduce, and comparing only the log would flatter it by
            # ignoring where the state went.
            "total_bytes": int(row.bytes) + int(snap.bytes),
        }


async def run_compaction(
    target: Target,
    database_url: str,
    updates: int = 1000,
    distinct_objects: int | None = None,
) -> dict[str, Any]:
    """Build a log of `updates` writes, fold it, and report both sides of the fold.

    `distinct_objects` is what separates the two regimes, and they answer different
    questions:

    * **None** - every write creates a new object, so the folded state genuinely holds
      `updates` objects. Compaction cannot shrink that, and should not: this is the
      floor, where the only win is the row count.
    * **a small number** - the writes cycle over that many keys, which is what dragging
      a shape or typing into one text object actually looks like. Every write after the
      first for a key is superseded, so the fold discards it. This is where compaction
      earns its cost, and quoting only the first regime would make it look useless.
    """
    from app.realtime.ystore import compact_board

    engine = create_async_engine(database_url)
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        async with httpx.AsyncClient(timeout=60) as http:
            user = await register(target, http, "Compactor")
            board_id = await user.create_board("Compaction board")

            peer = Peer(user=user, board_id=board_id)
            await peer.connect()
            write = Series("ws write")
            started = time.perf_counter()
            for i in range(updates):
                tick = time.perf_counter()
                key = f"obj-{i % distinct_objects}" if distinct_objects else f"obj-{i}"
                await peer.write(key, shape(i, "compactor"))
                write.add((time.perf_counter() - tick) * 1000)
            write.stop()
            write_wall = time.perf_counter() - started

            # Wait for the server to have persisted every one of them. Folding a log
            # that is still being appended to would measure a smaller log than the one
            # the writes actually produced.
            deadline = time.perf_counter() + 120
            before = await _log_stats(factory, board_id)
            while before["rows"] < updates and time.perf_counter() < deadline:
                await peer.drain(0.5)
                before = await _log_stats(factory, board_id)
            await peer.close()

            fold_started = time.perf_counter()
            folded = await compact_board(uuid.UUID(board_id), session_factory=factory)
            fold_s = time.perf_counter() - fold_started

            after = await _log_stats(factory, board_id)

            # A second fold over an already-folded log. Should be cheap and should fold
            # nothing: compaction has to be idempotent or the sweep would rewrite the
            # same snapshot on every tick forever.
            repeat_started = time.perf_counter()
            folded_again = await compact_board(uuid.UUID(board_id), session_factory=factory)
            repeat_s = time.perf_counter() - repeat_started

            return {
                "updates_written": updates,
                "distinct_objects": distinct_objects or updates,
                "regime": "churn" if distinct_objects else "all-new-objects",
                "write_wall_s": round(write_wall, 2),
                "log_rows_before": before["rows"],
                "log_bytes_before": before["bytes"],
                "rows_folded": folded,
                "fold_s": round(fold_s, 3),
                "fold_updates_per_s": round(folded / fold_s, 1) if fold_s else None,
                "log_rows_after": after["rows"],
                "log_bytes_after": after["bytes"],
                "snapshot_rows_after": after["snapshot_rows"],
                "snapshot_bytes_after": after["snapshot_bytes"],
                "total_bytes_before": before["total_bytes"],
                "total_bytes_after": after["total_bytes"],
                "compression_ratio": (
                    round(before["total_bytes"] / after["total_bytes"], 2)
                    if after["total_bytes"]
                    else None
                ),
                "bytes_reclaimed": before["total_bytes"] - after["total_bytes"],
                "idempotent": folded_again == 0,
                "repeat_fold_s": round(repeat_s, 3),
                "series": [write.summary()],
                "_series": [write],
            }
    finally:
        await engine.dispose()
