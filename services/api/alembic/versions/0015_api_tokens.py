"""api tokens: personal access tokens for MCP clients and scripts

A client that is not a browser cannot do the session dance - there is no cookie jar to
hold a refresh token and nobody to type a password when it lapses. These are the
credential it holds instead. Two kinds: a classic token is everything its owner can do,
and a fine-grained one names glades in `api_token_grants`, each with its own read, edit
and delete. Stored as a digest and revocable one at a time. See
`app/services/api_tokens.py`.

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
        sa.Column("kind", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.CheckConstraint("kind in ('classic', 'fine_grained')", name="ck_api_tokens_kind"),
    )
    op.create_index(
        "ix_api_tokens_user_live",
        "api_tokens",
        ["user_id"],
        postgresql_where=sa.text("revoked_at is null"),
    )
    op.create_table(
        "api_token_grants",
        sa.Column(
            "token_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("api_tokens.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column(
            "board_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("can_edit", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("can_delete", sa.Boolean(), nullable=False, server_default=sa.false()),
    )


def downgrade() -> None:
    op.drop_table("api_token_grants")
    op.drop_index("ix_api_tokens_user_live", table_name="api_tokens")
    op.drop_table("api_tokens")
