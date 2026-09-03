"""access requests: a way in to a restricted board that does not leave the app

A restricted board answers a stranger holding its address with a flat refusal, and
that was the whole of it: the link worked, the door did not, and the only route
forward was to go and find the owner somewhere else. So the link was either useless or
the board was made public, which is not a choice anybody should be pushed into by a
missing screen.

One row per person per board, rewritten on a second ask rather than appended to.
Asking twice is the same request made again, and a table that recorded each attempt
would turn one persistent person into a page of noise for the owner.

Nothing in this table is access. It records what was asked for and what was decided;
the grant, if there is one, is a `board_members` row written by the owner's decision,
resolved through `app/services/permissions.py` like every other grant.

Revision ID: 0009_access_requests
Revises: 0008_sharing
Create Date: 2026-09-04
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0009_access_requests"
down_revision: str | None = "0008_sharing"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Created in 0001, so this only references it.
board_role = postgresql.ENUM(
    "owner", "editor", "commenter", "viewer", name="board_role", create_type=False
)


def upgrade() -> None:
    op.create_table(
        "board_access_requests",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
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
        sa.Column("role", board_role, nullable=False),
        sa.Column("status", sa.String(), nullable=False, server_default="pending"),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("decided_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "decided_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.UniqueConstraint("board_id", "user_id", name="uq_board_access_requests_board_user"),
        sa.CheckConstraint(
            "status in ('pending', 'granted', 'declined')",
            name="ck_board_access_requests_status",
        ),
        sa.CheckConstraint("role in ('viewer', 'editor')", name="ck_board_access_requests_role"),
    )


def downgrade() -> None:
    op.drop_table("board_access_requests")
