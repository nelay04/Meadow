"""Asking the worker to re-read a board's text for search, soon after it is edited.

The worker's once-a-minute pass is what guarantees the search index catches up, and it
still runs. On its own it made search feel broken in the most ordinary case: write
something on a glade, go back to the list, search for it, and find nothing for up to a
minute. So every persisted update also nudges the worker about its board.

Debounced here, in the API process, rather than enqueued per update. An edit arrives as
one update per keystroke burst, and a job each would re-read the board dozens of times
to produce the same text. The first update on a board starts a short timer; updates
inside it ride along; when it fires one job is queued, and that job reads everything
written up to then.

Best effort by design. A nudge that cannot reach Redis is logged and dropped: the
update itself is already committed, and the minute pass will index it anyway. Nothing
here may ever fail a write.
"""

import asyncio
import uuid
from logging import getLogger

from arq import create_pool
from arq.connections import ArqRedis, RedisSettings
from redis.exceptions import RedisError

from app.config import settings

logger = getLogger(__name__)

# How long after the first edit in a burst the board is read. Short enough that going
# back to the list and searching finds it; long enough that a sentence being typed is
# one job rather than twenty.
DEBOUNCE_SECONDS = 2.0

INDEX_JOB = "index_board_job"


def job_id(board_id: uuid.UUID) -> str:
    """One queued job per board. arq drops an enqueue whose id is already queued."""
    return f"index:{board_id}"


class SearchQueue:
    def __init__(self) -> None:
        self._pool: ArqRedis | None = None
        self._timers: dict[uuid.UUID, asyncio.TimerHandle] = {}
        self._tasks: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        try:
            self._pool = await create_pool(RedisSettings.from_dsn(settings.redis_url))
        except (RedisError, OSError):
            # Search still works without it, a minute behind. Not worth refusing to boot.
            logger.warning("search indexing nudges are off: redis is unreachable")
            self._pool = None

    async def close(self) -> None:
        for timer in self._timers.values():
            timer.cancel()
        self._timers.clear()
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._pool is not None:
            await self._pool.aclose()
            self._pool = None

    def nudge(self, board_id: uuid.UUID) -> None:
        """Note that this board changed. Cheap, synchronous, and never raises."""
        if self._pool is None or board_id in self._timers:
            return
        try:
            loop = asyncio.get_running_loop()
        except RuntimeError:
            return
        self._timers[board_id] = loop.call_later(DEBOUNCE_SECONDS, self._fire, board_id)

    def _fire(self, board_id: uuid.UUID) -> None:
        self._timers.pop(board_id, None)
        task = asyncio.get_running_loop().create_task(self._enqueue(board_id))
        # Held until done: a task nobody references can be collected mid-flight.
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _enqueue(self, board_id: uuid.UUID) -> None:
        pool = self._pool
        if pool is None:
            return
        try:
            await pool.enqueue_job(INDEX_JOB, str(board_id), _job_id=job_id(board_id))
        except (RedisError, OSError):
            logger.warning("could not queue search indexing for board %s", board_id)


#: One per process, started and closed by the app's lifespan.
search_queue = SearchQueue()
