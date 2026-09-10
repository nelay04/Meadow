"""The harness's entry point: run the suites, write the numbers down.

    python -m loadtest.run --help

Every scenario is opt-in by name so a single question can be re-asked cheaply while
tuning, and `--suite full` runs the lot. Output is a JSON file (every sample summary,
for diffing between runs) and a Markdown report (for reading, and for pasting into the
docs table that currently says "not measured").

The run records the machine and the target settings alongside the numbers, because a
throughput figure without them is not a measurement, it is a rumour.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import platform
import subprocess
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from loadtest.client import Target
from loadtest.metrics import table
from loadtest.scenarios import capacity, compaction, cursors, editors, resilience, rest

DEFAULT_DB = "postgresql+asyncpg://meadow:meadow@localhost:5435/meadow_load"


def environment(target: Target, database_url: str) -> dict[str, Any]:
    """What the numbers are numbers *of*."""
    try:
        commit = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:  # noqa: BLE001 - a load run outside a checkout is still valid
        commit = "unknown"

    cpus = "unknown"
    try:
        import os

        cpus = str(os.cpu_count())
    except Exception:  # noqa: BLE001
        pass

    return {
        "started_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "commit": commit,
        "python": platform.python_version(),
        "platform": platform.platform(),
        "cpu_count": cpus,
        "target": target.base_url,
        "database": database_url.rsplit("@", 1)[-1],
        # The single-worker note matters: rooms are in-process state, so the API is
        # deliberately one uvicorn worker and this is a per-process ceiling, not a
        # per-machine one. See DECISIONS.md, "known sharp edges".
        "api_workers": 1,
    }


async def check_target(target: Target) -> None:
    async with httpx.AsyncClient(timeout=10) as http:
        try:
            response = await http.get(f"{target.base_url}/healthz")
        except httpx.HTTPError as exc:
            raise SystemExit(
                f"no API at {target.base_url} ({exc}). Start one with:\n"
                f"  loadtest/target.sh start"
            ) from exc
    if response.status_code != 200:
        raise SystemExit(f"{target.base_url}/healthz answered {response.status_code}")


async def main() -> None:
    parser = argparse.ArgumentParser(description="Meadow load and performance harness")
    parser.add_argument("--base-url", default="http://127.0.0.1:8099")
    parser.add_argument("--database-url", default=DEFAULT_DB)
    parser.add_argument(
        "--suite",
        default="full",
        choices=[
            "full",
            "quick",
            "rest",
            "editors",
            "cursors",
            "compaction",
            "resilience",
            # Not in "full": the capacity sweep escalates until things break, takes
            # much longer, and its room ceiling is only meaningful against a target
            # started with MEADOW_LOAD_ROOM_CAP raised. Asked for explicitly.
            "capacity",
        ],
    )
    parser.add_argument("--out", default="loadtest/results")
    args = parser.parse_args()

    target = Target(args.base_url)
    await check_target(target)

    quick = args.suite == "quick"
    want = {args.suite} if args.suite not in ("full", "quick") else {
        "rest",
        "editors",
        "cursors",
        "compaction",
        "resilience",
    }

    results: dict[str, Any] = {"environment": environment(target, args.database_url)}
    tables: list[str] = []
    started = time.perf_counter()

    def record(key: str, value: dict[str, Any], heading: str) -> None:
        series = value.pop("_series", [])
        results[key] = value
        print(f"\n=== {heading} ===")
        print(json.dumps(value, indent=2))
        if series:
            rendered = table(series)
            print(rendered)
            tables.append(f"### {heading}\n\n{rendered}\n")

    if "rest" in want:
        for concurrency in ([16] if quick else [8, 16, 32, 64]):
            record(
                f"rest_reads_c{concurrency}",
                await rest.run_reads(target, concurrency=concurrency, duration=8 if quick else 15),
                f"REST reads, {concurrency} concurrent clients",
            )
        record(
            "auth_logins",
            await rest.run_logins(target, concurrency=16, duration=8 if quick else 15),
            "Login throughput (argon2id bound)",
        )

    if "editors" in want:
        record("room_cap", await editors.run_room_cap(target), "Room capacity limit")
        for count in ([10] if quick else [5, 10, 25, 50]):
            record(
                f"editors_paced_{count}",
                await editors.run_editors(
                    target, editors=count, duration=10 if quick else 20, edits_per_second=2.0
                ),
                f"{count} concurrent editors, paced at 2 edits/s each",
            )
        record(
            "editors_saturation_10",
            await editors.run_editors(target, editors=10, duration=10, edits_per_second=0),
            "10 editors, unpaced (finds the ingest ceiling)",
        )

    if "cursors" in want:
        for count in ([10] if quick else [5, 10, 25, 50]):
            record(
                f"cursors_{count}",
                await cursors.run_cursors(target, peers_count=count, duration=10),
                f"Cursor propagation, {count} peers in the room",
            )

    if "compaction" in want:
        for updates, distinct in ([(1000, None)] if quick else
                                  [(500, None), (2000, None), (2000, 50), (5000, 25)]):
            label = f"{updates} updates" + (f" over {distinct} objects" if distinct else "")
            record(
                f"compaction_{updates}_{distinct or 'new'}",
                await compaction.run_compaction(
                    target, args.database_url, updates=updates, distinct_objects=distinct
                ),
                f"Compaction: {label}",
            )

    if "capacity" in want:
        record(
            "capacity_sockets",
            await capacity.run_socket_ceiling(target, step=250, limit=15000, boards=60),
            "Concurrent websocket ceiling (across many boards)",
        )
        record(
            "capacity_editing_room",
            await capacity.run_editing_room_ceiling(
                target, editor_counts=(50, 100, 200, 400), duration=15, settle_timeout=900
            ),
            "Editing-room ceiling (one board, everybody writing)",
        )
        record(
            "capacity_rest_under_sockets",
            await capacity.run_rest_under_socket_load(target, sockets=400),
            "REST latency while holding open websockets",
        )
        record(
            "capacity_rest",
            await capacity.run_rest_ceiling(target),
            "REST throughput as concurrency climbs",
        )

    if "resilience" in want:
        record(
            "reconnect_storm",
            await resilience.run_reconnect_storm(target, clients=30, rounds=3 if quick else 5),
            "Reconnect storm (every client of a board at once)",
        )
        record(
            "refusal_under_load",
            await resilience.run_refusal_under_load(target),
            "Handshake refusal under load",
        )

    results["environment"]["wall_seconds"] = round(time.perf_counter() - started, 1)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(UTC).strftime("%Y%m%d-%H%M%S")
    json_path = out / f"run-{stamp}.json"
    json_path.write_text(json.dumps(results, indent=2))

    report = render_report(results, tables)
    report_path = out / f"report-{stamp}.md"
    report_path.write_text(report)
    (out / "latest.md").write_text(report)
    (out / "latest.json").write_text(json.dumps(results, indent=2))

    print(f"\nwrote {json_path}\nwrote {report_path}")


def render_report(results: dict[str, Any], tables: list[str]) -> str:
    env = results["environment"]
    lines = [
        "# Meadow load and performance run",
        "",
        f"- **commit** `{env['commit']}`",
        f"- **when** {env['started_at']}",
        f"- **host** {env['platform']}, {env['cpu_count']} logical CPUs, "
        f"Python {env['python']}",
        f"- **target** {env['target']}, {env['api_workers']} uvicorn worker, "
        f"rate limiting off",
        f"- **wall** {env.get('wall_seconds')}s",
        "",
        "Load generator and server share this machine, so both compete for the same "
        "cores. Latencies are therefore pessimistic and throughput is a floor, not a "
        "ceiling.",
        "",
        "## Headline numbers",
        "",
    ]

    headline: list[str] = ["| what | measured |", "|---|---|"]

    cap = results.get("room_cap")
    if cap:
        headline.append(
            f"| Concurrent sockets per board | **{cap['sockets_accepted']}** accepted, "
            f"the next refused with close {cap['overflow_close_code']} "
            f"({'as configured' if cap['refused_correctly'] else 'MISMATCH'}) |"
        )

    paced_keys = sorted(
        (k for k in results if k.startswith("editors_paced_")),
        key=lambda k: results[k]["editors"],
    )
    for key in paced_keys:
        r = results[key]
        headline.append(
            f"| {r['editors']} editors, paced | {r['offered_writes_per_s']} writes/s, "
            f"{r['lost_updates']} lost, converged: {r['converged']} |"
        )

    sat = results.get("editors_saturation_10")
    if sat:
        headline.append(
            f"| Update ingest ceiling | **{sat['ingest_writes_per_s']} updates/s** "
            f"sustained ({sat['offered_writes_per_s']}/s offered, "
            f"{sat['settle_s']}s to drain, {sat['lost_updates']} lost) |"
        )

    cursor_keys = sorted(
        (k for k in results if k.startswith("cursors_")),
        key=lambda k: results[k]["peers"],
    )
    for key in cursor_keys:
        r = results[key]
        s = r["series"][0]
        headline.append(
            f"| Cursor propagation, {r['peers']} peers | p50 **{s['p50']} ms**, "
            f"p95 **{s['p95']} ms**, p99 {s['p99']} ms, "
            f"delivery {r['delivery_ratio']} |"
        )

    for key in sorted(k for k in results if k.startswith("compaction_")):
        r = results[key]
        headline.append(
            f"| Compaction, {r['updates_written']} updates "
            f"({r['regime']}) | {r['fold_updates_per_s']} updates/s, "
            f"{r['log_rows_before']} rows -> {r['log_rows_after']}, "
            f"{r['compression_ratio']}x bytes |"
        )

    rest_keys = sorted(
        (k for k in results if k.startswith("rest_reads_c")),
        key=lambda k: results[k]["concurrency"],
    )
    for key in rest_keys:
        r = results[key]
        headline.append(
            f"| REST reads, {r['concurrency']} clients | {r['requests_per_s']} req/s, "
            f"{r['errors']} errors |"
        )

    refusal = results.get("refusal_under_load")
    if refusal:
        headline.append(
            f"| Handshake refusal under load | every bad token refused: "
            f"**{refusal['every_bad_token_refused']}**, valid token still accepted: "
            f"{refusal['valid_token_still_accepted']} |"
        )

    lines += headline + ["", "## Per-operation latency", ""] + tables
    lines += [
        "",
        "## Raw",
        "",
        "```json",
        json.dumps({k: v for k, v in results.items() if k != "environment"}, indent=2),
        "```",
        "",
    ]
    return "\n".join(lines)


if __name__ == "__main__":
    asyncio.run(main())
