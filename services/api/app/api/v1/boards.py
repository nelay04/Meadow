"""Boards CRUD and board membership.

Every endpoint below resolves access through `app.services.permissions.resolve_role`,
via the `board_*` dependencies. No router computes a role itself.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import delete, or_, select

from app.auth.deps import CurrentUser, Session, board_editor, board_owner, board_viewer
from app.models import Board, BoardMember, BoardThumbnail, User, WorkspaceMember
from app.schemas.boards import (
    BoardCreate,
    BoardMemberAdd,
    BoardOut,
    BoardPatch,
    MemberOut,
    TitleSuggestion,
)
from app.services.board_kinds import BoardKind
from app.services.naming import DEFAULT_TITLE, generate_unique_board_title
from app.services.permissions import BoardRole, at_least, resolve_role

router = APIRouter(prefix="/boards", tags=["boards"])

# A board preview, not an export. 512px of webp lands well under this; the cap exists
# to keep a misbehaving client from writing megabytes into a row nobody reads closely.
MAX_THUMBNAIL_BYTES = 512 * 1024
ALLOWED_THUMBNAIL_TYPES = frozenset({"image/webp", "image/png"})


def _out(board: Board, role: BoardRole) -> BoardOut:
    return BoardOut(
        id=board.id,
        workspace_id=board.workspace_id,
        title=board.title,
        kind=BoardKind(board.kind),
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


# Before `/{board_id}`, which would otherwise claim this path and reject it as a
# malformed uuid.
@router.get("/suggested-title", response_model=TitleSuggestion)
async def suggested_title(
    user: CurrentUser,
    session: Session,
    workspace_id: Annotated[uuid.UUID, Query()],
) -> TitleSuggestion:
    """The name the create dialog starts with.

    The same generator `create_board` falls back to, offered up front so the person can
    keep it or type over it before anything exists. Uniqueness is checked against the
    workspace as it is now; the create itself is still the authority, and two dialogs
    open at once may agree on a name. That is a duplicate title, not a duplicate board.
    """
    member = await session.get(WorkspaceMember, (workspace_id, user.id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")
    return TitleSuggestion(title=await generate_unique_board_title(session, workspace_id))


@router.post("", response_model=BoardOut, status_code=status.HTTP_201_CREATED)
async def create_board(body: BoardCreate, user: CurrentUser, session: Session) -> BoardOut:
    member = await session.get(WorkspaceMember, (body.workspace_id, user.id))
    if member is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    # A bare "Untitled" means the caller never supplied a name (BoardsPage.tsx's
    # create() sends exactly this literal as its fallback). Give it a random tail so
    # boards stay distinguishable in the list, and so no two in this workspace collide.
    title = body.title
    if title == DEFAULT_TITLE:
        title = await generate_unique_board_title(session, body.workspace_id)

    board = Board(
        workspace_id=body.workspace_id,
        title=title,
        kind=body.kind,
        created_by=user.id,
    )
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


@router.put("/{board_id}/thumbnail", status_code=status.HTTP_204_NO_CONTENT)
async def put_thumbnail(
    board_id: uuid.UUID,
    request: Request,
    session: Session,
    role: Annotated[BoardRole, Depends(board_editor)],
) -> None:
    """Store a preview image for the board list.

    Editor and above: a thumbnail is a rendering of the board's content, so anyone who
    could not have changed that content has nothing new to say about it.

    Raw bytes rather than multipart. There is exactly one file, it comes from
    `canvas.toBlob` on the client, and multipart would be a parser in the request path
    for no gain.
    """
    content_type = request.headers.get("content-type", "")
    if content_type not in ALLOWED_THUMBNAIL_TYPES:
        raise HTTPException(
            status_code=status.HTTP_415_UNSUPPORTED_MEDIA_TYPE,
            detail=f"expected one of {sorted(ALLOWED_THUMBNAIL_TYPES)}",
        )

    image = await request.body()
    if not image:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="empty image")
    if len(image) > MAX_THUMBNAIL_BYTES:
        # A cap, not a resize. The client decides the dimensions; this only refuses
        # something that is clearly not a thumbnail before it reaches the database.
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"thumbnail exceeds {MAX_THUMBNAIL_BYTES} bytes",
        )

    existing = await session.get(BoardThumbnail, board_id)
    if existing is None:
        session.add(
            BoardThumbnail(board_id=board_id, image=image, content_type=content_type)
        )
    else:
        # Rewritten in place. One row per board, never a history.
        existing.image = image
        existing.content_type = content_type

    await session.commit()


@router.delete("/{board_id}/thumbnail", status_code=status.HTTP_204_NO_CONTENT)
async def delete_thumbnail(
    board_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_editor)],
) -> None:
    """Drop the preview image.

    The client calls this when the board has been emptied. Without it, deleting every
    object leaves the last picture standing and the list keeps advertising content the
    board no longer has. Absent row, no error: the end state is the same either way.
    """
    await session.execute(delete(BoardThumbnail).where(BoardThumbnail.board_id == board_id))
    await session.commit()


@router.get("/{board_id}/thumbnail")
async def get_thumbnail(
    board_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_viewer)],
) -> Response:
    """The board's preview image, or 404 if it has never been rendered.

    Behind the same role check as the board itself: a thumbnail is a picture of the
    content, so serving it more freely than the content would leak it.
    """
    thumbnail = await session.get(BoardThumbnail, board_id)
    if thumbnail is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no thumbnail")

    return Response(
        content=thumbnail.image,
        media_type=thumbnail.content_type,
        headers={
            # Private: it is behind auth. must-revalidate so a board that changed does
            # not keep showing a stale picture of itself.
            "Cache-Control": "private, max-age=0, must-revalidate",
            "ETag": f'"{thumbnail.updated_at.timestamp()}"',
        },
    )


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
