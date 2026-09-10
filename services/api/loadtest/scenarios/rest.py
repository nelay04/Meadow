"""REST throughput and latency under concurrent clients.

Closed-loop rather than open-loop: each virtual client issues a request, waits for the
answer, and issues the next. That measures what a browser actually experiences and it
cannot overrun the server into a queue that makes latency meaningless. The cost is
that throughput is bounded by concurrency over latency, so the number to read is the
pair, never the throughput alone.

Two mixes, because they exercise different things:

* `read` - the endpoints a signed-in tab hits constantly. Session-scoped, indexed
  queries. This is the API's ceiling when nothing expensive is happening.
* `auth` - login. Deliberately slow: argon2id is tuned so a password guess costs real
  CPU, so this measures the hash, not the framework. Reported separately so the read
  numbers are not quietly averaged with it.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

import httpx

from loadtest.client import PASSWORD, Target, User, register_many
from loadtest.metrics import Series, Timer


async def _read_mix(user: User, board_id: str, series: dict[str, Series]) -> None:
    base = user.target.base_url
    async with Timer(series["GET /boards"]):
        r = await user.http.get(f"{base}/api/v1/boards", headers=user.auth)
        r.raise_for_status()
    async with Timer(series["GET /boards/{id}"]):
        r = await user.http.get(f"{base}/api/v1/boards/{board_id}", headers=user.auth)
        r.raise_for_status()
    async with Timer(series["GET /auth/me"]):
        r = await user.http.get(f"{base}/api/v1/auth/me", headers=user.auth)
        r.raise_for_status()
    async with Timer(series["GET /boards/{id}/members"]):
        r = await user.http.get(f"{base}/api/v1/boards/{board_id}/members", headers=user.auth)
        r.raise_for_status()


async def run_reads(
    target: Target, concurrency: int, duration: float, boards_each: int = 5
) -> dict[str, Any]:
    """`concurrency` signed-in clients hammering the read endpoints for `duration`."""
    limits = httpx.Limits(
        max_connections=concurrency * 2, max_keepalive_connections=concurrency * 2
    )
    async with httpx.AsyncClient(timeout=30, limits=limits) as http:
        users = await register_many(target, http, concurrency)
        # Give each account a handful of boards, so `GET /boards` returns a list rather
        # than an empty array and the query does real work.
        boards = []
        for user in users:
            ids = [await user.create_board(f"Board {i}") for i in range(boards_each)]
            boards.append(ids[0])

        names = [
            "GET /boards",
            "GET /boards/{id}",
            "GET /auth/me",
            "GET /boards/{id}/members",
        ]
        series = {name: Series(name) for name in names}
        deadline = time.perf_counter() + duration

        async def worker(user: User, board_id: str) -> None:
            while time.perf_counter() < deadline:
                await _read_mix(user, board_id, series)

        started = time.perf_counter()
        await asyncio.gather(*(worker(u, b) for u, b in zip(users, boards, strict=True)))
        wall = time.perf_counter() - started
        for s in series.values():
            s.stop()

        ordered = [series[n] for n in names]
        requests = sum(s.count for s in ordered)
        return {
            "concurrency": concurrency,
            "duration_s": round(wall, 2),
            "requests": requests,
            "errors": sum(s.error_count for s in ordered),
            "requests_per_s": round(requests / wall, 1),
            "series": [s.summary() for s in ordered],
            "_series": ordered,
        }


async def run_logins(target: Target, concurrency: int, duration: float) -> dict[str, Any]:
    """Login throughput, which is the argon2id verify cost and little else."""
    limits = httpx.Limits(
        max_connections=concurrency * 2, max_keepalive_connections=concurrency * 2
    )
    async with httpx.AsyncClient(timeout=60, limits=limits) as http:
        users = await register_many(target, http, concurrency)
        series = Series("POST /auth/login")
        deadline = time.perf_counter() + duration

        async def worker(user: User) -> None:
            while time.perf_counter() < deadline:
                async with Timer(series):
                    r = await http.post(
                        f"{target.base_url}/api/v1/auth/login",
                        json={"email": user.email, "password": PASSWORD},
                    )
                    r.raise_for_status()

        started = time.perf_counter()
        await asyncio.gather(*(worker(u) for u in users))
        wall = time.perf_counter() - started
        series.stop()
        return {
            "concurrency": concurrency,
            "duration_s": round(wall, 2),
            "series": [series.summary()],
            "_series": [series],
        }
