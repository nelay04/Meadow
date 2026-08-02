"""Permission resolution. The single authority, per ARCHITECTURE 7.

Every REST router and the websocket handshake resolve access through `resolve_role`
here. That is the whole point of the module: if board access is computed in two
places they drift, and the copy that drifts is the one nobody is testing.

Effective role = max(workspace role mapped to a board role, explicit board_members
role). Owner > editor > commenter > viewer.

`commenter` is inert in v1 - comments are v2 scope, so it resolves with the same
capabilities as `viewer`. The enum value exists now so v2 does not need a migration.
"""

import uuid
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
