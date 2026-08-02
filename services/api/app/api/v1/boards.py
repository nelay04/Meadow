"""Boards CRUD and board membership.

Every endpoint below resolves access through `app.services.permissions.resolve_role`,
via the `board_*` dependencies. No router computes a role itself.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import delete, or_, select

from app.auth.deps import CurrentUser, Session, board_owner, board_viewer
from app.models import Board, BoardMember, User, WorkspaceMember
from app.schemas.boards import BoardCreate, BoardMemberAdd, BoardOut, BoardPatch, MemberOut
from app.services.permissions import BoardRole, at_least, resolve_role

router = APIRouter(prefix="/boards", tags=["boards"])


def _out(board: Board, role: BoardRole) -> BoardOut:
    return BoardOut(
        id=board.id,
        workspace_id=board.workspace_id,
        title=board.title,
        is_archived=board.is_archived,
        created_at=board.created_at,
        updated_at=board.updated_at,
        role=role,
    )


@router.get("", response_model=list[BoardOut])
async def list_boards(
    user: CurrentUser,
    session: Session,
    workspace_id: Annotated[uuid.UUID | None, Query()] = None,
    archived: Annotated[bool, Query()] = False,
) -> list[BoardOut]:
    """Boards reachable through workspace membership or an explicit board grant.

    The union matters: a board shared directly with someone outside the workspace is
    invisible if you only join on workspace membership.
    """
    query = (
        select(Board)
        .outerjoin(
            WorkspaceMember,
            (WorkspaceMember.workspace_id == Board.workspace_id)
            & (WorkspaceMember.user_id == user.id),
        )
        .outerjoin(
            BoardMember, (BoardMember.board_id == Board.id) & (BoardMember.user_id == user.id)
        )
        .where(
            or_(WorkspaceMember.user_id.is_not(None), BoardMember.user_id.is_not(None)),
            Board.is_archived == archived,
        )
        .order_by(Board.updated_at.desc())
    )
    if workspace_id is not None:
        query = query.where(Board.workspace_id == workspace_id)

    boards = list((await session.execute(query)).scalars())
    out = []
    for board in boards:
        role = await resolve_role(session, user_id=user.id, board_id=board.id)
        if role is not None:
            out.append(_out(board, role))
    return out


@router.post("", response_model=BoardOut, status_code=status.HTTP_201_CREATED)
async def create_board(body: BoardCreate, user: CurrentUser, session: Session) -> BoardOut:
    member = await session.get(WorkspaceMember, (body.workspace_id, user.id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    board = Board(workspace_id=body.workspace_id, title=body.title, created_by=user.id)
    session.add(board)
    await session.flush()

    # Explicit owner grant for the creator. Workspace membership alone would make a
    # plain `member` an editor on a board they created, unable to delete it.
    session.add(BoardMember(board_id=board.id, user_id=user.id, role=BoardRole.owner))
    await session.commit()
    await session.refresh(board)
    return _out(board, BoardRole.owner)


@router.get("/{board_id}", response_model=BoardOut)
async def get_board(
    board_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_viewer)],
) -> BoardOut:
    """Metadata only, never content. Content arrives over the websocket."""
    board = await session.get(Board, board_id)
    if board is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")
    return _out(board, role)


@router.patch("/{board_id}", response_model=BoardOut)
async def patch_board(
    board_id: uuid.UUID,
    body: BoardPatch,
    session: Session,
    role: Annotated[BoardRole, Depends(board_viewer)],
) -> BoardOut:
    board = await session.get(Board, board_id)
    if board is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    if body.title is not None:
        if not at_least(role, BoardRole.editor):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")
        board.title = body.title

    if body.is_archived is not None:
        # Archiving hides a board for everyone in the workspace, so it is an owner
        # action even though renaming is not.
        if role is not BoardRole.owner:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")
        board.is_archived = body.is_archived

    await session.commit()
    await session.refresh(board)
    return _out(board, role)


@router.delete("/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_board(
    board_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> None:
    """Hard delete. board_updates and board_snapshots cascade away with it.

    Any live websocket on this board keeps its socket until the watchdog next
    revalidates, at which point role resolution returns None and it is closed.
    """
    await session.execute(delete(Board).where(Board.id == board_id))
    await session.commit()


@router.get("/{board_id}/members", response_model=list[MemberOut])
async def list_board_members(
    board_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_viewer)],
) -> list[MemberOut]:
    rows = (
        await session.execute(
            select(User, BoardMember.role)
            .join(BoardMember, BoardMember.user_id == User.id)
            .where(BoardMember.board_id == board_id)
            .order_by(BoardMember.created_at)
        )
    ).all()
    return [
        MemberOut(user_id=u.id, email=u.email, display_name=u.display_name, role=member_role)
        for u, member_role in rows
    ]


@router.post(
    "/{board_id}/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED
)
async def add_board_member(
    board_id: uuid.UUID,
    body: BoardMemberAdd,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> MemberOut:
    target = await session.get(User, body.user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")

    existing = await session.get(BoardMember, (board_id, body.user_id))
    if existing is not None:
        existing.role = body.role
    else:
        session.add(BoardMember(board_id=board_id, user_id=body.user_id, role=body.role))
    await session.commit()

    # The effective role can exceed what was just granted: a workspace admin added as
    # a board viewer is still an owner through the workspace. Return the truth, so a
    # caller is not misled into thinking the downgrade took effect.
    effective = await resolve_role(session, user_id=body.user_id, board_id=board_id)
    return MemberOut(
        user_id=target.id,
        email=target.email,
        display_name=target.display_name,
        role=str(effective or body.role),
    )


@router.delete("/{board_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_board_member(
    board_id: uuid.UUID,
    user_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> None:
    await session.execute(
        delete(BoardMember).where(
            BoardMember.board_id == board_id, BoardMember.user_id == user_id
        )
    )
    await session.commit()
