"""Background jobs. ARCHITECTURE 3: "this compaction job is not optional"."""

from app.workers.compaction import compact_board_job, sweep_boards

__all__ = ["compact_board_job", "sweep_boards"]
