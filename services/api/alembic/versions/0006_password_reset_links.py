"""password reset: one link table, two purposes

`email_verifications` already had the shape a reset link needs - hashed, single use,
expiring - so it grows a `purpose` rather than gaining a near-identical sibling. The
column is checked on redemption, so an activation link cannot be spent at the password
endpoint or the other way round.

Existing rows are activation links, which is what the default says.

Revision ID: 0006_password_reset_links
Revises: 0005_account_activation
Create Date: 2026-08-19
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0006_password_reset_links"
down_revision: str | None = "0005_account_activation"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column(
        "email_verifications",
        sa.Column("purpose", sa.String(), nullable=False, server_default="activation"),
    )
    op.create_check_constraint(
        "ck_email_verifications_purpose",
        "email_verifications",
        "purpose in ('activation', 'password_reset')",
    )


def downgrade() -> None:
    """Drops any reset links outstanding, which is the right way round.

    A link the application no longer understands would otherwise sit there until it
    expired, indistinguishable from an activation link and redeemable as one.
    """
    op.execute("delete from email_verifications where purpose = 'password_reset'")
    op.drop_constraint("ck_email_verifications_purpose", "email_verifications", type_="check")
    op.drop_column("email_verifications", "purpose")
