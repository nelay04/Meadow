"""Pydantic request/response models for workspaces, boards, and ws-tokens."""

import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.services.board_kinds import DEFAULT_BOARD_KIND, BoardKind
from app.services.permissions import BoardRole, WorkspaceRole
from app.services.sharing import ShareMode


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    role: WorkspaceRole


class WorkspaceMemberAdd(BaseModel):
    user_id: uuid.UUID
    role: WorkspaceRole = WorkspaceRole.member


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str
    # The face the share dialog draws beside the name. Nullable, and the client falls
    # back to initials, exactly as presence does.
    avatar_url: str | None = None


class TitleSuggestion(BaseModel):
    """A default name offered to the create dialog before the board exists."""

    title: str


class BoardCreate(BaseModel):
    workspace_id: uuid.UUID
    title: str = Field(default="Untitled", max_length=200)
    # Chosen once, at creation. A kind decides what the surface looks like and nothing
    # about the document, so converting one to another later is a client-side setting
    # rather than a migration; it is still not offered, because a glade drawn against
    # a diary's ruling does not read the same on graph paper.
    kind: BoardKind = DEFAULT_BOARD_KIND


class BoardPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    is_archived: bool | None = None
    # The owner's board-wide edit lock. Owner only, and it stops the owner too: it
    # locks the document rather than holding other people off it.
    is_locked: bool | None = None


class BoardOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    kind: BoardKind
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    # The caller's effective role. The board list uses it to decide what to enable,
    # so it never has to guess from workspace membership.
    role: BoardRole
    # Who the board is open to, and what the link hands out. On every board response
    # rather than only the share dialog's, because the list wants to badge a shared
    # board and the board view wants to say so in its header.
    share_mode: ShareMode
    share_role: BoardRole
    # The owner's lock, and whether this caller may write *given* it. `can_write` is
    # the answer the client acts on; the two fields either side of it are what it says
    # about why. Sent even to a viewer, for whom it is False for the other reason.
    is_locked: bool
    locked_by: uuid.UUID | None = None
    can_write: bool


class BoardMemberAdd(BaseModel):
    user_id: uuid.UUID
    role: BoardRole


class WsTokenRequest(BaseModel):
    board_id: uuid.UUID
    # The share link the browser arrived with, if it did. Presented on every mint
    # rather than only when membership fails, because it can *raise* the answer: an
    # editor link opens an editor connection for somebody whose membership is viewer.
    link_token: str | None = None


class WsTokenOut(BaseModel):
    token: str
    expires_in: int
    # The resolved role, so the client can disable its tools before the user reaches
    # for one. ARCHITECTURE 6: "the handshake must return the resolved role".
    role: BoardRole
    # Role and lock together, which is what the client's read-only check actually
    # needs. Returned rather than derived on the client so there is one answer, decided
    # in one place, and a lock taken while the page was open lands with the reconnect.
    can_write: bool
    is_locked: bool


# --- sharing ---


class ShareSettings(BaseModel):
    """What the owner sets in the share dialog's top half.

    Two fields, because they are two questions: who may open it, and what they get.
    Folding them into one four-valued setting would make "switch it off for a minute"
    lose the role that was chosen, and switching back on would silently pick a default.
    """

    mode: ShareMode
    # Only viewer or editor. Validated in the router against `SHAREABLE_ROLES` rather
    # than by the type, so the refusal names the reason instead of reading as a
    # malformed request.
    role: BoardRole = BoardRole.viewer


class InvitationOut(BaseModel):
    """An invitation waiting for an account to exist at an address.

    `link` is included on every read, not just on the one that created it. The owner is
    the only copy - nothing was mailed - so a dialog that showed it once and then only
    listed the address would be a promise they could no longer keep.
    """

    id: uuid.UUID
    email: str
    role: BoardRole
    link: str
    created_at: datetime


class AccessRequestOut(BaseModel):
    """One person waiting for an owner to decide."""

    id: uuid.UUID
    user_id: uuid.UUID
    email: str
    display_name: str
    avatar_url: str | None = None
    #: What they asked for: viewer or editor. A request, not a claim - the owner may
    #: grant something else.
    role: BoardRole
    created_at: datetime


class AccessRequestCreate(BaseModel):
    #: Viewer or editor. The same pair a link may grant, refused elsewhere.
    role: BoardRole = BoardRole.viewer


class AccessRequestDecision(BaseModel):
    #: True to let them in, False to turn them down.
    approve: bool
    #: What to grant, when approving. Defaults to what was asked for - an owner who
    #: wants to grant something else says so, rather than the app quietly rounding a
    #: request for edit down to view.
    role: BoardRole | None = None


class MyAccessRequestOut(BaseModel):
    """What the person who asked is told, and it is deliberately very little.

    No title, no owner, no membership list. The caller has proved nothing except that
    they are signed in and know a board id, and until somebody decides otherwise they
    are entitled to know only the state of their own request.
    """

    #: "none", "pending", "granted", or "declined".
    status: str
    #: What they last asked for, when there is a request at all.
    role: BoardRole | None = None
    #: Whether they can open the board right now. The one field that is about access
    #: rather than about the request, and what the waiting screen watches: an owner may
    #: also have let them in by some entirely different route.
    has_access: bool = False


class ShareState(BaseModel):
    """Everything the share dialog draws, in one response."""

    mode: ShareMode
    role: BoardRole
    #: The board's plain address. What "copy link" gives while sharing is restricted.
    url: str
    #: The address with the capability on it, or None while the board has never been
    #: shared publicly. Present whenever a link exists, including while the mode is
    #: back to restricted: the dialog says the link is dormant rather than hiding it,
    #: because an owner who switches back on wants to know it is the same link.
    link_url: str | None
    is_locked: bool
    members: list[MemberOut]
    invitations: list[InvitationOut]
    #: People who have asked to be let in and are still waiting. Part of the same
    #: response as the members list because they are the same question - who is on this
    #: board - asked a moment earlier.
    requests: list[AccessRequestOut]


class InviteCreate(BaseModel):
    email: EmailStr
    role: BoardRole = BoardRole.editor


class InviteResultOut(BaseModel):
    """What happened to one typed-in address. See `sharing.InviteResult`."""

    #: "granted", "pending", or "member". Three outcomes, not three shades of success.
    status: str
    email: str
    role: BoardRole
    user_id: uuid.UUID | None = None
    display_name: str | None = None
    #: Set only for "pending": the link the owner passes on themselves.
    link: str | None = None
    #: False when the grant landed but the notice could not be sent, so the dialog can
    #: say that rather than claiming a mail that never left.
    mailed: bool = True


class PublicBoardOut(BaseModel):
    """A board as it looks to somebody holding a share link and nothing else.

    Deliberately not `BoardOut`. A link visitor has no business knowing which workspace
    the board belongs to, when it was created, or whether it is archived; this is the
    minimum the board view needs to draw itself, and every field on it is something the
    person is about to see on the canvas anyway.
    """

    id: uuid.UUID
    title: str
    kind: BoardKind
    role: BoardRole
    is_locked: bool
    can_write: bool


class JoinInvitationOut(BaseModel):
    """What a `#/join/...` link shows before anybody has an account.

    Unauthenticated, so it says as little as it can while still being worth reading:
    the address it was meant for, so the person registers with the right one, and the
    board's title and kind, so they can tell whether this is the thing they were told
    about. No board id: the invitation is not access, and the id is not usable until it
    becomes access.
    """

    email: str
    title: str
    kind: BoardKind
    role: BoardRole
    #: "pending", "accepted", or "revoked". A spent link says so rather than looking
    #: broken - the usual reason somebody follows one twice is that it worked.
    status: str
    #: The display name of whoever sent it, when the account still exists.
    invited_by: str | None = None
