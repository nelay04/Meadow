"""trash: a deleted glade or lea is recoverable for a while

Deleting was final and immediate, and it took the CRDT log with it by cascade. That is
the one action in the app with no way back from a misclick, on the one thing the app
exists to hold.

So `boards` gets a `deleted_at`, and it is the row's own account of whether it is
there. `resolve_role` refuses a board that has one, which is what makes a board in the
trash unreachable everywhere at once - every router and the websocket handshake resolve
through that function, per ARCHITECTURE 7, so none of them needs a filter of its own.
Restoring sets the column back to null and the board is simply there again, with its
updates, snapshots, members and share link untouched, because nothing ever moved.

The permanent delete is the old hard delete, unchanged, reached from the trash by hand
or by the worker's sweep once the retention window has passed.

Revision ID: 0010_board_trash
Revises: 0009_access_requests
Create Date: 2026-09-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0010_board_trash"
down_revision: str | None = "0009_access_requests"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("boards", sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "boards",
        sa.Column(
            "deleted_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Partial: the column is null on every board that is simply there, and the sweep
    # only ever asks about the ones that are not.
    op.create_index(
        "ix_boards_deleted_at",
        "boards",
        ["deleted_at"],
        postgresql_where=sa.text("deleted_at is not null"),
    )


def downgrade() -> None:
    # Boards in the trash come back rather than going with the column. Downgrading is
    # not a reason to finish somebody's deletion for them, and the pre-trash schema
    # reads a row with no `deleted_at` as an ordinary board, which is what they were.
    op.drop_index("ix_boards_deleted_at", table_name="boards")
    op.drop_column("boards", "deleted_by")
    op.drop_column("boards", "deleted_at")
