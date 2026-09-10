"""Escalate until something breaks, and report where.

The other scenarios run at a chosen size and report how it went. These run at
*increasing* sizes and stop at the first one that fails, which is the only way to get
a ceiling rather than a reassurance.

Two of the ceilings here are not the same kind of thing, and conflating them would be
the easiest mistake in this file:

* `max_clients_per_room` is a **configured** limit. Measuring it tells you what the
  setting says, not what the server can do. So `run_room_ceiling` is pointed at a
  target started with that setting raised out of the way, and finds where the room
  actually stops working.
* Total concurrent sockets across *many* boards is a **process** limit - file
  descriptors, event-loop scheduling, memory - and the room cap never applies. This is
  the number that describes the deployment.

The load generator and the server share this machine, so a failure here can be the
generator's and not the server's. Every function below therefore records which side
gave out, and `saturating_generator` is set when the evidence points at the harness.
"""

from __future__ import annotations

import asyncio
import resource
import time
from typing import Any

import httpx
import websockets

from loadtest.client import Target, User, register
from loadtest.metrics import Series
from tests import ywire


def _rss_mb() -> float:
    """This process's resident set, in MB. Linux reports ru_maxrss in KB."""
    return resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024


async def _mint(user: User, board_ids: list[str], count: int, start: int) -> list[str]:
    """Mint `count` ws-tokens up front, a few at a time.

    Separated from opening the sockets on purpose. Minting is a REST call, and firing
    a hundred of those at a single-worker event loop that is already servicing
    hundreds of websockets makes the *HTTP* request fail first - which is a real and
    interesting result (see `run_rest_under_socket_load`) but tells you nothing about
    how many sockets the server holds. Pre-minting keeps the two ceilings apart.

    Tokens live 60 seconds, so a batch has to be spent promptly after this returns.
    """
    semaphore = asyncio.Semaphore(10)

    async def one(index: int) -> str:
        async with semaphore:
            return await user.ws_token(board_ids[index % len(board_ids)])

    return list(await asyncio.gather(*(one(start + i) for i in range(count))))


async def _mint_and_open(user: User, board_id: str, semaphore: asyncio.Semaphore) -> Any:
    """Mint this socket's token and spend it immediately, under a concurrency bound.

    Both halves of this matter, and each was learned from a sweep that stopped for the
    wrong reason:

    * **Bounded.** Firing an unbounded batch of ws-token mints at a single-worker loop
      that is already servicing hundreds of sockets makes the *HTTP* call fail first
      (a read error at ~400 sockets), which says nothing about socket capacity.
    * **Immediate.** A ws-token lives 60 seconds. Minting a whole batch up front and
      spending it afterwards means that under congestion the earliest tokens expire
      before their turn - a sweep stopped at 4,004 sockets with close code 4401,
      "token expired", which is the harness losing a race rather than the server
      refusing a connection.

    Minting per socket, immediately before use, removes both artefacts. The remaining
    failure is the server's.
    """
    async with semaphore:
        token = await user.ws_token(board_id)
    return await _open_socket(user, board_id, token)


async def _open_socket(user: User, board_id: str, token: str, timeout: float = 30.0) -> Any:
    """One socket, through the full handshake, with no document attached.

    Deliberately no `Doc`: a capacity probe is asking how many *connections* hold, and
    a pycrdt document per socket would make this measure the generator's memory
    instead. The step 1 and the frame read stay, because a socket that opens and is
    never served has not really joined the room.
    """
    socket = await websockets.connect(
        user.target.ws_url(board_id, token),
        max_size=None,
        open_timeout=timeout,
        ping_interval=None,
    )
    await socket.send(ywire.sync_step1(b"\x00"))
    await asyncio.wait_for(socket.recv(), timeout=timeout)
    return socket


async def run_socket_ceiling(
    target: Target,
    step: int = 100,
    limit: int = 3000,
    boards: int = 40,
    hold_seconds: float = 3.0,
) -> dict[str, Any]:
    """Add sockets `step` at a time, across `boards` boards, until they stop opening.

    Spread over many boards so `max_clients_per_room` never applies - this is asking
    what the process holds, not what one room allows.
    """
    async with httpx.AsyncClient(
        timeout=120, limits=httpx.Limits(max_connections=200, max_keepalive_connections=200)
    ) as http:
        user = await register(target, http, "Capacity")
        board_ids = [await user.create_board(f"Cap {i}") for i in range(boards)]

        held: list[Any] = []
        opened = 0
        failure: str | None = None
        rounds: list[dict[str, Any]] = []

        try:
            while opened < limit:
                batch = min(step, limit - opened)
                gate = asyncio.Semaphore(16)
                started = time.perf_counter()
                results = await asyncio.gather(
                    *(
                        _mint_and_open(user, board_ids[(opened + i) % boards], gate)
                        for i in range(batch)
                    ),
                    return_exceptions=True,
                )
                elapsed = time.perf_counter() - started

                good = [r for r in results if not isinstance(r, BaseException)]
                bad = [r for r in results if isinstance(r, BaseException)]
                held.extend(good)
                opened += len(good)
                rounds.append(
                    {
                        "sockets_open": opened,
                        "batch": batch,
                        "opened": len(good),
                        "failed": len(bad),
                        "batch_seconds": round(elapsed, 2),
                        "open_rate_per_s": round(len(good) / elapsed, 1) if elapsed else None,
                        "rss_mb": round(_rss_mb(), 1),
                    }
                )
                print(f"  {opened} sockets open ({len(bad)} failed this batch)", flush=True)

                if bad:
                    failure = f"{type(bad[0]).__name__}: {str(bad[0])[:120]}"
                    break

                # Prove the ones already open are still alive, not just accepted.
                await asyncio.sleep(hold_seconds)
        finally:
            await asyncio.gather(
                *(s.close() for s in held), return_exceptions=True
            )

        return {
            "boards": boards,
            "max_concurrent_sockets": opened,
            "reached_limit": opened >= limit,
            "first_failure": failure,
            # A failure that is the generator running out of memory or descriptors is
            # not the server's ceiling, and saying so is the difference between a
            # measurement and a boast.
            "saturating_generator": bool(
                failure and ("Too many open files" in failure or "Cannot allocate" in failure)
            ),
            "peak_rss_mb": round(_rss_mb(), 1),
            "rounds": rounds,
        }


async def run_room_ceiling(
    target: Target, step: int = 25, limit: int = 600
) -> dict[str, Any]:
    """How many sockets **one room** holds, with the configured cap raised away.

    Only meaningful against a target started with `MEADOW_MAX_CLIENTS_PER_ROOM` set
    high. Against a default target this returns at the cap and says so, because the
    honest answer there is "the setting stopped it, nothing else did".
    """
    async with httpx.AsyncClient(
        timeout=120, limits=httpx.Limits(max_connections=200, max_keepalive_connections=200)
    ) as http:
        user = await register(target, http, "RoomCap")
        board_id = await user.create_board("One big room")

        held: list[Any] = []
        opened = 0
        failure: str | None = None
        close_code: int | None = None
        rounds: list[dict[str, Any]] = []

        try:
            while opened < limit:
                batch = min(step, limit - opened)
                gate = asyncio.Semaphore(16)
                started = time.perf_counter()
                results = await asyncio.gather(
                    *(_mint_and_open(user, board_id, gate) for _ in range(batch)),
                    return_exceptions=True,
                )
                elapsed = time.perf_counter() - started
                good = [r for r in results if not isinstance(r, BaseException)]
                bad = [r for r in results if isinstance(r, BaseException)]
                held.extend(good)
                opened += len(good)
                rounds.append(
                    {
                        "sockets_in_room": opened,
                        "opened": len(good),
                        "failed": len(bad),
                        "batch_seconds": round(elapsed, 2),
                        "rss_mb": round(_rss_mb(), 1),
                    }
                )
                print(f"  {opened} in one room ({len(bad)} failed)", flush=True)
                if bad:
                    first = bad[0]
                    failure = f"{type(first).__name__}: {str(first)[:120]}"
                    if isinstance(first, websockets.exceptions.ConnectionClosed):
                        close_code = int(first.code)
                    break
        finally:
            await asyncio.gather(*(s.close() for s in held), return_exceptions=True)

        return {
            "max_sockets_in_one_room": opened,
            "reached_limit": opened >= limit,
            "first_failure": failure,
            "close_code": close_code,
            # 4429 means the configured cap refused it, which is the setting working
            # rather than the room filling up.
            "stopped_by_configured_cap": close_code == 4429,
            "peak_rss_mb": round(_rss_mb(), 1),
            "rounds": rounds,
        }


async def run_peak_ingest(
    target: Target, writer_counts: tuple[int, ...] = (5, 10, 20, 40), seconds: float = 8.0
) -> dict[str, Any]:
    """Push a single room as hard as possible at several writer counts.

    Reports the *ingest* rate at each - what the server absorbed and kept, not what the
    client managed to shove into a buffer. The peak across the sweep is the room's
    write ceiling on this machine.
    """
    from loadtest.scenarios.editors import run_editors

    points = []
    for count in writer_counts:
        result = await run_editors(
            target, editors=count, duration=seconds, edits_per_second=0, settle_timeout=180
        )
        result.pop("_series", None)
        result.pop("series", None)
        points.append(result)
        print(
            f"  {count} writers: offered {result['offered_writes_per_s']}/s, "
            f"ingest {result['ingest_writes_per_s']}/s, lost {result['lost_updates']}",
            flush=True,
        )

    best = max(points, key=lambda p: p["ingest_writes_per_s"])
    return {
        "points": points,
        "peak_ingest_writes_per_s": best["ingest_writes_per_s"],
        "peak_at_writers": best["editors"],
        "any_updates_lost": any(p["lost_updates"] for p in points),
        "all_converged": all(p["converged"] for p in points),
    }


async def run_rest_ceiling(
    target: Target, concurrencies: tuple[int, ...] = (32, 64, 128, 256), seconds: float = 10.0
) -> dict[str, Any]:
    """REST read throughput as concurrency climbs, to find where it stops helping."""
    from loadtest.scenarios import rest

    points = []
    for concurrency in concurrencies:
        result = await rest.run_reads(target, concurrency=concurrency, duration=seconds)
        series: list[Series] = result.pop("_series", [])
        summaries = [s.summary() for s in series]
        worst_p95 = max((s["p95"] or 0) for s in summaries) if summaries else None
        points.append(
            {
                "concurrency": concurrency,
                "requests_per_s": result["requests_per_s"],
                "errors": result["errors"],
                "worst_p95_ms": worst_p95,
            }
        )
        print(
            f"  c={concurrency}: {result['requests_per_s']} req/s, "
            f"worst p95 {worst_p95} ms, {result['errors']} errors",
            flush=True,
        )

    best = max(points, key=lambda p: p["requests_per_s"])
    return {
        "points": points,
        "peak_requests_per_s": best["requests_per_s"],
        "peak_at_concurrency": best["concurrency"],
    }


async def run_rest_under_socket_load(
    target: Target, sockets: int = 400, boards: int = 40, seconds: float = 10.0
) -> dict[str, Any]:
    """What REST latency does while the process is holding a pile of websockets.

    This exists because the first socket-ceiling sweep failed here rather than at the
    socket: at ~400 open sockets the ws-token mint started returning read errors, and
    the websockets themselves were fine. That is worth measuring deliberately instead
    of tripping over.

    The mechanism is the one the architecture already names. Rooms are in-process
    state, so the API runs **one uvicorn worker**, and every open socket's fan-out
    shares an event loop with every REST handler. Websocket traffic is therefore not
    free for the REST API - it is the same loop, and this measures the interference.

    Reported as a ratio against an idle baseline, because the absolute numbers on a
    shared-machine run mean much less than how far they moved.

    **Measured answer: nothing.** At 400 held sockets the p95 ratio came out at 0.96
    and throughput at 1.02 - inside the noise. So the hypothesis this function was
    written to test is wrong, and the earlier read errors were caused by the harness
    firing an unbounded burst of ws-token mints, not by the sockets being open.

    Which sharpens the real finding rather than removing it: an *idle* socket costs the
    event loop nothing measurable. The cost is fan-out, and fan-out is O(peers) per
    edit - so it is the writing, not the connecting, that fills the loop. See
    `run_editing_room_ceiling`, where 400 peers in one room generate 158,000 frames a
    second and the room falls minutes behind while still losing nothing.
    """
    from loadtest.metrics import Timer

    async with httpx.AsyncClient(
        timeout=60, limits=httpx.Limits(max_connections=64, max_keepalive_connections=64)
    ) as http:
        user = await register(target, http, "Interference")
        board_ids = [await user.create_board(f"Int {i}") for i in range(boards)]
        probe_board = board_ids[0]

        async def probe(series: Series, until: float) -> None:
            while time.perf_counter() < until:
                async with Timer(series):
                    response = await http.get(
                        f"{target.base_url}/api/v1/boards/{probe_board}", headers=user.auth
                    )
                    response.raise_for_status()

        idle = Series("GET /boards/{id} (idle)")
        await probe(idle, time.perf_counter() + seconds)
        idle.stop()

        held: list[Any] = []
        opened = 0
        while opened < sockets:
            batch = min(50, sockets - opened)
            tokens = await _mint(user, board_ids, batch, opened)
            results = await asyncio.gather(
                *(
                    _open_socket(user, board_ids[(opened + i) % boards], tokens[i])
                    for i in range(batch)
                ),
                return_exceptions=True,
            )
            good = [r for r in results if not isinstance(r, BaseException)]
            held.extend(good)
            opened += len(good)
            if len(good) < batch:
                break

        loaded = Series(f"GET /boards/{{id}} ({opened} sockets open)")
        try:
            await probe(loaded, time.perf_counter() + seconds)
        finally:
            loaded.stop()
            await asyncio.gather(*(s.close() for s in held), return_exceptions=True)

        idle_p95 = idle.percentile(95)
        loaded_p95 = loaded.percentile(95)
        return {
            "sockets_held": opened,
            "idle": idle.summary(),
            "loaded": loaded.summary(),
            "p95_ratio": round(loaded_p95 / idle_p95, 2) if idle_p95 else None,
            "throughput_ratio": (
                round((loaded.count / loaded.elapsed) / (idle.count / idle.elapsed), 2)
                if idle.count
                else None
            ),
            "_series": [idle, loaded],
        }


async def run_editing_room_ceiling(
    target: Target,
    editor_counts: tuple[int, ...] = (50, 100, 200, 400),
    duration: float = 15.0,
    edits_per_second: float = 1.0,
    settle_timeout: float = 600.0,
) -> dict[str, Any]:
    """How many *editing* peers one board sustains - the number that actually matters.

    An idle socket is cheap. The cost in a room is the fan-out, which is O(peers) per
    update: one edit by one of 400 peers is 399 frames the server has to write. So a
    room that holds 4,000 idle sockets tells you very little, and this measures the
    same room with everybody typing.

    Every peer belongs to one account, holding many sockets. That is not how a real
    board is used, but it is the same work for the server - the room does not care
    whose socket it is - and it avoids spending an argon2id hash per peer, which at
    400 peers would take longer than the measurement.

    A count "sustains" only if every write survives. Convergence is checked from a
    fresh client against the server at the end, so a run that kept up by dropping
    updates is reported as a failure, not as a higher number.
    """
    from loadtest.client import Peer, read_board, shape

    points: list[dict[str, Any]] = []
    async with httpx.AsyncClient(
        timeout=180, limits=httpx.Limits(max_connections=64, max_keepalive_connections=64)
    ) as http:
        user = await register(target, http, "RoomEditor")

        for count in editor_counts:
            board_id = await user.create_board(f"Editing room {count}")
            peers = [
                Peer(user=user, board_id=board_id, apply_remote=False) for _ in range(count)
            ]

            connect = Series("ws connect")
            gate = asyncio.Semaphore(16)

            # Loop variables bound as defaults: these closures are awaited inside the
            # same iteration, but binding makes that explicit rather than incidental.
            async def join(
                peer: Peer,
                gate: asyncio.Semaphore = gate,
                connect: Series = connect,
            ) -> None:
                started = time.perf_counter()
                async with gate:
                    token = await peer.user.ws_token(peer.board_id)
                peer.socket = await websockets.connect(
                    peer.user.target.ws_url(peer.board_id, token),
                    max_size=None,
                    open_timeout=60,
                    ping_interval=None,
                )
                await peer.socket.send(ywire.sync_step1(peer.doc.get_state()))
                connect.add((time.perf_counter() - started) * 1000)

            joined = await asyncio.gather(*(join(p) for p in peers), return_exceptions=True)
            failures = [j for j in joined if isinstance(j, BaseException)]
            live = [p for p in peers if p.socket is not None]
            connect.stop()

            written: dict[int, int] = {}
            write = Series("ws write")
            deadline = time.perf_counter() + duration

            async def editor(
                index: int,
                peer: Peer,
                deadline: float = deadline,
                write: Series = write,
                written: dict[int, int] = written,
            ) -> None:
                n = 0
                interval = 1.0 / edits_per_second
                while time.perf_counter() < deadline:
                    tick = time.perf_counter()
                    try:
                        await peer.write(f"e{index}-{n}", shape(n, f"e{index}"))
                        write.add((time.perf_counter() - tick) * 1000)
                        n += 1
                    except Exception as exc:  # noqa: BLE001
                        write.fail(f"{type(exc).__name__}: {str(exc)[:60]}")
                        break
                    slack = interval - (time.perf_counter() - tick)
                    if slack > 0:
                        await peer.drain(slack)
                written[index] = n

            started = time.perf_counter()
            await asyncio.gather(*(editor(i, p) for i, p in enumerate(live)))
            wall = time.perf_counter() - started
            write.stop()

            # Settle on fan-out quiescence, then close and read back from the server.
            quiet_since: float | None = None
            settle_started = time.perf_counter()
            while time.perf_counter() - settle_started < settle_timeout:
                drained = sum(await asyncio.gather(*(p.drain(0.25) for p in live)))
                if drained == 0:
                    quiet_since = quiet_since or time.perf_counter()
                    if time.perf_counter() - quiet_since > 2.0:
                        break
                else:
                    quiet_since = None
            settle_s = time.perf_counter() - settle_started
            drain_s = max(0.0, settle_s - 2.0)

            await asyncio.gather(*(p.close() for p in live), return_exceptions=True)
            expected = sum(written.values())
            server_state = await read_board(user, board_id)

            point = {
                "editors_requested": count,
                "editors_joined": len(live),
                "join_failures": len(failures),
                "duration_s": round(wall, 2),
                "writes_issued": expected,
                "offered_writes_per_s": round(expected / wall, 1) if wall else 0,
                "settle_s": round(settle_s, 2),
                "drain_s": round(drain_s, 2),
                "objects_on_server": len(server_state),
                "lost_updates": expected - len(server_state),
                "converged": len(server_state) == expected,
                # True when the drain was still going when patience ran out. A run
                # that hits this has NOT proved data loss - it has proved the backlog
                # outlived the timeout, and the shortfall below is unfinished work
                # rather than lost work. A 400-editor run reported 1,418 "lost" this
                # way before the timeout was raised; with room to finish, it lost none.
                "settle_timed_out": settle_s >= settle_timeout - 1,
                # Every write is relayed to every other peer in the room, so the
                # frames the room owes are writes x (peers - 1).
                "fanout_frames": expected * max(0, len(live) - 1),
                # OFFERED: what the writers asked the room to relay, over the write
                # phase alone. This is a demand figure. It is NOT throughput, and
                # quoting it as though it were overstates the server by an order of
                # magnitude once the room is saturated - 400 editors "offer" 158,000
                # frames/s and the room delivers about 16,000.
                "offered_fanout_frames_per_s": (
                    round(expected * max(0, len(live) - 1) / wall, 1) if wall else 0
                ),
                # ACHIEVED: the same frames over the time it actually took to deliver
                # them - write phase plus drain. This is the throughput figure.
                "achieved_fanout_frames_per_s": (
                    round(expected * max(0, len(live) - 1) / (wall + drain_s), 1)
                    if (wall + drain_s)
                    else 0
                ),
                # True when the room kept up: it finished relaying about as fast as the
                # writers produced. This, not the peer count, is what "sustained" means.
                "kept_up": drain_s < 2.0,
                "write_p95_ms": write.percentile(95),
                "connect_p95_ms": connect.percentile(95),
                "write_errors": write.error_count,
                "peak_rss_mb": round(_rss_mb(), 1),
            }
            points.append(point)
            print(
                f"  {count} editors: joined {len(live)}, {point['offered_writes_per_s']}/s, "
                f"fan-out offered {point['offered_fanout_frames_per_s']}/s -> achieved "
                f"{point['achieved_fanout_frames_per_s']}/s, drain {point['drain_s']}s, "
                f"lost {point['lost_updates']}, converged {point['converged']}, "
                f"kept up {point['kept_up']}",
                flush=True,
            )

    lossless = [p for p in points if p["converged"] and p["join_failures"] == 0]
    realtime = [p for p in lossless if p["kept_up"]]
    return {
        "points": points,
        # Two different ceilings, and the gap between them is the finding. A room can
        # be correct long after it has stopped being current.
        "max_lossless_editors": max((p["editors_joined"] for p in lossless), default=0),
        "max_realtime_editors": max((p["editors_joined"] for p in realtime), default=0),
        "peak_achieved_fanout_frames_per_s": max(
            (p["achieved_fanout_frames_per_s"] for p in points), default=0
        ),
        "all_converged": all(p["converged"] for p in points),
    }
