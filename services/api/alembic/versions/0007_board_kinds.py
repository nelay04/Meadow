"""glade kinds: a board records what paper it is drawn on

`boards.kind` is a surface, not a second editor. Every kind is the same infinite
canvas over the same CRDT document, so this column changes nothing about how a board
is loaded, synced, or authorised; the client reads it and picks a background.

Existing boards backfill to 'glade', which is exactly what they have always been.

A check constraint rather than a native enum, following `users.avatar_source`: kinds
are expected to be added, and a new one should be one line here rather than an
`ALTER TYPE ... ADD VALUE`.

Revision ID: 0007_board_kinds
Revises: 0006_password_reset_links
Create Date: 2026-08-22
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0007_board_kinds"
down_revision: str | None = "0006_password_reset_links"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "boards",
        sa.Column("kind", sa.String(), nullable=False, server_default="glade"),
    )
    op.create_check_constraint("ck_boards_kind", "boards", "kind in ('glade', 'lea')")


def downgrade() -> None:
    op.drop_constraint("ck_boards_kind", "boards", type_="check")
    op.drop_column("boards", "kind")
