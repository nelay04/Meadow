"""sharing: a link anyone can open, invitations by address, and a board-wide lock

Three things arrive together because they are one feature seen from three angles.

`boards.share_mode` is the whole of it in one column. `restricted` is what every board
has always been - reachable only through a workspace or an explicit grant - and
`public` means the link in `share_links` opens the board for anybody who has it,
signed in or not, at `boards.share_role`. That is the mode a link posted to a chat or
a timeline needs, and it is off by default: a board that became world-readable because
somebody left a default alone is the failure worth designing against.

`share_links.token` is stored raw, unlike every other token in this schema. It is not
an oversight and it is not the same kind of secret. An activation link is single use
and is never shown again, so a digest is enough to recognise it; a share link is a
*capability URL* the owner copies out of the dialog repeatedly, which means the server
has to be able to produce it, which means a digest cannot work. The mitigation is that
it exists only while a board is being shared, and rotating it is one button: a new row
replaces the old, which is left revoked rather than deleted so a link that stops
working can be told from one that never existed.

`board_invitations` covers the case an email invite cannot: an address with no account
behind it yet. Nothing is mailed there - see `app/services/sharing.py` - the owner is
handed a link to pass on personally, and the grant is applied when the account opens.

`boards.locked_at` / `locked_by` is the owner's edit lock. Distinct from the per-tab
lock the client has always had, which is a guard against your own hands and is not
recorded anywhere: this one is on the board, everyone sees it, and only the owner
lifts it. It is enforced where the role is - the websocket handshake - so a client
that ignores it still cannot write.

Revision ID: 0008_sharing
Revises: 0007_board_kinds
Create Date: 2026-09-03
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = "0008_sharing"
down_revision: str | None = "0007_board_kinds"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Created in 0001. `create_type=False` so referencing it here does not try to make it
# a second time.
board_role = postgresql.ENUM(
    "owner", "editor", "commenter", "viewer", name="board_role", create_type=False
)


def upgrade() -> None:
    op.add_column(
        "boards",
        sa.Column("share_mode", sa.String(), nullable=False, server_default="restricted"),
    )
    op.create_check_constraint(
        "ck_boards_share_mode", "boards", "share_mode in ('restricted', 'public')"
    )
    # What the public link grants. Only the two roles a link may hand out: `owner` over
    # a link would let a stranger delete the board, and `commenter` is inert in v1.
    op.add_column(
        "boards",
        sa.Column("share_role", sa.String(), nullable=False, server_default="viewer"),
    )
    op.create_check_constraint(
        "ck_boards_share_role", "boards", "share_role in ('viewer', 'editor')"
    )

    op.add_column("boards", sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column(
        "boards",
        sa.Column(
            "locked_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )

    op.create_table(
        "share_links",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "board_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("token", sa.String(), nullable=False, unique=True),
        sa.Column(
            "created_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )
    # One live link per board. Rotation writes the new row and revokes the old in one
    # transaction; without this a partial failure could leave two working links and no
    # way to say which one the dialog is showing.
    op.create_index(
        "uq_share_links_board_active",
        "share_links",
        ["board_id"],
        unique=True,
        postgresql_where=sa.text("revoked_at is null"),
    )

    op.create_table(
        "board_invitations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "board_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("boards.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # citext, matching `users.email`: the address this is waiting on is matched
        # against that column when an account opens, and a case difference between the
        # two would silently strand the invitation.
        sa.Column("email", postgresql.CITEXT(), nullable=False),
        sa.Column("role", board_role, nullable=False),
        sa.Column("token", sa.String(), nullable=False, unique=True),
        sa.Column(
            "invited_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint("role in ('editor', 'viewer')", name="ck_board_invitations_role"),
    )
    # One outstanding invitation per address per board. Inviting the same person twice
    # should change the role on the invitation they already hold, not leave two links
    # in the world disagreeing about what they were offered.
    op.create_index(
        "uq_board_invitations_pending",
        "board_invitations",
        ["board_id", "email"],
        unique=True,
        postgresql_where=sa.text("accepted_at is null and revoked_at is null"),
    )
    # The lookup an opening account makes: every invitation still waiting on this
    # address, across every board.
    op.create_index("ix_board_invitations_email", "board_invitations", ["email"])


def downgrade() -> None:
    op.drop_index("ix_board_invitations_email", table_name="board_invitations")
    op.drop_index("uq_board_invitations_pending", table_name="board_invitations")
    op.drop_table("board_invitations")
    op.drop_index("uq_share_links_board_active", table_name="share_links")
    op.drop_table("share_links")
    op.drop_column("boards", "locked_by")
    op.drop_column("boards", "locked_at")
    op.drop_constraint("ck_boards_share_role", "boards", type_="check")
    op.drop_column("boards", "share_role")
    op.drop_constraint("ck_boards_share_mode", "boards", type_="check")
    op.drop_column("boards", "share_mode")
