"""account activation: an unanswered address cannot sign in

Registration is not finished when the row is written; it is finished when the address
answers. `users.activated_at` is that answer, and `email_verifications` holds the links,
hashed and single-use like the refresh tokens next to them.

Existing accounts are backfilled as activated. They registered under rules that never
asked them to confirm, and locking people out of working accounts to enforce a rule
retroactively is not a migration's job.

Revision ID: 0005_account_activation
Revises: 0004_google_avatar_source
Create Date: 2026-08-19
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0005_account_activation"
down_revision: str | None = "0004_google_avatar_source"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "users", sa.Column("activated_at", sa.DateTime(timezone=True), nullable=True)
    )
    op.execute("update users set activated_at = created_at where activated_at is null")

    op.create_table(
        "email_verifications",
        sa.Column("id", sa.UUID(), nullable=False),
        sa.Column("user_id", sa.UUID(), nullable=False),
        # sha256 of the raw token. The link exists in the mail and nowhere else.
        sa.Column("token_hash", sa.String(), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.ForeignKeyConstraint(["user_id"], ["users.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint("token_hash"),
    )
    op.create_index("ix_email_verifications_user_id", "email_verifications", ["user_id"])


def downgrade() -> None:
    op.drop_index("ix_email_verifications_user_id", table_name="email_verifications")
    op.drop_table("email_verifications")
    op.drop_column("users", "activated_at")
