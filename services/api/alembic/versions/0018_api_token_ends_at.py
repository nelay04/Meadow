"""api token ends_at: a hard end for a connection made by signing in

A token issued by signing in renews itself: every refresh pushes `expires_at` another
thirty days out. `ends_at` is the date the person chose on the consent screen, past
which no refresh reaches. Null keeps the old behaviour, a connection that lasts while it
is used.

Revision ID: 0018_api_token_ends_at
Revises: 0017_oauth_connect
Create Date: 2026-09-15
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0018_api_token_ends_at"
down_revision: str | None = "0017_oauth_connect"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("api_tokens", sa.Column("ends_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("api_tokens", "ends_at")
