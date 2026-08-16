"""arq worker entry point.

    cd services/api && .venv/bin/arq app.workers.settings.WorkerSettings

Runs as its own process and its own container, not inside the API. Compaction merges
whole documents in memory, and a board large enough to matter would otherwise take a
request-serving process down with it.
"""

from logging import getLogger
from typing import Any

from arq.connections import RedisSettings
from arq.cron import cron

from app.config import settings
from app.workers.compaction import compact_board_job, on_shutdown, on_startup, sweep_boards

logger = getLogger("meadow.worker")


async def _startup(ctx: dict[str, Any]) -> None:
    ctx["logger"] = logger
    await on_startup(ctx)
    logger.info("worker started")


class WorkerSettings:
    functions = [compact_board_job]  # noqa: RUF012 - arq reads these as plain attributes
    cron_jobs = [  # noqa: RUF012
        # Every ten minutes, offset off the hour. Frequent enough that a busy board
        # never accumulates a log worth worrying about, rare enough that an idle
        # deployment is doing nothing almost all of the time.
        cron(sweep_boards, minute={3, 13, 23, 33, 43, 53}, run_at_startup=False),
    ]
    on_startup = _startup
    on_shutdown = on_shutdown
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    # One board at a time. Compaction is memory-bound rather than IO-bound, and this
    # shares a small VPS with Postgres and the API.
    max_jobs = 2
    job_timeout = 300
    # The worker stamps a key in Redis this often, with a TTL one second longer, and
    # `arq ... --check` reads it. That is what the container healthcheck runs, so the
    # interval is also how quickly a wedged event loop stops looking alive. arq's
    # default is an hour, which would report a dead worker as healthy for most of a
    # morning.
    health_check_interval = 30
