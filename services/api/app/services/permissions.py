"""Permission resolution. The single authority, per ARCHITECTURE 7.

Every REST router and the websocket handshake resolve access through `resolve_role`
here. That is the whole point of the module: if board access is computed in two
places they drift, and the copy that drifts is the one nobody is testing.

Effective role = max(workspace role mapped to a board role, explicit board_members
role). Owner > editor > commenter > viewer.

`commenter` is inert in v1 - comments are v2 scope, so it resolves with the same
capabilities as `viewer`. The enum value exists now so v2 does not need a migration.

`resolve_role` answers only "what role does this person hold". Since sharing there are
two more things that decide what a caller may actually do - a public share link, which
lets in somebody with no membership row and possibly no account, and the owner's
board-wide lock, which stops writes at any role. `resolve_access` folds all three into
one answer, and is what the websocket handshake and the ws-token endpoint call. Adding
a third way in means editing that function; it does not mean remembering to edit four
routers.
"""

import uuid
from dataclasses import dataclass
from enum import StrEnum

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession


class BoardRole(StrEnum):
    owner = "owner"
    editor = "editor"
    commenter = "commenter"
    viewer = "viewer"


class WorkspaceRole(StrEnum):
    owner = "owner"
    admin = "admin"
    member = "member"


_RANK: dict[BoardRole, int] = {
    BoardRole.viewer: 0,
    BoardRole.commenter: 1,
    BoardRole.editor: 2,
    BoardRole.owner: 3,
}

# Belonging to a workspace grants a baseline role on every board in it. An explicit
# board_members row can only raise the result, never lower it - a board-level
# downgrade would be silently undone by the workspace grant, so it is not offered.
_WORKSPACE_TO_BOARD: dict[WorkspaceRole, BoardRole] = {
    WorkspaceRole.owner: BoardRole.owner,
    WorkspaceRole.admin: BoardRole.owner,
    WorkspaceRole.member: BoardRole.editor,
}


def rank(role: BoardRole) -> int:
    return _RANK[role]


def at_least(role: BoardRole, minimum: BoardRole) -> bool:
    return _RANK[role] >= _RANK[minimum]


def can_write(role: BoardRole) -> bool:
    """Whether this role may mutate the CRDT document.

    The websocket read-only filter and the client's tool palette both derive from
    this, so a viewer and a commenter are refused in exactly the same way.
    """
    return at_least(role, BoardRole.editor)


def can_manage(role: BoardRole) -> bool:
    """Membership changes, deletion, share links."""
    return role is BoardRole.owner


async def resolve_role(
    session: AsyncSession, *, user_id: uuid.UUID, board_id: uuid.UUID
) -> BoardRole | None:
    """Return the user's effective role on a board, or None for no access.

    None also covers "no such board". Callers must not distinguish the two in a
    response: telling an unauthorised caller that a board id exists is a leak, and it
    is the same 403 either way.
    """
    from app.models import Board, BoardMember, WorkspaceMember

    row = (
        await session.execute(
            select(WorkspaceMember.role, BoardMember.role)
            .select_from(Board)
            .outerjoin(
                WorkspaceMember,
                and_(
                    WorkspaceMember.workspace_id == Board.workspace_id,
                    WorkspaceMember.user_id == user_id,
                ),
            )
            .outerjoin(
                BoardMember,
                and_(BoardMember.board_id == Board.id, BoardMember.user_id == user_id),
            )
            .where(Board.id == board_id)
        )
    ).first()

    if row is None:
        return None

    workspace_role, board_role = row
    candidates = [
        _WORKSPACE_TO_BOARD[workspace_role] if workspace_role is not None else None,
        board_role,
    ]
    granted: list[BoardRole] = [role for role in candidates if role is not None]
    if not granted:
        return None
    return max(granted, key=_RANK.__getitem__)


@dataclass(frozen=True)
class Access:
    """Everything that decides what a caller may do to a board, resolved together.

    `resolve_role` answers "what is this person's role", which was the whole question
    while a board was reachable one way and always writable at that role. Sharing adds a
    second way in and the lock adds a reason a role is not enough, and the moment those
    are two more checks the callers each remember to make, one of them forgets. So they
    are folded in here and `can_write` is a field rather than something a router derives:
    the websocket handshake, the ws-token endpoint and the REST routes all read the same
    answer.
    """

    role: BoardRole
    #: True when the role came from the public link rather than from a membership row.
    #: The ws layer needs it because a link visitor may have no account at all, and the
    #: watchdog must re-resolve them through the link rather than through `board_members`.
    via_link: bool
    #: The owner's board-wide edit lock, as it stands right now.
    locked: bool
    #: Role permits writing *and* the board is not locked. The one boolean the read-only
    #: filter and the client's tool palette both come from.
    can_write: bool


async def resolve_access(
    session: AsyncSession,
    *,
    board_id: uuid.UUID,
    user_id: uuid.UUID | None = None,
    link_token: str | None = None,
) -> Access | None:
    """The effective access a caller has to a board, or None for no access at all.

    Two independent sources, and the higher one wins:

    - a membership role, resolved exactly as `resolve_role` always has;
    - the public share link, when one was presented and the board is currently public.

    Taking the maximum is what stops a share link *lowering* anybody. An owner who
    opens their own board through the link they just copied is still the owner, and a
    viewer link handed to an editor does not demote them for that visit.

    `user_id` may be None: that is an anonymous visitor on a public link, which is the
    whole point of the mode. `link_token` may be None, which is every request that was
    not made through a shared link.

    The lock is read from the board here rather than checked separately, so no caller
    can hold a role and forget to ask.
    """
    from app.models import Board
    from app.services import sharing

    board = await session.get(Board, board_id)
    if board is None:
        return None

    granted: list[BoardRole] = []
    via_link = False

    if user_id is not None:
        membership = await resolve_role(session, user_id=user_id, board_id=board_id)
        if membership is not None:
            granted.append(membership)

    if link_token is not None:
        resolved = await sharing.resolve_link(session, link_token)
        # Scoped to the board being asked about. A token for board A presented on
        # board B grants nothing, exactly as the ws-token's scope check does - and for
        # the same reason: an authentic credential for somewhere else is not a
        # credential for here.
        if resolved is not None and resolved[0].id == board_id:
            granted.append(resolved[1])
            via_link = True

    if not granted:
        return None

    role = max(granted, key=_RANK.__getitem__)
    locked = board.locked_at is not None
    return Access(
        role=role,
        # Only true when the link is the *only* thing that got them in. Somebody with a
        # membership row is not a link visitor even if they arrived through the link.
        via_link=via_link and len(granted) == 1,
        locked=locked,
        # The lock stops the owner too. It is a lock on the document rather than a way
        # of holding other people off it: an owner who wants to write unlocks first,
        # which is one click and is the same gesture everybody else sees the reason for.
        can_write=can_write(role) and not locked,
    )
