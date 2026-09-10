"""Cursor propagation latency: peer A moves, when does peer B see it.

The second unmeasured row in DECISIONS.md. A cursor is an *awareness* entry, not a
document update - it is relayed to the other sockets in the room and never persisted -
so this measures the fan-out path on its own, with none of the update log underneath
it.

Method: the moving peer stamps `time.perf_counter_ns()` into the awareness payload it
publishes. Every watching peer reads the stamp out of the relayed message and takes
the difference. Both ends are in this one process on one machine, so the two readings
come from the same clock and the subtraction is meaningful - no clock skew to correct
for, which is the usual reason one-way latency is hard to measure and the reason this
is worth doing locally rather than across a network.

What it therefore includes: client serialise, kernel loopback, server parse and relay,
kernel loopback, client parse. What it excludes: the internet. A wide-area number is
this plus the RTT of the path, and the point of measuring here is that the part the
code controls is separated from the part it does not.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx

from loadtest.client import Peer, Target, register, register_many
from loadtest.metrics import Series
from loadtest.scenarios.editors import _grant_editor
from tests import ywire


async def run_cursors(
    target: Target,
    peers_count: int,
    duration: float,
    moves_per_second: float = 20.0,
) -> dict[str, Any]:
    """One peer moves its cursor; the rest watch and time what arrives.

    `moves_per_second` defaults to 20, which is roughly what a pointer-move handler
    throttled to 50ms emits - fast enough to be a real stream, slow enough that the
    number measures the path rather than a queue the test itself built.
    """
    limits = httpx.Limits(
        max_connections=peers_count * 3, max_keepalive_connections=peers_count * 3
    )
    async with httpx.AsyncClient(timeout=60, limits=limits) as http:
        owner = await register(target, http, "Mover")
        board_id = await owner.create_board("Cursor board")
        watchers_users = await register_many(target, http, peers_count - 1)
        await _grant_editor(owner, board_id, watchers_users)

        mover = Peer(user=owner, board_id=board_id)
        watchers = [Peer(user=u, board_id=board_id) for u in watchers_users]
        for p in [mover, *watchers]:
            await p.connect()

        # Let the sync handshakes finish, so the first measured move is not queued
        # behind a step 2 carrying the whole document.
        await asyncio.gather(*(p.drain(1.0) for p in [mover, *watchers]))

        latency = Series("cursor propagation")
        stop = asyncio.Event()
        moves = 0

        async def move() -> None:
            nonlocal moves
            clock = 0
            interval = 1.0 / moves_per_second
            deadline = time.perf_counter() + duration
            while time.perf_counter() < deadline:
                clock += 1
                await mover.publish_cursor(
                    {"cursor": {"x": clock % 1920, "y": clock % 1080}, "t": time.perf_counter_ns()},
                    clock,
                )
                moves += 1
                await asyncio.sleep(interval)
            # Watchers need a moment to collect what is still in flight.
            await asyncio.sleep(1.0)
            stop.set()

        async def watch(peer: Peer) -> None:
            while not stop.is_set():
                try:
                    raw = await asyncio.wait_for(peer.socket.recv(), timeout=0.5)
                except TimeoutError:
                    continue
                except Exception as exc:  # noqa: BLE001
                    latency.fail(f"{type(exc).__name__}: {str(exc)[:60]}")
                    return
                arrived = time.perf_counter_ns()
                if isinstance(raw, str) or not raw:
                    continue
                message_type, _, _ = ywire.parse(raw)
                if message_type != ywire.MESSAGE_AWARENESS:
                    continue
                try:
                    states = ywire.read_awareness(raw)
                except ValueError:
                    continue
                for state in states.values():
                    try:
                        payload = json.loads(state)
                    except json.JSONDecodeError:
                        continue
                    stamp = payload.get("t") if isinstance(payload, dict) else None
                    if isinstance(stamp, int):
                        latency.add((arrived - stamp) / 1_000_000)

        await asyncio.gather(move(), *(watch(p) for p in watchers))
        latency.stop()
        for p in [mover, *watchers]:
            await p.close()

        expected = moves * len(watchers)
        return {
            "peers": peers_count,
            "watchers": len(watchers),
            "moves_sent": moves,
            "moves_per_s": moves_per_second,
            "receipts_expected": expected,
            "receipts_observed": latency.count,
            # Awareness is lossy by design - it is state, not a log, and a peer that
            # misses one gets the next. A shortfall here is not a bug, but it is worth
            # seeing, because a large one means the relay is shedding.
            "delivery_ratio": round(latency.count / expected, 3) if expected else None,
            "series": [latency.summary()],
            "_series": [latency],
        }
