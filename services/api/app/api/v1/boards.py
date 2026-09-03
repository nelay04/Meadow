"""Boards CRUD and board membership.

Every endpoint below resolves access through `app.services.permissions.resolve_role`,
via the `board_*` dependencies. No router computes a role itself.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from sqlalchemy import delete, or_, select

from app.auth.deps import CurrentUser, Session, board_editor, board_owner, board_viewer
from app.config import settings
from app.models import (
    Board,
    BoardAccessRequest,
    BoardInvitation,
    BoardMember,
    BoardThumbnail,
    User,
    WorkspaceMember,
)
from app.realtime.rooms import WS_CLOSE_FORBIDDEN, SocketRegistry
from app.schemas.boards import (
    AccessRequestCreate,
    AccessRequestDecision,
    AccessRequestOut,
    BoardCreate,
    BoardMemberAdd,
    BoardOut,
    BoardPatch,
    InvitationOut,
    InviteCreate,
    InviteResultOut,
    MemberOut,
    MyAccessRequestOut,
    ShareSettings,
    ShareState,
    TitleSuggestion,
)
from app.services import access_requests, sharing
from app.services.board_kinds import BoardKind
from app.services.naming import DEFAULT_TITLE, generate_unique_board_title
from app.services.permissions import BoardRole, at_least, can_write, rank, resolve_role
from app.services.ratelimit import check as rate_limit_check
from app.services.sharing import SHAREABLE_ROLES, ShareMode

router = APIRouter(prefix="/boards", tags=["boards"])

# A board preview, not an export. 512px of webp lands well under this; the cap exists
# to keep a misbehaving client from writing megabytes into a row nobody reads closely.
MAX_THUMBNAIL_BYTES = 512 * 1024
ALLOWED_THUMBNAIL_TYPES = frozenset({"image/webp", "image/png"})


def _out(board: Board, role: BoardRole) -> BoardOut:
    # `can_write` is computed here rather than left to the client so the lock and the
    # role are answered together, in the same place and the same way the websocket
    # handshake answers them. A client deriving it from the two fields beside it would
    # be the second implementation of a rule, which is what ARCHITECTURE 7 says not to
    # have; these two exist alongside it only so the UI can say *why*.
    locked = board.locked_at is not None
    return BoardOut(
        id=board.id,
        workspace_id=board.workspace_id,
        title=board.title,
        kind=BoardKind(board.kind),
        is_archived=board.is_archived,
        created_at=board.created_at,
        updated_at=board.updated_at,
        role=role,
        share_mode=ShareMode(board.share_mode),
        share_role=BoardRole(board.share_role),
        is_locked=locked,
        locked_by=board.locked_by,
        can_write=can_write(role) and not locked,
    )


async def _evict(request: Request, board_id: uuid.UUID, reason: str) -> None:
    """Close every socket on this board so the handshake decides again.

    Called after anything that changes what a live connection is allowed to do: the
    lock, the share mode, the link. The read-only filter is chosen once at join time
    (ARCHITECTURE 6), so there is no way to change a connection's mind except to end it
    - and the watchdog that would eventually notice runs on a fifteen-minute clock,
    which is the wrong timescale entirely for a button somebody just pressed and is
    watching.

    Best effort by design. The registry is in-process, so this reaches the sockets this
    instance is serving and no others; everything else closes on the watchdog. It is
    also absent in tests that mount the router without the lifespan, which is why the
    attribute is fetched defensively rather than assumed.
    """
    sockets: SocketRegistry | None = getattr(request.app.state, "sockets", None)
    if sockets is None:
        return
    await sockets.evict(str(board_id), code=WS_CLOSE_FORBIDDEN, reason=reason)


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
    request: Request,
    user: CurrentUser,
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

    lock_changed = (
        body.is_locked is not None and body.is_locked != (board.locked_at is not None)
    )
    if lock_changed:
        # Owner only. An editor already has a lock - the per-tab one in
        # `doc/mutations.ts` - and it does what an editor is entitled to do, which is
        # stop *their* hands. Freezing everybody else's is a different power and it
        # belongs to whoever the board belongs to.
        if role is not BoardRole.owner:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")
        board.locked_at = datetime.now(UTC) if body.is_locked else None
        board.locked_by = user.id if body.is_locked else None

    await session.commit()
    await session.refresh(board)

    if lock_changed:
        # Unlocking evicts too, and that is not symmetry for its own sake: everybody
        # currently on the board is holding a read-only channel chosen when they
        # joined, and nothing but a reconnect gives it back.
        await _evict(request, board_id, "lock changed")

    return _out(board, role)


@router.delete("/{board_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_board(
    board_id: uuid.UUID,
    request: Request,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> None:
    """Hard delete. board_updates and board_snapshots cascade away with it.

    The sockets go with it. Leaving them to the watchdog meant up to fifteen minutes of
    people typing into a board that no longer exists - accepted, relayed between them,
    and written to a store whose rows had been cascaded away - and then finding the work
    gone with no account of where. Closing now makes their next reconnect resolve to no
    access, which is the truth and says so.
    """
    await session.execute(delete(Board).where(Board.id == board_id))
    await session.commit()
    await _evict(request, board_id, "glade deleted")


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
        MemberOut(
            user_id=u.id,
            email=u.email,
            display_name=u.display_name,
            role=member_role,
            avatar_url=u.avatar_url,
        )
        for u, member_role in rows
    ]


@router.post(
    "/{board_id}/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED
)
async def add_board_member(
    board_id: uuid.UUID,
    body: BoardMemberAdd,
    request: Request,
    user: CurrentUser,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> MemberOut:
    """Grant or change one person's role. This is also the demote path.

    Unlike `invite`, which only ever raises somebody, this sets the role to exactly
    what was asked for. That is the difference between the two controls in the share
    dialog: typing an address is an offer, and changing the dropdown beside a name
    already in the list is an instruction.
    """
    target = await session.get(User, body.user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")

    board = await session.get(Board, board_id)
    if board is None:  # pragma: no cover - board_owner already resolved it
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    # Read before the write, because it is the only thing that can tell a change from a
    # restatement - and a mail announcing that nothing happened is how people learn to
    # ignore the ones that do.
    before = await resolve_role(session, user_id=body.user_id, board_id=board_id)

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

    if effective is not None and effective != before:
        if before is not None:
            # A change to somebody who already had access, which is the case worth
            # writing about: they have a mental model of what they can do here and it
            # is now wrong. Somebody who had nothing gets the invitation mail from the
            # invite endpoint instead, which says more useful things.
            await sharing.notify_role_change(
                board=board, member=target, role=effective, actor=user
            )
        # Whatever they were allowed to do a moment ago, they are allowed to do
        # something else now, and the socket they are holding was configured for the
        # old answer.
        await _evict(request, board_id, "role changed")

    return MemberOut(
        user_id=target.id,
        email=target.email,
        display_name=target.display_name,
        role=str(effective or body.role),
        avatar_url=target.avatar_url,
    )


@router.delete("/{board_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_board_member(
    board_id: uuid.UUID,
    user_id: uuid.UUID,
    request: Request,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> None:
    await session.execute(
        delete(BoardMember).where(
            BoardMember.board_id == board_id, BoardMember.user_id == user_id
        )
    )
    await session.commit()
    # Someone whose grant is gone may still hold an open socket on the board, writing
    # into it. The mint would refuse them now; the connection they already have would
    # not notice until the watchdog next looked.
    await _evict(request, board_id, "access changed")


# --- sharing ---------------------------------------------------------------------
#
# Owner-only, all of it. `can_manage` in `app/services/permissions.py` has always
# listed share links beside membership and deletion, and the reason is that every
# control below decides who else can be here: an editor who could hand out an editor
# link would be able to grant more than they were granted.


async def _share_state(session: Session, board: Board, request: Request) -> ShareState:
    """Everything the share dialog draws, assembled once.

    One response rather than three, because the dialog is one screen and three requests
    would give it three chances to render half of itself. It is also the read that
    follows every write below, so what the dialog shows after an action is what the
    server actually holds rather than what the client guessed it would hold.
    """
    member_rows = (
        await session.execute(
            select(User, BoardMember.role)
            .join(BoardMember, BoardMember.user_id == User.id)
            .where(BoardMember.board_id == board.id)
            .order_by(BoardMember.created_at)
        )
    ).all()

    invitations = list(
        (
            await session.execute(
                select(BoardInvitation)
                .where(
                    BoardInvitation.board_id == board.id,
                    BoardInvitation.accepted_at.is_(None),
                    BoardInvitation.revoked_at.is_(None),
                )
                .order_by(BoardInvitation.created_at)
            )
        ).scalars()
    )

    waiting = await access_requests.waiting(session, board.id)

    link = await sharing.active_link(session, board.id)

    return ShareState(
        mode=ShareMode(board.share_mode),
        role=BoardRole(board.share_role),
        url=sharing.board_url(board.id, board.kind),
        # Shown even while the mode is restricted, and shown as dormant rather than
        # hidden. An owner switching sharing off and on again is not issuing a new
        # link, and a dialog that made the field disappear would imply they were.
        link_url=(
            None if link is None else sharing.board_url(board.id, board.kind, link_token=link.token)
        ),
        is_locked=board.locked_at is not None,
        members=[
            MemberOut(
                user_id=u.id,
                email=u.email,
                display_name=u.display_name,
                role=str(member_role),
                avatar_url=u.avatar_url,
            )
            for u, member_role in member_rows
        ],
        invitations=[
            InvitationOut(
                id=invitation.id,
                email=invitation.email,
                role=invitation.role,
                link=sharing.invite_url(invitation.token),
                created_at=invitation.created_at,
            )
            for invitation in invitations
        ],
        requests=[
            AccessRequestOut(
                id=request.id,
                user_id=asker.id,
                email=asker.email,
                display_name=asker.display_name,
                avatar_url=asker.avatar_url,
                role=request.role,
                created_at=request.created_at,
            )
            for request, asker in waiting
        ],
    )


@router.get("/{board_id}/share", response_model=ShareState)
async def get_share(
    board_id: uuid.UUID,
    request: Request,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> ShareState:
    board = await session.get(Board, board_id)
    if board is None:  # pragma: no cover - board_owner already resolved it
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")
    return await _share_state(session, board, request)


@router.put("/{board_id}/share", response_model=ShareState)
async def put_share(
    board_id: uuid.UUID,
    body: ShareSettings,
    request: Request,
    user: CurrentUser,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> ShareState:
    """Set who may open the board, and what they get.

    Switching to public mints the link if the board has never had one, and reuses it if
    it has. Reuse is the point: "share, change my mind, share again" must not quietly
    hand out a second address while the first is still in somebody's chat history, and
    it must not break the one they already have either. Replacing a link is a separate,
    louder action - see `rotate_share`.
    """
    if body.role not in SHAREABLE_ROLES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"a link may grant {' or '.join(sorted(str(r) for r in SHAREABLE_ROLES))}",
        )

    board = await session.get(Board, board_id)
    if board is None:  # pragma: no cover - board_owner already resolved it
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    changed = board.share_mode != body.mode or board.share_role != str(body.role)
    board.share_mode = body.mode
    board.share_role = str(body.role)

    if body.mode is ShareMode.public:
        await sharing.ensure_link(session, board_id, user.id)

    await session.commit()
    await session.refresh(board)

    if changed:
        # Closing a board to the public has to actually remove the people who are on
        # it, and lowering an editor link to a viewer one has to actually stop them
        # typing. Both are decided at the handshake, so both mean ending the sockets.
        await _evict(request, board_id, "sharing changed")

    return await _share_state(session, board, request)


@router.post("/{board_id}/share/rotate", response_model=ShareState)
async def rotate_share(
    board_id: uuid.UUID,
    request: Request,
    user: CurrentUser,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> ShareState:
    """Replace the link, invalidating the old one.

    The undo for a link that went somewhere it was not meant to go. Deliberately its own
    button rather than something the mode switch does implicitly: an owner toggling
    sharing off for a minute is not asking to break every copy of the address they have
    already sent out, and an owner who *is* asking for that should have to say so.
    """
    board = await session.get(Board, board_id)
    if board is None:  # pragma: no cover - board_owner already resolved it
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    await sharing.rotate_link(session, board_id, user.id)
    await session.commit()
    await session.refresh(board)
    # Everybody who came in on the old link is still here on it. The whole point of
    # rotating was to stop that.
    await _evict(request, board_id, "share link rotated")
    return await _share_state(session, board, request)


@router.post(
    "/{board_id}/invites",
    response_model=InviteResultOut,
    status_code=status.HTTP_201_CREATED,
)
async def create_invite(
    board_id: uuid.UUID,
    body: InviteCreate,
    request: Request,
    user: CurrentUser,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> InviteResultOut:
    """Invite one address, by whichever of the two routes applies to it.

    The branch - account, or no account - is in `app.services.sharing.invite`, along
    with why the second route sends no mail. What matters here is that both come back
    through one response shape, so the dialog has one thing to render and the difference
    is a word in it rather than a second code path in the client.
    """
    if body.role not in SHAREABLE_ROLES:
        grantable = " or ".join(sorted(str(r) for r in SHAREABLE_ROLES))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"an invitation may grant {grantable}",
        )

    board = await session.get(Board, board_id)
    if board is None:  # pragma: no cover - board_owner already resolved it
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    result = await sharing.invite(
        session, board=board, email=str(body.email), role=body.role, inviter=user
    )
    await session.commit()

    if result.status == "granted":
        # They may have been on the board already as a viewer, holding a read-only
        # channel that an editor grant does not upgrade.
        await _evict(request, board_id, "access changed")

    return InviteResultOut(
        status=result.status,
        email=result.email,
        role=result.role,
        user_id=result.user_id,
        display_name=result.display_name,
        link=result.link,
        mailed=result.mailed,
    )


@router.delete(
    "/{board_id}/invites/{invitation_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def revoke_invite(
    board_id: uuid.UUID,
    invitation_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> None:
    """Withdraw an invitation that has not been accepted yet.

    Revoked rather than deleted, so the link says "this invitation was withdrawn"
    instead of "no such invitation". Somebody who was sent an address and finds nothing
    there assumes they mistyped it and tries again; somebody told it was withdrawn asks
    the person who sent it, which is the conversation that should happen.

    Scoped by board id as well as by invitation id. Without it an owner of any board
    could revoke an invitation belonging to any other, since the id alone is enough to
    find the row.
    """
    invitation = await session.get(BoardInvitation, invitation_id)
    if invitation is None or invitation.board_id != board_id:
        return
    if invitation.accepted_at is None and invitation.revoked_at is None:
        invitation.revoked_at = datetime.now(UTC)
        await session.commit()


# --- access requests -------------------------------------------------------------
#
# The other direction of sharing. Everything above is an owner deciding who else may be
# here; this is somebody who already has the address asking to be one of them, which is
# the case a restricted board previously answered with a flat refusal and no next step.
#
# Nothing here grants anything. A request is a record that a named, signed-in account
# asked for viewer or editor, and the only thing that ever grants access is the
# `board_members` row `decide_access_request` writes - resolved afterwards through
# `resolve_role` like every other grant.


async def _my_request_state(
    session: Session, *, board_id: uuid.UUID, user_id: uuid.UUID
) -> MyAccessRequestOut:
    """What the person who asked is allowed to know: the state of their own request.

    Deliberately answerable for a board that does not exist, and answerable the same
    way. This is the one endpoint in the API a caller can point at a board id they have
    no relationship with at all, and an answer that differed between "no such board"
    and "no request on this board" would turn it into a way to test whether an id is
    real. So a stranger gets "none" either way, and the request they then send is
    recorded only if there is something to record it against.
    """
    role = await resolve_role(session, user_id=user_id, board_id=board_id)
    existing = await access_requests.mine(session, board_id=board_id, user_id=user_id)

    return MyAccessRequestOut(
        status="none" if existing is None else existing.status,
        role=None if existing is None else existing.role,
        has_access=role is not None,
    )


@router.get("/{board_id}/access-requests/mine", response_model=MyAccessRequestOut)
async def my_access_request(
    board_id: uuid.UUID,
    user: CurrentUser,
    session: Session,
) -> MyAccessRequestOut:
    """Where the waiting screen looks while somebody decides.

    `has_access` rather than the request's own status is what that screen actually
    acts on. An owner may let somebody in by a route that has nothing to do with the
    request - adding them as a member, or opening the board to the public - and a
    screen watching only its own row would leave them staring at "waiting" while the
    board sat open behind it.
    """
    return await _my_request_state(session, board_id=board_id, user_id=user.id)


@router.post(
    "/{board_id}/access-requests",
    response_model=MyAccessRequestOut,
    status_code=status.HTTP_202_ACCEPTED,
)
async def request_access(
    board_id: uuid.UUID,
    body: AccessRequestCreate,
    request: Request,
    user: CurrentUser,
    session: Session,
) -> MyAccessRequestOut:
    """Ask to be let in.

    202, not 201: nothing was created that the caller can go and look at, and the thing
    they actually want has not happened yet. It is an accepted request awaiting a
    person.

    No role dependency on this route, which makes it the only board route reachable
    without any access to the board - that is the entire point of it. What stands in
    for the check is that it grants nothing, reveals nothing, and is rate limited per
    account, because each new ask puts mail in somebody else's inbox.
    """
    if body.role not in access_requests.ASKABLE_ROLES:
        askable = " or ".join(sorted(str(r) for r in access_requests.ASKABLE_ROLES))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"you may ask for {askable}",
        )

    if settings.rate_limit_enabled:
        allowed = await rate_limit_check(
            request.app.state.redis,
            action="access-request",
            identity=str(user.id),
            spec=settings.rate_limit_access_request,
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many requests"
            )

    board = await session.get(Board, board_id)
    if board is None:
        # Answered exactly as a real board with no request on it would be - see
        # `_my_request_state`. Nothing is written, because there is nothing to write it
        # against.
        return MyAccessRequestOut(status="none", role=None, has_access=False)

    existing_role = await resolve_role(session, user_id=user.id, board_id=board_id)
    if existing_role is not None and at_least(existing_role, body.role):
        # They already have what they are asking for. Recording a request would put a
        # decision in front of an owner that has already been made, and the honest
        # answer is that the door is open.
        return MyAccessRequestOut(status="granted", role=body.role, has_access=True)

    _, notify = await access_requests.ask(
        session, board_id=board_id, user_id=user.id, role=body.role
    )
    await session.commit()

    if notify:
        await access_requests.notify_owners(session, board=board, asker=user, role=body.role)

    return MyAccessRequestOut(
        status="pending", role=body.role, has_access=existing_role is not None
    )


@router.get("/{board_id}/access-requests", response_model=list[AccessRequestOut])
async def list_access_requests(
    board_id: uuid.UUID,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> list[AccessRequestOut]:
    """Who is waiting. Owner only, like every other control over who may be here."""
    return [
        AccessRequestOut(
            id=request.id,
            user_id=asker.id,
            email=asker.email,
            display_name=asker.display_name,
            avatar_url=asker.avatar_url,
            role=request.role,
            created_at=request.created_at,
        )
        for request, asker in await access_requests.waiting(session, board_id)
    ]


@router.post("/{board_id}/access-requests/{request_id}", response_model=ShareState)
async def decide_access_request(
    board_id: uuid.UUID,
    request_id: uuid.UUID,
    body: AccessRequestDecision,
    request: Request,
    user: CurrentUser,
    session: Session,
    role: Annotated[BoardRole, Depends(board_owner)],
) -> ShareState:
    """Let somebody in, or turn them down.

    Approving writes the same `board_members` row an invitation would, through the same
    rule: never lower what somebody already holds. Somebody who asked to view while
    already an editor through their workspace is asking for less than they have, and
    granting it must not take the rest away.

    Answers with the whole share state, like every other write in this section, so the
    dialog redraws from what the server holds rather than from what it guessed.
    """
    board = await session.get(Board, board_id)
    if board is None:  # pragma: no cover - board_owner already resolved it
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    pending = await session.get(BoardAccessRequest, request_id)
    # Scoped by board as well as by id, for the reason `revoke_invite` is: an id alone
    # is enough to find a row belonging to somebody else's board.
    if pending is None or pending.board_id != board_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such request")

    granted = body.role or pending.role
    if body.approve and granted not in access_requests.ASKABLE_ROLES:
        askable = " or ".join(sorted(str(r) for r in access_requests.ASKABLE_ROLES))
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"a request may be granted {askable}",
        )

    pending.status = access_requests.GRANTED if body.approve else access_requests.DECLINED
    pending.decided_at = datetime.now(UTC)
    pending.decided_by = user.id

    target = await session.get(User, pending.user_id)
    before = await resolve_role(session, user_id=pending.user_id, board_id=board_id)

    if body.approve:
        existing = await session.get(BoardMember, (board_id, pending.user_id))
        if existing is None:
            session.add(
                BoardMember(board_id=board_id, user_id=pending.user_id, role=granted)
            )
        elif rank(granted) > rank(existing.role):
            existing.role = granted

    await session.commit()

    if body.approve:
        effective = await resolve_role(session, user_id=pending.user_id, board_id=board_id)
        if target is not None and effective is not None and effective != before:
            await sharing.notify_role_change(
                board=board, member=target, role=effective, actor=user
            )
        # They may be sitting on the waiting screen with a socket that was refused, or
        # already here as a viewer holding a read-only channel. Either way the answer
        # the handshake gave them is out of date.
        await _evict(request, board_id, "access granted")

    return await _share_state(session, board, request)
