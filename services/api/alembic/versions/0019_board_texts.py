"""board texts: what is written on each board, per object, for search

A derived copy of the CRDT log's text, one row per object, rewritten by the worker, with
a trigram index so a search can match inside words. `board_search_state` records when
each board was last read. Boards with a password are never copied here.

Revision ID: 0019_board_texts
Revises: 0018_api_token_ends_at
Create Date: 2026-09-24
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0019_board_texts"
down_revision: str | None = "0018_api_token_ends_at"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Trusted since Postgres 13, so the database owner may create it without a superuser.
    op.execute("create extension if not exists pg_trgm")
    op.create_table(
        "board_texts",
        sa.Column(
            "board_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("object_id", sa.String(), primary_key=True),
        sa.Column("object_type", sa.String(), nullable=False),
        sa.Column("body", sa.String(), nullable=False),
    )
    op.create_index(
        "ix_board_texts_body_trgm",
        "board_texts",
        ["body"],
        postgresql_using="gin",
        postgresql_ops={"body": "gin_trgm_ops"},
    )
    op.create_table(
        "board_search_state",
        sa.Column(
            "board_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("indexed_at", sa.DateTime(timezone=True), nullable=False),
    )


def downgrade() -> None:
    op.drop_table("board_search_state")
    op.drop_index("ix_board_texts_body_trgm", table_name="board_texts")
    op.drop_table("board_texts")
    # The extension stays: dropping it could take another index with it.
