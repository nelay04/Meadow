"""board passwords: a lock on the door that outranks the guest list

Sharing answers "who may open this" three ways - a workspace seat, a board grant, and
the public link - and every one of them is about *who somebody is*. None of them is
any use for the case an owner actually has when they hand an address round a room: let
the people I am telling this to in, and nobody else, whatever else is true.

So: one password per board, and it sits in front of all three. A stranger on a public
link is asked for it, a member is asked for it, and the owner who set it is asked for
it too - the owner is not exempt because an exemption would make the control weaker
than its own label, and because an owner cannot be locked out anyway: setting and
clearing are owner-only routes and neither asks for the current password.

`password_version` is what makes changing one mean something immediately. A successful
verification mints a short-lived signed pass carrying the version it was minted at, and
that version is compared against this column on every websocket handshake and every
revalidation - so a change retires every pass in existence without a table to sweep.

Revision ID: 0012_board_passwords
Revises: 0011_session_log
Create Date: 2026-09-04
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0012_board_passwords"
down_revision: str | None = "0011_session_log"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("boards", sa.Column("password_hash", sa.String(), nullable=True))
    op.add_column(
        "boards", sa.Column("password_set_at", sa.DateTime(timezone=True), nullable=True)
    )
    # Not null with a default, so every board that already exists starts at 0 and the
    # comparison in the handshake never has a null on either side of it.
    op.add_column(
        "boards",
        sa.Column("password_version", sa.Integer(), nullable=False, server_default="0"),
    )


def downgrade() -> None:
    op.drop_column("boards", "password_version")
    op.drop_column("boards", "password_set_at")
    op.drop_column("boards", "password_hash")
