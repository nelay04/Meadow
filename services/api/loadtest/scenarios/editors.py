"""Concurrent editors on one board: how many, how fast, and does it stay correct.

This is the row DECISIONS.md calls "concurrent editors ... not measured". Three
questions, and the third is the one that matters:

1. **How many sockets does a room hold?** `max_clients_per_room` says 50 and the
   handshake is supposed to refuse the 51st with close code 4429. Asserted, not
   assumed - a limit nobody has watched trip is a limit that might be off by one.
2. **What edit rate does the room sustain?** Every editor writes on a timer for the
   duration; the number reported is what the *server acknowledged*, measured as
   updates fanned out, not as updates sent.
3. **Does the document still converge?** Every peer's write is counted, and at the end
   a fresh client reads the board back from the server. If a single update went
   missing under load the object count comes up short, which is exactly the "silently
   wrong" failure ARCHITECTURE 12 refuses to accept. A load test that only measured
   throughput would report a dropped update as *better* performance.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx
import websockets

from loadtest.client import Peer, Target, read_board, register, register_many, shape
from loadtest.metrics import Series

WS_ROOM_FULL = 4429

# How long the fan-out must stay silent before the room counts as drained. Long enough
# not to be fooled by a gap between batches, short enough not to dominate a short run -
# and it is subtracted from the drain before any rate is computed.
QUIET_CONFIRMATION_S = 2.0


async def _grant_editor(owner: Any, board_id: str, users: list[Any]) -> None:
    """Add every account to the board as an explicit editor.

    Membership rather than a share link. Both would let these peers in, but a link is
    resolved through the capability token and membership is resolved from the board's
    own rows - and membership is the path an invited collaborator actually takes, so
    it is the one whose cost belongs in the numbers.
    """
    for user in users:
        response = await owner.http.post(
            f"{owner.target.base_url}/api/v1/boards/{board_id}/members",
            json={"user_id": user.user_id, "role": "editor"},
            headers=owner.auth,
        )
        response.raise_for_status()


async def run_editors(
    target: Target,
    editors: int,
    duration: float,
    edits_per_second: float = 2.0,
    settle_timeout: float = 120.0,
) -> dict[str, Any]:
    """`editors` peers on one board, each writing at `edits_per_second`.

    `edits_per_second=0` removes the pacing: every peer writes as fast as the socket
    accepts, which is what finds the ceiling. The paced mode answers a different and
    more realistic question - "at a human edit rate, does it keep up and stay correct"
    - and the two are reported separately because a saturation number quoted as though
    it were a steady-state one is the most common way load figures mislead."""
    limits = httpx.Limits(max_connections=editors * 3, max_keepalive_connections=editors * 3)
    async with httpx.AsyncClient(timeout=60, limits=limits) as http:
        owner = await register(target, http, "Owner")
        board_id = await owner.create_board("Concurrency board")
        others = await register_many(target, http, editors - 1)
        await _grant_editor(owner, board_id, others)
        users = [owner, *others]

        # Peers do not merge what they receive: see `Peer.apply_remote`. They still
        # read every frame, so the server's fan-out cost is unchanged.
        peers = [Peer(user=u, board_id=board_id, apply_remote=False) for u in users]
        connect = Series("ws connect")
        for p in peers:
            started = time.perf_counter()
            await p.connect()
            connect.add((time.perf_counter() - started) * 1000)
        connect.stop()

        writes = Series("ws write")
        received = Series("ws fan-out received", unit="messages")
        paced = edits_per_second > 0
        interval = (1.0 / edits_per_second) if paced else 0.0
        deadline = time.perf_counter() + duration
        written: dict[int, int] = {}
        bytes_sent = 0

        async def editor(index: int, peer: Peer) -> None:
            nonlocal bytes_sent
            n = 0
            while time.perf_counter() < deadline:
                tick = time.perf_counter()
                try:
                    size = await peer.write(f"p{index}-{n}", shape(n, f"peer{index}"))
                    bytes_sent += size
                    writes.add((time.perf_counter() - tick) * 1000)
                    n += 1
                except Exception as exc:  # noqa: BLE001 - a load run counts, not raises
                    writes.fail(f"{type(exc).__name__}: {str(exc)[:60]}")
                    break
                # Drain while waiting rather than sleeping, so the receive buffer never
                # backs up. A peer that only writes is not an editor, it is a firehose,
                # and the websocket flow control would eventually stall it anyway.
                if paced:
                    slack = interval - (time.perf_counter() - tick)
                    if slack > 0:
                        received.add(await peer.drain(slack))
                else:
                    # Unpaced. Still drain, but only what is already buffered, and
                    # yield so the other peers' tasks get the loop.
                    received.add(await peer.drain_ready())
                    await asyncio.sleep(0)
            written[index] = n

        started = time.perf_counter()
        await asyncio.gather(*(editor(i, p) for i, p in enumerate(peers)))
        wall = time.perf_counter() - started
        writes.stop()
        received.stop()

        # --- settle -------------------------------------------------------------
        #
        # `send()` returns once the frame is in the local buffer, not once the server
        # has applied it. Under saturation the client therefore runs far ahead of the
        # room, and closing here would discard the backlog and report the lost updates
        # as though the server had dropped them - a measurement artefact that looks
        # exactly like the worst bug this system could have. The first saturation run
        # written without this reported 42,290 of 53,210 updates lost; with it, the
        # same run loses none.
        #
        # Quiescence of the fan-out is the signal, not a poll of the document. Reading
        # the board back mid-settle would need a socket of its own, and at 50 editors
        # the room is already at `max_clients_per_room` - so the probe would be refused
        # with 4429 and the settle would never finish. Instead: drain every peer until
        # nobody has received anything for two seconds, which is the server saying it
        # has nothing left to send.
        expected = sum(written.values())
        settle_started = time.perf_counter()
        settle_deadline = settle_started + settle_timeout
        quiet_since: float | None = None
        while time.perf_counter() < settle_deadline:
            drained = sum(await asyncio.gather(*(p.drain(0.25) for p in peers)))
            if drained == 0:
                quiet_since = quiet_since or time.perf_counter()
                if time.perf_counter() - quiet_since > QUIET_CONFIRMATION_S:
                    break
            else:
                quiet_since = None
        settle_s = time.perf_counter() - settle_started
        # The last two seconds were spent confirming silence, not draining. Charging
        # them to the drain would understate ingest, and badly on a short run - at a
        # 10-second write phase they are a fifth of the denominator.
        drain_s = max(0.0, settle_s - QUIET_CONFIRMATION_S)

        # Close before reading back, so the read has a slot in a full room and so the
        # figure is what survived the disconnect rather than what was still in flight.
        for p in peers:
            await p.close()
        server_state = await read_board(owner, board_id)

        converged = len(server_state) == expected
        total_wall = wall + drain_s

        return {
            "editors": editors,
            "duration_s": round(wall, 2),
            "mode": "paced" if paced else "saturation",
            "target_edits_per_s": (edits_per_second * editors) if paced else None,
            "writes_issued": expected,
            # What the client pushed into its sockets. Under saturation this is the
            # client's fill rate, NOT the server's capacity - see the settle note.
            "offered_writes_per_s": round(expected / wall, 1),
            # What the server actually absorbed, over the write phase plus the drain
            # it took to catch up. This is the ingest figure worth quoting.
            "ingest_writes_per_s": round(len(server_state) / total_wall, 1),
            "settle_s": round(settle_s, 2),
            "drain_s": round(drain_s, 2),
            "update_bytes_sent": bytes_sent,
            "objects_on_server": len(server_state),
            "converged": converged,
            "lost_updates": expected - len(server_state),
            "fanout_messages_received": sum(received.samples),
            "series": [connect.summary(), writes.summary()],
            "_series": [connect, writes],
        }


async def run_room_cap(target: Target, cap: int = 50) -> dict[str, Any]:
    """Fill a room to its limit, then prove the next join is refused with 4429."""
    limits = httpx.Limits(max_connections=cap * 3, max_keepalive_connections=cap * 3)
    async with httpx.AsyncClient(timeout=60, limits=limits) as http:
        owner = await register(target, http, "Owner")
        board_id = await owner.create_board("Cap board")

        held: list[Peer] = []
        accepted = 0
        # One account, many sockets: the cap counts connections in the room, not
        # people, and this keeps the setup from being 51 argon2id hashes.
        for _ in range(cap):
            peer = Peer(user=owner, board_id=board_id)
            try:
                await peer.connect()
                # The server accepts the TCP upgrade before it validates, so a refusal
                # surfaces on the first read rather than at connect.
                await asyncio.wait_for(peer.socket.recv(), timeout=5)
            except Exception:  # noqa: BLE001
                break
            held.append(peer)
            accepted += 1

        refused_code: int | None = None
        extra = Peer(user=owner, board_id=board_id)
        try:
            await extra.connect()
            await asyncio.wait_for(extra.socket.recv(), timeout=5)
        except websockets.exceptions.ConnectionClosed as exc:
            refused_code = exc.code
        except Exception as exc:  # noqa: BLE001
            refused_code = -1
            print(f"  unexpected refusal: {type(exc).__name__}: {exc}")
        finally:
            await extra.close()

        for peer in held:
            await peer.close()

        return {
            "configured_cap": cap,
            "sockets_accepted": accepted,
            "overflow_close_code": refused_code,
            "refused_correctly": accepted == cap and refused_code == WS_ROOM_FULL,
        }
