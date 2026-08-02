import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, LargeBinary, String, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class Board(Base):
    """M0 subset. workspace_id / created_by / thumbnail / archive land in M1."""

    __tablename__ = "boards"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    title: Mapped[str] = mapped_column(String, nullable=False, default="Untitled")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


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
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("ix_board_updates_board_id_id", "board_id", "id"),)


class BoardSnapshot(Base):
    """Compacted document state.

    created_at is NOT NULL with a server default on purpose: both the room-load
    "latest snapshot" query and the compaction prune order by it. A NULL sorts first
    under DESC in Postgres, which would make prune delete the snapshot it just wrote.
    """

    __tablename__ = "board_snapshots"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=False
    )
    state: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    # Diagnostic only. Never filter room loads by this.
    up_to_update_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    __table_args__ = (Index("ix_board_snapshots_board_id_created_at", "board_id", "created_at"),)
