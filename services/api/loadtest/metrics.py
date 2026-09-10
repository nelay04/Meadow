"""Latency samples and the statistics taken from them.

Every number this harness reports comes through `Series`. It keeps raw samples rather
than a running summary because the interesting statistics here are tail percentiles,
and a tail cannot be recovered from a mean and a count.

Percentiles use the nearest-rank method on sorted samples. No interpolation: with a
few thousand samples the difference is under a microsecond, and an interpolated p99
invites the question of which of the nine definitions was used.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Any


@dataclass
class Series:
    """Timed observations of one operation, plus what went wrong."""

    name: str
    unit: str = "ms"
    samples: list[float] = field(default_factory=list)
    errors: dict[str, int] = field(default_factory=dict)
    started_at: float = field(default_factory=time.perf_counter)
    ended_at: float | None = None

    def add(self, value: float) -> None:
        self.samples.append(value)

    def fail(self, reason: str) -> None:
        self.errors[reason] = self.errors.get(reason, 0) + 1

    def stop(self) -> None:
        if self.ended_at is None:
            self.ended_at = time.perf_counter()

    @property
    def elapsed(self) -> float:
        return (self.ended_at or time.perf_counter()) - self.started_at

    @property
    def count(self) -> int:
        return len(self.samples)

    @property
    def error_count(self) -> int:
        return sum(self.errors.values())

    def percentile(self, q: float) -> float:
        """The nearest-rank percentile, `q` in 0..100."""
        if not self.samples:
            return math.nan
        ordered = sorted(self.samples)
        rank = max(1, math.ceil(q / 100 * len(ordered)))
        return ordered[min(rank, len(ordered)) - 1]

    def summary(self) -> dict[str, Any]:
        ordered = sorted(self.samples)
        total = self.count + self.error_count
        return {
            "name": self.name,
            "unit": self.unit,
            "count": self.count,
            "errors": self.error_count,
            "error_detail": dict(self.errors),
            # Share of attempts that failed. Reported alongside throughput because a
            # fast run that refused half its work is not a fast run.
            "error_rate": (self.error_count / total) if total else 0.0,
            "elapsed_s": round(self.elapsed, 3),
            "throughput_per_s": round(self.count / self.elapsed, 1) if self.elapsed else 0.0,
            "min": round(ordered[0], 3) if ordered else None,
            "p50": round(self.percentile(50), 3) if ordered else None,
            "p95": round(self.percentile(95), 3) if ordered else None,
            "p99": round(self.percentile(99), 3) if ordered else None,
            "max": round(ordered[-1], 3) if ordered else None,
            "mean": round(sum(ordered) / len(ordered), 3) if ordered else None,
        }


class Timer:
    """`async with Timer(series):` - records the elapsed milliseconds, or the error."""

    def __init__(self, series: Series) -> None:
        self.series = series
        self.start = 0.0

    async def __aenter__(self) -> Timer:
        self.start = time.perf_counter()
        return self

    async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> bool:
        if exc_type is None:
            self.series.add((time.perf_counter() - self.start) * 1000)
        else:
            self.series.fail(f"{exc_type.__name__}: {str(exc)[:80]}")
        # Swallow the failure: a load run counts errors, it does not stop on one.
        return True


def table(series: list[Series]) -> str:
    """The summaries as a markdown table, for the report and for the terminal."""
    head = (
        "| operation | ok | err | rate/s | p50 | p95 | p99 | max |\n"
        "|---|---:|---:|---:|---:|---:|---:|---:|\n"
    )
    rows = []
    for s in series:
        d = s.summary()
        rows.append(
            f"| {d['name']} | {d['count']} | {d['errors']} | {d['throughput_per_s']} | "
            f"{d['p50']} | {d['p95']} | {d['p99']} | {d['max']} |"
        )
    return head + "\n".join(rows)
