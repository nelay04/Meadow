"""oauth connect: let assistants sign in instead of being handed a pasted token

Web assistants connect to a remote MCP server by signing in with OAuth and have no field
for a pasted token. `oauth_clients` holds the assistants that registered themselves,
`oauth_refresh_tokens` the rotating refresh tokens, and two columns on `api_tokens` tie
a token to the assistant it was issued to and give its secret a short life of its own.

Revision ID: 0017_oauth_connect
Revises: 0016_api_token_can_create
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0017_oauth_connect"
down_revision: str | None = "0016_api_token_can_create"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "oauth_clients",
        sa.Column("id", sa.String(), primary_key=True),
        sa.Column("name", sa.String(), nullable=False),
        sa.Column("redirect_uris", postgresql.ARRAY(sa.String()), nullable=False),
        sa.Column("secret_hash", sa.String(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.add_column(
        "api_tokens",
        sa.Column(
            "oauth_client_id",
            sa.String(),
            sa.ForeignKey("oauth_clients.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "api_tokens", sa.Column("access_expires_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "oauth_refresh_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "api_token_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("api_tokens.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_id", sa.String(), nullable=False),
        sa.Column("token_hash", sa.String(), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("spent_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )


def downgrade() -> None:
    op.drop_table("oauth_refresh_tokens")
    op.drop_column("api_tokens", "access_expires_at")
    op.drop_column("api_tokens", "oauth_client_id")
    op.drop_table("oauth_clients")
