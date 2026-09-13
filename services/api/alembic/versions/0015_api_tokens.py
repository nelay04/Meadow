"""api tokens: personal access tokens for MCP clients and scripts

A client that is not a browser cannot do the session dance - there is no cookie jar to
hold a refresh token and nobody to type a password when it lapses. These are the
credential it holds instead. Stored as a digest, narrowed by scope and an optional
board allow-list, and revocable one at a time. See `app/services/api_tokens.py`.

Revision ID: 0015_api_tokens
Revises: 0014_refresh_token_parent
Create Date: 2026-09-13
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0015_api_tokens"
down_revision: str | None = "0014_refresh_token_parent"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "api_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("prefix", sa.String(), nullable=False),
        sa.Column("scope", sa.String(), nullable=False),
        sa.Column("board_ids", postgresql.ARRAY(postgresql.UUID(as_uuid=True)), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("scope in ('read', 'write')", name="ck_api_tokens_scope"),
    )
    op.create_index(
        "ix_api_tokens_user_live",
        "api_tokens",
        ["user_id"],
        postgresql_where=sa.text("revoked_at is null"),
    )


def downgrade() -> None:
    op.drop_index("ix_api_tokens_user_live", table_name="api_tokens")
    op.drop_table("api_tokens")
