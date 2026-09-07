"""Background jobs. ARCHITECTURE 3: "this compaction job is not optional"."""

from app.workers.compaction import compact_board_job, sweep_boards
from app.workers.trash import sweep_trash

__all__ = ["compact_board_job", "sweep_boards", "sweep_trash"]
