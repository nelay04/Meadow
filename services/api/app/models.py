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
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    LargeBinary,
    String,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import CITEXT, INET, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.services.board_kinds import BOARD_KINDS, DEFAULT_BOARD_KIND
from app.services.permissions import BoardRole, WorkspaceRole
from app.services.sharing import DEFAULT_SHARE_MODE, SHARE_MODES


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


# How `users.avatar_url` got its value: "none" for initials, otherwise the name of the
# provider it came from. See `User.avatar_source`.
AVATAR_SOURCES = ("none", "github", "google")


class User(Base):
    """An account, keyed by email.

    Email is the account identity, not just a login field: signing in with GitHub or
    Google resolves to *this* row when the verified email matches, rather than making a
    second account for the same person. See `app/services/accounts.py`, which is the
    only place that decision is taken.
    """

    __tablename__ = "users"

    id: Mapped[uuid.UUID] = _uuid_pk()
    # citext, so Alice@ and alice@ are one account and cannot both be registered.
    email: Mapped[str] = mapped_column(CITEXT, nullable=False, unique=True)
    # Nullable since third-party sign-in: an account created through OAuth has no password
    # to hash, and a placeholder hash would be a credential nobody can revoke. `login`
    # treats null as "no password login for this account" and answers with the same
    # message as a wrong one.
    password_hash: Mapped[str | None] = mapped_column(String, nullable=True)
    # The name the person chose here. Seeded from the provider at first sign-in and
    # theirs to change afterwards; later sign-ins never overwrite it.
    display_name: Mapped[str] = mapped_column(String, nullable=False)
    # The avatar every view reads. Derived, never typed in: `avatar_source` names the
    # provider it came from, so that provider's avatar keeps following its account
    # while "none" means initials and stays that way through the next sign-in.
    avatar_url: Mapped[str | None] = mapped_column(String, nullable=True)
    avatar_source: Mapped[str] = mapped_column(String, nullable=False, server_default="none")
    # When the address answered. Null means the registration is not finished: the
    # account exists, holds the email so nobody else can take it, and cannot be signed
    # in to by any method until the link in the activation mail is followed.
    activated_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        CheckConstraint(
            "avatar_source in ('none', 'github', 'google')", name="ck_users_avatar_source"
        ),
    )


class UserIdentity(Base):
    """A third-party login bound to an account. GitHub and Google in v1.

    Everything below the foreign key is the provider's copy of the user, refreshed on
    every sign-in and never written by the profile editor. That separation is the
    point: `users.display_name` and `users.avatar_url` are what the person chose here,
    and these columns are who the provider says they are. Keeping them apart is what
    makes "put my GitHub name back" possible, and it means no profile edit can corrupt
    the fields an account match is made on.

    One row per provider per account, so an account can hold both and either one signs
    the same person in.

    **No OAuth access token is stored.** It is exchanged, used once server-side to read
    the profile below, and dropped. Persisting a token that can read someone's private
    repositories or mailbox would turn this table into something worth stealing, and
    nothing here needs to call the provider again after sign-in.
    """

    __tablename__ = "user_identities"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # "github" or "google".
    provider: Mapped[str] = mapped_column(String, nullable=False)
    # The provider's own id: GitHub's numeric id as text, Google's `sub`. The match is
    # made on this and never on the name or the email, both of which can change over
    # there; a rename would otherwise read as a different person, and a *reused* login
    # name would read as the same one.
    provider_user_id: Mapped[str] = mapped_column(String, nullable=False)
    # GitHub's `login`. Google has no handle, so the email stands in.
    username: Mapped[str] = mapped_column(String, nullable=False)
    # The provider's display name, which is optional on both and often unset.
    provider_name: Mapped[str | None] = mapped_column(String, nullable=True)
    # The verified email the account was matched on, as the provider reported it.
    provider_email: Mapped[str | None] = mapped_column(String, nullable=True)
    avatar_url: Mapped[str | None] = mapped_column(String, nullable=True)
    profile_url: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
    last_login_at: Mapped[datetime] = _created_at()

    __table_args__ = (
        # One provider account signs in to exactly one Meadow account. Without this a
        # second account could claim an identity already linked elsewhere, and which
        # one a sign-in resolved to would depend on row order.
        UniqueConstraint("provider", "provider_user_id", name="uq_user_identities_provider_user"),
        # And one account holds at most one identity per provider.
        UniqueConstraint("user_id", "provider", name="uq_user_identities_user_provider"),
    )


# What a link in an email is for. One table, because the mechanics are identical -
# hashed, single use, expiring - and the difference is what redeeming it does.
LINK_PURPOSES = ("activation", "password_reset")


class EmailVerification(Base):
    """One issued link. Hashed, single use, and it expires.

    Same three rules as `refresh_tokens`, for the same reasons: the raw token only ever
    exists in the mail, a database leak yields no usable link, and a spent row is kept
    rather than deleted so a second click can be told what happened instead of looking
    like a forgery.
    """

    __tablename__ = "email_verifications"

    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    # "activation" or "password_reset". Checked on redemption, so an activation link
    # cannot be posted to the password endpoint or the other way round.
    purpose: Mapped[str] = mapped_column(String, nullable=False, server_default="activation")
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = _created_at()

    __table_args__ = (
        CheckConstraint(
            "purpose in ('activation', 'password_reset')", name="ck_email_verifications_purpose"
        ),
        Index("ix_email_verifications_user_id", "user_id"),
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
    # What kind of paper the canvas is drawn on. Never what kind of editor it is:
    # every kind is the same infinite canvas over the same CRDT document, and the
    # client resolves this to a surface. See `app.services.board_kinds`.
    kind: Mapped[str] = mapped_column(
        String, nullable=False, default=DEFAULT_BOARD_KIND, server_default=DEFAULT_BOARD_KIND
    )
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    thumbnail_url: Mapped[str | None] = mapped_column(String, nullable=True)
    is_archived: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default="false")
    # Who the board is open to. "restricted" is every board that has ever existed here;
    # "public" makes the live row in `share_links` a capability anyone may use, at
    # `share_role`. The mode is the switch, not the token: a link stays the same value
    # across being turned off and on again, and this column is what decides whether it
    # currently means anything. See `app.services.sharing`.
    share_mode: Mapped[str] = mapped_column(
        String, nullable=False, default=DEFAULT_SHARE_MODE, server_default=DEFAULT_SHARE_MODE
    )
    # What the public link hands out. Constrained to viewer/editor in the database:
    # `owner` carries deletion and membership changes, and nothing that can be
    # forwarded may carry those.
    share_role: Mapped[str] = mapped_column(
        String, nullable=False, default=BoardRole.viewer.value, server_default="viewer"
    )
    # The owner's edit lock, and a different thing from the per-tab lock in
    # `doc/mutations.ts`. That one is a guard against your own hands and is never sent
    # anywhere; this one is on the board, everybody sees it, and only an owner lifts
    # it. Enforced in the websocket handshake beside the role, because a lock the
    # client alone honours is a suggestion.
    locked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    locked_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = _created_at()
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_boards_workspace_id_is_archived", "workspace_id", "is_archived"),
        CheckConstraint(
            "kind in (" + ", ".join(f"'{k}'" for k in BOARD_KINDS) + ")",
            name="ck_boards_kind",
        ),
        CheckConstraint(
            "share_mode in (" + ", ".join(f"'{m}'" for m in SHARE_MODES) + ")",
            name="ck_boards_share_mode",
        ),
        CheckConstraint("share_role in ('viewer', 'editor')", name="ck_boards_share_role"),
    )


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


class ShareLink(Base):
    """The board's link, as a capability.

    One live row per board (partial unique index in 0008), minted the first time the
    board is shared and replaced wholesale by rotation. Revoked rows are kept: a link
    that has stopped working is a different thing to tell somebody about than one that
    was never real.

    **The token is stored raw**, alone among the tokens in this schema, and that is a
    considered trade rather than an oversight. A digest works for `email_verifications`
    because those links are single use and never shown again - recognising one is all
    the server has to do. This one is copied out of the share dialog every time the
    owner reaches for it, so the server has to be able to *produce* it, and no digest
    can do that. What stands in for secrecy at rest is narrowness: it grants at most
    `boards.share_role` on exactly one board, it means nothing at all while
    `boards.share_mode` is `restricted`, and replacing it is one button.
    """

    __tablename__ = "share_links"

    id: Mapped[uuid.UUID] = _uuid_pk()
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=False
    )
    token: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = _created_at()
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        Index(
            "uq_share_links_board_active",
            "board_id",
            unique=True,
            postgresql_where=text("revoked_at is null"),
        ),
    )


class BoardInvitation(Base):
    """A grant waiting for an account to exist at an address.

    Only ever written for an address with *no* account: an invitation to somebody who
    already has one is a `board_members` row and a mail, with nothing to accept. This
    table is the other case, and the thing it is careful about is that **nothing is
    mailed here**. Sending to an arbitrary unverified address that a stranger typed into
    a form is an open relay wearing our from-address; the owner gets a link to pass on
    themselves, through a channel where they already know they are reaching the right
    person.

    `apply_pending` in `app/services/sharing.py` turns these into grants when the
    account opens, which is why accepting is not a step anyone has to remember.
    """

    __tablename__ = "board_invitations"

    id: Mapped[uuid.UUID] = _uuid_pk()
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=False
    )
    # citext, matching `users.email`. The two are compared when an account opens, and a
    # case difference between them would strand the invitation forever.
    email: Mapped[str] = mapped_column(CITEXT, nullable=False)
    role: Mapped[BoardRole] = mapped_column(board_role_enum, nullable=False)
    token: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = _created_at()
    accepted_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    __table_args__ = (
        CheckConstraint("role in ('editor', 'viewer')", name="ck_board_invitations_role"),
        Index(
            "uq_board_invitations_pending",
            "board_id",
            "email",
            unique=True,
            postgresql_where=text("accepted_at is null and revoked_at is null"),
        ),
        Index("ix_board_invitations_email", "email"),
    )


class BoardAccessRequest(Base):
    """Somebody with the address of a restricted board, asking to be let in.

    The other direction of `board_invitations`. An invitation is the owner reaching out
    to an address; this is a person who already has the link reaching back, which is the
    case a restricted board had no answer for at all: the link worked, the board refused
    them, and the only way forward was to leave the app and ask by some other means.

    One row per person per board, rewritten rather than accumulated. Somebody who was
    turned down and asks again is making the same request a second time, not opening a
    second case, and a table that grew a row per attempt would turn a persistent asker
    into a flood in the owner's dialog.

    `role` is what they asked for - view or edit - and it is a request and not a claim:
    the owner decides what to grant, and `decide` may grant something else entirely.
    Nothing here is access. The only thing that grants access is a `board_members` row.
    """

    __tablename__ = "board_access_requests"

    id: Mapped[uuid.UUID] = _uuid_pk()
    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    #: What was asked for. Constrained to viewer/editor in the database for the same
    #: reason `boards.share_role` is: nothing anyone can ask for may carry deletion.
    role: Mapped[BoardRole] = mapped_column(board_role_enum, nullable=False)
    #: pending -> granted or declined, and never back. A fresh ask rewrites the row to
    #: pending, which is what makes asking twice one request rather than two.
    status: Mapped[str] = mapped_column(String, nullable=False, server_default="pending")
    created_at: Mapped[datetime] = _created_at()
    decided_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    decided_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    __table_args__ = (
        UniqueConstraint("board_id", "user_id", name="uq_board_access_requests_board_user"),
        CheckConstraint(
            "status in ('pending', 'granted', 'declined')",
            name="ck_board_access_requests_status",
        ),
        CheckConstraint(
            "role in ('viewer', 'editor')", name="ck_board_access_requests_role"
        ),
    )


class BoardThumbnail(Base):
    """A small preview image of the board, for the board list.

    In Postgres rather than MinIO, and that is a deliberate departure from
    ARCHITECTURE 1's "object storage: images, attachments, exports". A thumbnail is a
    few kilobytes, there is exactly one per board, and it is rewritten in place rather
    than accumulating versions. Standing up MinIO to hold one small row per board would
    be a second storage system to back up, secure, and keep consistent with the row
    that points at it, for no benefit at this size.

    `Board.thumbnail_url` stays unused and reserved: user-uploaded images and exports in
    v2 genuinely do need object storage, and that is when it earns its place.
    """

    __tablename__ = "board_thumbnails"

    board_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("boards.id", ondelete="CASCADE"), primary_key=True
    )
    image: Mapped[bytes] = mapped_column(LargeBinary, nullable=False)
    content_type: Mapped[str] = mapped_column(String, nullable=False, default="image/webp")
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
