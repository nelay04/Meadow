"""m1 initial schema

The first migration. M0 created tables with `Base.metadata.create_all`; from here on
Alembic owns the schema, and the test suite runs these migrations rather than
create_all so a migration that does not reproduce the models fails in CI, not in
production.

Revision ID: 9ecf9798739f
Revises:
Create Date: 2026-08-02
"""

from collections.abc import Sequence

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

from alembic import op

revision: str = '9ecf9798739f'
down_revision: str | None = None
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# create_type=False: the enums are created once, explicitly, below. Left to their
# defaults each referencing table would try to create the type and the second one
# would fail.
board_role = postgresql.ENUM(
    'owner', 'editor', 'commenter', 'viewer', name='board_role', create_type=False
)
workspace_role = postgresql.ENUM(
    'owner', 'admin', 'member', name='workspace_role', create_type=False
)


def upgrade() -> None:
    # citext gives case-insensitive email uniqueness in the database rather than
    # relying on every write path remembering to normalise.
    op.execute('CREATE EXTENSION IF NOT EXISTS citext')
    board_role.create(op.get_bind(), checkfirst=True)
    workspace_role.create(op.get_bind(), checkfirst=True)

    op.create_table('users',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('email', postgresql.CITEXT(), nullable=False),
    sa.Column('password_hash', sa.String(), nullable=False),
    sa.Column('display_name', sa.String(), nullable=False),
    sa.Column('avatar_url', sa.String(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('email')
    )
    op.create_table('refresh_tokens',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('token_hash', sa.String(), nullable=False),
    sa.Column('family_id', sa.UUID(), nullable=False),
    sa.Column('expires_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('revoked_at', sa.DateTime(timezone=True), nullable=True),
    sa.Column('user_agent', sa.String(), nullable=True),
    sa.Column('ip', postgresql.INET(), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('token_hash')
    )
    op.create_index('ix_refresh_tokens_family_id', 'refresh_tokens', ['family_id'], unique=False)
    op.create_index('ix_refresh_tokens_user_id', 'refresh_tokens', ['user_id'], unique=False)
    op.create_table('workspaces',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('name', sa.String(), nullable=False),
    sa.Column('slug', sa.String(), nullable=False),
    sa.Column('owner_id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['owner_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('slug')
    )
    op.create_table('boards',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('workspace_id', sa.UUID(), nullable=False),
    sa.Column('title', sa.String(), nullable=False),
    sa.Column('created_by', sa.UUID(), nullable=True),
    sa.Column('thumbnail_url', sa.String(), nullable=True),
    sa.Column('is_archived', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['created_by'], ['users.id'], ondelete='SET NULL'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_boards_workspace_id_is_archived', 'boards', ['workspace_id', 'is_archived'], unique=False)
    op.create_table('workspace_members',
    sa.Column('workspace_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('role', workspace_role, nullable=False),
    sa.Column('joined_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['workspace_id'], ['workspaces.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('workspace_id', 'user_id')
    )
    op.create_table('board_members',
    sa.Column('board_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('role', board_role, nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['board_id'], ['boards.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('board_id', 'user_id')
    )
    op.create_table('board_snapshots',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('board_id', sa.UUID(), nullable=False),
    sa.Column('state', sa.LargeBinary(), nullable=False),
    sa.Column('up_to_update_id', sa.BigInteger(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['board_id'], ['boards.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_board_snapshots_board_id_created_at', 'board_snapshots', ['board_id', 'created_at'], unique=False)
    op.create_table('board_updates',
    sa.Column('id', sa.BigInteger(), autoincrement=True, nullable=False),
    sa.Column('board_id', sa.UUID(), nullable=False),
    sa.Column('update', sa.LargeBinary(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
    sa.ForeignKeyConstraint(['board_id'], ['boards.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index('ix_board_updates_board_id_id', 'board_updates', ['board_id', 'id'], unique=False)


def downgrade() -> None:
    op.drop_index('ix_board_updates_board_id_id', table_name='board_updates')
    op.drop_table('board_updates')
    op.drop_index('ix_board_snapshots_board_id_created_at', table_name='board_snapshots')
    op.drop_table('board_snapshots')
    op.drop_table('board_members')
    op.drop_table('workspace_members')
    op.drop_index('ix_boards_workspace_id_is_archived', table_name='boards')
    op.drop_table('boards')
    op.drop_table('workspaces')
    op.drop_index('ix_refresh_tokens_user_id', table_name='refresh_tokens')
    op.drop_index('ix_refresh_tokens_family_id', table_name='refresh_tokens')
    op.drop_table('refresh_tokens')
    op.drop_table('users')
    board_role.drop(op.get_bind(), checkfirst=True)
    workspace_role.drop(op.get_bind(), checkfirst=True)
    # The citext extension is left in place: other schemas in the same database may
    # be using it, and dropping it would cascade their columns away.
