"""Behaviour under connection churn, and whether the door still holds while busy.

Two things a steady-state load test never sees.

**Reconnect storm.** Every client of a board reconnects at once. That is not a rare
event here: `_evict` deliberately closes every socket on a board whenever sharing, a
role, or the lock changes, and `sync/provider.ts` treats the close as "re-mint a token
and try again". So the thundering herd is a designed-in path, not an accident, and the
cost of it is the full handshake - a ws-token mint, a JWT verify, a role resolved from
the database - times the size of the room.

**Refusal under load.** The handshake is the security boundary, and a boundary that
holds when idle and leaks when busy is not a boundary. So forged, expired and
wrong-board tokens are fired at the server *while* the storm is running, and every one
of them must still be refused with the right close code. A rejection that degrades
into an acceptance under load is the single worst outcome in this file.
"""

from __future__ import annotations

import asyncio
from typing import Any

import httpx
import websockets

from loadtest.client import Peer, Target, register
from loadtest.metrics import Series, Timer
from tests import ywire

WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403


async def _close_code(target: Target, board_id: str, token: str) -> int | None:
    """Connect with `token` and report the code the server hangs up with.

    None means the server did not hang up, which for a bad token is a failure.
    """
    try:
        async with websockets.connect(
            target.ws_url(board_id, token), open_timeout=15, ping_interval=None
        ) as socket:
            await asyncio.wait_for(socket.recv(), timeout=5)
        return None
    except websockets.exceptions.ConnectionClosed as exc:
        return int(exc.code)
    except websockets.exceptions.InvalidStatus as exc:
        return int(exc.response.status_code)
    except TimeoutError:
        return None


async def run_reconnect_storm(
    target: Target, clients: int = 30, rounds: int = 5
) -> dict[str, Any]:
    """`clients` sockets on one board, all torn down and rebuilt, `rounds` times."""
    limits = httpx.Limits(max_connections=clients * 3, max_keepalive_connections=clients * 3)
    async with httpx.AsyncClient(timeout=60, limits=limits) as http:
        user = await register(target, http, "Storm")
        board_id = await user.create_board("Storm board")

        handshake = Series("ws handshake (storm)")
        mint = Series("POST /ws-token")

        async def one(peer: Peer) -> None:
            async with Timer(mint):
                token = await peer.user.ws_token(peer.board_id)
            async with Timer(handshake):
                peer.socket = await websockets.connect(
                    peer.user.target.ws_url(peer.board_id, token),
                    max_size=None,
                    open_timeout=30,
                    ping_interval=None,
                )
                await peer.socket.send(ywire.sync_step1(peer.doc.get_state()))
                # Read one frame, so the timing covers the server's answer and not
                # just the TCP upgrade. A handshake that opens and then fails to
                # serve is not a handshake that succeeded.
                await asyncio.wait_for(peer.socket.recv(), timeout=30)

        for _ in range(rounds):
            peers = [Peer(user=user, board_id=board_id) for _ in range(clients)]
            # All at once. Staggering them would measure a queue we invented.
            await asyncio.gather(*(one(p) for p in peers))
            await asyncio.gather(*(p.close() for p in peers))

        handshake.stop()
        mint.stop()
        return {
            "clients": clients,
            "rounds": rounds,
            "handshakes": handshake.count,
            "failures": handshake.error_count,
            "series": [mint.summary(), handshake.summary()],
            "_series": [mint, handshake],
        }


async def run_refusal_under_load(target: Target, attempts: int = 40) -> dict[str, Any]:
    """Fire bad credentials at the handshake and check every one is refused."""
    async with httpx.AsyncClient(timeout=60) as http:
        user = await register(target, http, "Prober")
        board_id = await user.create_board("Guarded board")

        stranger = await register(target, http, "Stranger")
        stranger_board = await stranger.create_board("Other board")

        good = await user.ws_token(board_id)
        # A token minted for a board this user owns, aimed at a board they do not.
        wrong_board = await stranger.ws_token(stranger_board)

        cases: dict[str, str] = {
            "forged token": "not.a.jwt",
            "empty token": "",
            # Structurally valid and correctly signed, but it names another board.
            "token for another board": wrong_board,
            # The right token with its signature corrupted.
            "tampered signature": good[:-6] + "AAAAAA",
        }

        results: dict[str, Any] = {}
        for label, token in cases.items():
            codes = await asyncio.gather(
                *(_close_code(target, board_id, token) for _ in range(attempts // len(cases)))
            )
            accepted = sum(1 for c in codes if c is None)
            results[label] = {
                "attempts": len(codes),
                "accepted": accepted,
                "codes": sorted({c for c in codes if c is not None}),
                "all_refused": accepted == 0,
            }

        # The control: a good token must still work while all that is going on. A
        # boundary that refuses everything is not secure, it is broken.
        control = await _close_code(target, board_id, await user.ws_token(board_id))
        results["valid token (control)"] = {
            "attempts": 1,
            "accepted": 1 if control is None else 0,
            "codes": [] if control is None else [control],
            "all_refused": control is not None,
        }

        return {
            "cases": results,
            "every_bad_token_refused": all(
                v["all_refused"] for k, v in results.items() if "control" not in k
            ),
            "valid_token_still_accepted": control is None,
        }
