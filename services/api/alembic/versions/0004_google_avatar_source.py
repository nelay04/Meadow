"""google sign-in: widen the avatar source check constraint

`users.avatar_source` names where the avatar came from, and it is now a provider name
rather than the single value "github". The identities table needed no change at all -
it was written with a `provider` column and a unique constraint per provider from the
start - so this is the whole of the schema work for a second provider.

Rewriting the constraint rather than dropping it: the column is what
`app/services/accounts.py` compares a profile's provider against when deciding whether
to keep an avatar current, and an unconstrained string there would let a typo become a
picture that silently never updates.

Revision ID: 0004_google_avatar_source
Revises: 0003_github_identities
Create Date: 2026-08-17
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004_google_avatar_source"
down_revision: str | None = "0003_github_identities"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.drop_constraint("ck_users_avatar_source", "users", type_="check")
    op.create_check_constraint(
        "ck_users_avatar_source", "users", "avatar_source in ('none', 'github', 'google')"
    )


def downgrade() -> None:
    """Sends anyone showing a Google picture back to initials.

    The narrower constraint cannot hold those rows, and the alternatives are worse:
    failing the migration leaves the database un-downgradable because of a display
    preference, and leaving the column pointing at a provider the code no longer knows
    would strand the avatar with nothing to refresh it. Initials are the setting's own
    fallback, so this reverses to a state the application already understands.
    """
    op.execute(
        "update users set avatar_source = 'none', avatar_url = null "
        "where avatar_source = 'google'"
    )
    op.drop_constraint("ck_users_avatar_source", "users", type_="check")
    op.create_check_constraint(
        "ck_users_avatar_source", "users", "avatar_source in ('none', 'github')"
    )
