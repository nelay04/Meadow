"""board thumbnails

Small preview images for the board list, stored in Postgres rather than object
storage. See the docstring on `app.models.BoardThumbnail` for why, and for why
`boards.thumbnail_url` stays reserved for the v2 MinIO path.

Revision ID: 0002_board_thumbnails
Revises: 9ecf9798739f
Create Date: 2026-08-05
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002_board_thumbnails"
down_revision: str | None = "9ecf9798739f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "board_thumbnails",
        sa.Column("board_id", sa.UUID(), nullable=False),
        sa.Column("image", sa.LargeBinary(), nullable=False),
        sa.Column("content_type", sa.String(), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        # CASCADE: a thumbnail has no meaning without its board, and orphans would keep
        # the image bytes alive forever.
        sa.ForeignKeyConstraint(["board_id"], ["boards.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("board_id"),
    )


def downgrade() -> None:
    op.drop_table("board_thumbnails")
