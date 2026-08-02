"""SQLAlchemy models.

Relational tables hold metadata and permissions only. Board *content* lives in the
CRDT blob (board_updates / board_snapshots), never mirrored into normalised tables.
See ARCHITECTURE 3.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import CITEXT, INET, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.services.permissions import BoardRole, WorkspaceRole


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)


def _created_at() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


# Native Postgres enums. `create_type=False` because the migration creates them once,
# up front, rather than each table doing it and racing.
board_role_enum = Enum(BoardRole, name="board_role", create_type=False)
workspace_role_enum = Enum(WorkspaceRole, name="workspace_role", create_type=False)


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # citext, so Alice@ and alice@ are one account and cannot both be registered.
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    password_hash: Mapped[str] = mapped_column(String, nullable=False)
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    avatar_url: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class RefreshToken(Base):
    """One row per issued refresh token, including spent ones.

    Spent rows are kept rather than deleted: reuse detection works by recognising a
    token that has already been rotated, which is impossible if the evidence is gone.
    `cleanup_expired_tokens` (ARCHITECTURE 6, hourly) prunes them once they are past
    any useful age.
    """

    __tablename__ = "refresh_tokens"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # sha256 of the raw token. A database leak must not yield usable sessions.
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    # Rotation lineage. Reusing any token in a family revokes the whole family.
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    user_agent: Mapped[str | None] = mapped_column(String, nullable=True)
    ip: Mapped[str | None] = mapped_column(INET, nullable=True)
    created_at: Mapped[datetime] = _created_at()

    __table_args__ = (
        Index("ix_refresh_tokens_user_id", "user_id"),
        Index("ix_refresh_tokens_family_id", "family_id"),
    )


class Workspace(Base):
    __tablename__ = "workspaces"

    id: Mapped[uuid.UUID] = _uuid_pk()
    name: Mapped[str] = mapped_column(String, nullable=False)
    slug: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = _created_at()


class WorkspaceMember(Base):
    __tablename__ = "workspace_members"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("workspaces.id", ondelete="CASCADE"),
        primary_key=True,
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[WorkspaceRole] = mapped_column(workspace_role_enum, nullable=False)
    joined_at: Mapped[datetime] = _created_at()


class Board(Base):
    __tablename__ = "boards"

    id: Mapped[uuid.UUID] = _uuid_pk()
    workspace_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("workspaces.id", ondelete="CASCADE"), nullable=False
    )
    title: Mapped[str] = mapped_column(String, nullable=False, default="Untitled")
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    thumbnail_url: Mapped[str | None] = mapped_column(String, nullable=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (Index("ix_boards_workspace_id_is_archived", "workspace_id", "is_archived"),)


class BoardMember(Base):
    """Per-board override of the workspace role. Never the only source of access.

    Effective role is the higher of this and the mapped workspace role - see
    app/services/permissions.py, which is the only place that computes it.
    """

    __tablename__ = "board_members"

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[BoardRole] = mapped_column(board_role_enum, nullable=False)
    created_at: Mapped[datetime] = _created_at()


class BoardUpdate(Base):
    """Append-only Yjs update log.

    Rows are deleted only by compaction, and only the exact ids it folded. Never
    delete by timestamp or by an id watermark: Postgres sequences are handed out at
    insert time, so a transaction holding a lower id can commit after one holding a
    higher id. See ARCHITECTURE 3.
    """

    __tablename__ = "board_updates"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=False
    )
    update: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    created_at: Mapped[datetime] = _created_at()

    __table_args__ = (Index("ix_board_updates_board_id_id", "board_id", "id"),)


class BoardSnapshot(Base):
    """Compacted document state.

    created_at is NOT NULL with a server default on purpose: both the room-load
    "latest snapshot" query and the compaction prune order by it. A NULL sorts first
    under DESC in Postgres, which would make prune delete the snapshot it just wrote.
    """

    __tablename__ = "board_snapshots"

    id: Mapped[uuid.UUID] = _uuid_pk()
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=False
    )
    state: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Diagnostic only. Never filter room loads by this.
    up_to_update_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = _created_at()

    __table_args__ = (Index("ix_board_snapshots_board_id_created_at", "board_id", "created_at"),)
