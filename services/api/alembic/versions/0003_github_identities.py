"""github sign-in: third-party identities, passwordless accounts, avatar source

Adds the table behind "sign in with GitHub" and the two columns on `users` that make
an OAuth-created account possible at all.

`password_hash` becomes nullable because an account created through GitHub has no
password. A placeholder hash would have avoided the migration and would have been a
credential nobody holds the input to - unrevocable, unauditable, and indistinguishable
from a real one. `app.api.v1.auth.login` reads null as "no password login here" and
refuses with the same message as a wrong password.

Revision ID: 0003_github_identities
Revises: 0002_board_thumbnails
Create Date: 2026-08-17
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0003_github_identities"
down_revision: str | None = "0002_board_thumbnails"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("users", "password_hash", existing_type=sa.String(), nullable=True)
    op.add_column(
        "users",
        sa.Column("avatar_source", sa.String(), nullable=False, server_default="none"),
    )
    op.create_check_constraint(
        "ck_users_avatar_source", "users", "avatar_source in ('none', 'github')"
    )

    op.create_table(
        "user_identities",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        sa.Column("provider", sa.String(), nullable=False),
        sa.Column("provider_user_id", sa.String(), nullable=False),
        sa.Column("username", sa.String(), nullable=False),
        sa.Column("provider_name", sa.String(), nullable=True),
        sa.Column("provider_email", sa.String(), nullable=True),
        sa.Column("avatar_url", sa.String(), nullable=True),
        sa.Column("profile_url", sa.String(), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.Column(
            "last_login_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # CASCADE: an identity is meaningless without the account it points at, and an
        # orphan would keep a GitHub account bound to nothing, which is worse than
        # gone - it would refuse to link anywhere else.
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        # One GitHub account signs in to exactly one Meadow account, and one account
        # holds at most one GitHub identity. Both are enforced here rather than only in
        # the service, because a race between two concurrent callbacks is exactly the
        # case application-level checks miss.
        sa.UniqueConstraint("provider", "provider_user_id", name="uq_user_identities_provider_user"),
        sa.UniqueConstraint("user_id", "provider", name="uq_user_identities_user_provider"),
    )


def downgrade() -> None:
    """Reverses cleanly only while no passwordless account exists.

    Restoring NOT NULL on `password_hash` fails if any GitHub-created account is still
    there, and that is the intended behaviour: the alternative is inventing a hash for
    a real person's account or deleting it, and neither belongs in a migration. Remove
    or give those accounts a password first.
    """
    op.drop_table("user_identities")
    op.drop_constraint("ck_users_avatar_source", "users", type_="check")
    op.drop_column("users", "avatar_source")
    op.alter_column("users", "password_hash", existing_type=sa.String(), nullable=False)
