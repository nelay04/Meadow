"""sessions: a refresh-token family is a signed-in browser, and can be listed

There was no way to answer "where am I signed in?". The rows to answer it with already
existed - `refresh_tokens` records a user agent, an IP and a creation time on every
token it issues, and `family_id` already groups the ones belonging to a single browser
- but the login time was only recoverable by grouping over the whole lineage, which is
work on every read and, worse, work that stops being possible the day spent rows start
being pruned (ARCHITECTURE 6 has an hourly cleanup for exactly that).

So the family's start is carried forward onto every token in it. A live row is then a
self-contained account of one session: when it began, when it last renewed, from what
browser and what address. Listing sessions becomes a filter over live rows, and pruning
spent ones takes nothing with it.

Revision ID: 0011_session_log
Revises: 0010_board_trash
Create Date: 2026-09-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0011_session_log"
down_revision: str | None = "0010_board_trash"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Nullable first, backfilled, then tightened: the column is not null in the model,
    # and an existing deployment has rows in it.
    op.add_column(
        "refresh_tokens",
        sa.Column("family_started_at", sa.DateTime(timezone=True), nullable=True),
    )
    # The family's first token is when that browser signed in. Every row in the family
    # gets it, including the spent ones, so a rotation can read it off the row it is
    # replacing rather than re-deriving it.
    op.execute(
        """
        update refresh_tokens as t
        set family_started_at = f.started_at
        from (
            select family_id, min(created_at) as started_at
            from refresh_tokens
            group by family_id
        ) as f
        where f.family_id = t.family_id
        """
    )
    # The same `now()` default `created_at` carries. A login writes both and lets the
    # database time them, so the two can never disagree about which came first.
    op.alter_column(
        "refresh_tokens",
        "family_started_at",
        nullable=False,
        server_default=sa.text("now()"),
    )

    # The sessions list asks one question - which of this user's tokens are still live
    # - and this is its index. Partial, because a spent or expired token is never a
    # session and the table keeps those forever on purpose.
    op.create_index(
        "ix_refresh_tokens_live",
        "refresh_tokens",
        ["user_id", "expires_at"],
        postgresql_where=sa.text("revoked_at is null"),
    )


def downgrade() -> None:
    op.drop_index("ix_refresh_tokens_live", table_name="refresh_tokens")
    op.drop_column("refresh_tokens", "family_started_at")
