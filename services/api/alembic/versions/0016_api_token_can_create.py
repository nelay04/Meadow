"""api tokens: let a fine-grained token make glades

A fine-grained token could only ever work on glades somebody had listed for it by hand,
so an assistant that needed a new one had to be handed a classic token instead - the
whole account, to make one glade. `can_create` is that permission on its own. A glade
made through a token is granted straight back to it with edit and delete, so the token
can work on what it made without being able to see anything else.

Existing tokens default to false: nothing that was minted before this gains a
permission by the migration running.

Revision ID: 0016_api_token_can_create
Revises: 0015_api_tokens
Create Date: 2026-09-14
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0016_api_token_can_create"
down_revision: str | None = "0015_api_tokens"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "api_tokens",
        sa.Column("can_create", sa.Boolean(), nullable=False, server_default="false"),
    )


def downgrade() -> None:
    op.drop_column("api_tokens", "can_create")
