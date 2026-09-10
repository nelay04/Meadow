"""board password recovery: the way back in when the owner forgot it

Setting and clearing a board password have never asked for the current one, and that
was always meant to be the escape hatch from forgetting it. It was not one. Both routes
are reached from inside the board, and the forgotten password is what is holding the
board shut - so the hatch was on the far side of the door it opens.

So: an owner asks, a six-digit code goes to the address on their account, and spending
it mints a fresh random password that lasts two hours. Not the old password, which
nobody has - it is argon2id, like an account's. Two hours because the temporary one
exists to get an owner back to the control that sets a real one, not to run a board on.

`boards.password_expires_at` is when the temporary one stops working, and it stops
working into a *shut* board rather than an open one: the hash stays, `resolve_access`
keeps asking, and the answer is another recovery. A lock whose key expired into an
unlocked door would be the one failure mode this feature must not have.

Revision ID: 0013_board_password_recovery
Revises: 0012_board_passwords
Create Date: 2026-09-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0013_board_password_recovery"
down_revision: str | None = "0012_board_passwords"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "boards", sa.Column("password_expires_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.create_table(
        "board_password_resets",
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
        # sha256, not argon2id: a million possible codes means the guessing is stopped
        # by the attempt counter and the rate limit, never by the cost of one hash.
        sa.Column("code_hash", sa.String(), nullable=False),
        sa.Column("attempts", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # One live request per owner per board. Asking again rewrites this row, which is
        # what keeps two working codes out of one inbox.
        sa.UniqueConstraint("board_id", "user_id", name="uq_board_password_resets_board_user"),
    )


def downgrade() -> None:
    op.drop_table("board_password_resets")
    op.drop_column("boards", "password_expires_at")
