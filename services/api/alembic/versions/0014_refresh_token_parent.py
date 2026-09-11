"""refresh token parent: recover a rotation the browser never received

A refresh rotates the token on the server whether or not the response makes it back.
When it does not - a tab closed or reloaded with the request in flight, a dropped
connection - the browser is left holding the spent token, and its next refresh was
treated as theft and ended the session.

`parent_id` names the token each one was minted in exchange for, which is what lets
the refresh route tell "the browser that holds the live token's own parent" apart from
"some older copy of the lineage". See `settings.refresh_rotation_recovery_seconds`.

Nullable, and null on every existing row: those families simply cannot recover a lost
rotation until they next rotate, which is the behaviour they had before.

Revision ID: 0014_refresh_token_parent
Revises: 0013_board_password_recovery
Create Date: 2026-09-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0014_refresh_token_parent"
down_revision: str | None = "0013_board_password_recovery"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "refresh_tokens",
        sa.Column(
            "parent_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("refresh_tokens.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("refresh_tokens", "parent_id")
