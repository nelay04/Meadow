"""mcp_events: one row per mutation an assistant made on a glade

The audit trail from the October review, tier 3. Metadata about an edit and never the
edit itself: what changed stays in the CRDT log, as ARCHITECTURE 3 requires.

`api_token_id` is `set null` rather than `cascade`, so revoking a token does not erase
what it did. `board_id` and `user_id` cascade: with the glade or the account gone there
is nothing left for the row to be about.

Revision ID: 0020_mcp_events
Revises: 0019_board_texts
Create Date: 2026-10-05
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0020_mcp_events"
down_revision: str | None = "0019_board_texts"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "mcp_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("operation_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "board_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "api_token_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("api_tokens.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("tool", sa.String(), nullable=False),
        sa.Column("requested", sa.Integer(), nullable=False),
        sa.Column("accepted", sa.Integer(), nullable=False),
        sa.Column("duration_ms", sa.Integer(), nullable=False),
        sa.Column("outcome", sa.String(), nullable=False),
        sa.Column("reason", sa.String(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.CheckConstraint(
            "outcome in ('applied', 'refused', 'failed')", name="ck_mcp_events_outcome"
        ),
    )
    op.create_index("ix_mcp_events_board_created", "mcp_events", ["board_id", "created_at"])
    op.create_index("ix_mcp_events_operation", "mcp_events", ["operation_id"])


def downgrade() -> None:
    op.drop_index("ix_mcp_events_operation", table_name="mcp_events")
    op.drop_index("ix_mcp_events_board_created", table_name="mcp_events")
    op.drop_table("mcp_events")
