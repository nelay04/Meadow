"""The endpoints somebody without an account can reach.

Everything else in this API is behind a bearer token. These four are not, and each one
is unauthenticated for a specific reason rather than by omission:

- `GET /share/{token}` and `POST /share/{token}/ws-token` are the public link. A link
  that needs an account first is not a public link; it is a link to a sign-up form. The
  capability *is* the credential, and it is checked on every call - a board switched
  back to restricted stops answering here immediately.

- `GET /invites/{token}` is what an invitation link shows before the person it names
  has registered. It is the one screen in the app whose whole audience has no account
  by definition.

- `POST /invites/{token}/accept` is the exception and does require a session: accepting
  is granting, and there has to be an account to grant it to.

The rate limits here are keyed on the client address rather than a user id, because
there is no user. That is weaker - an address is shared by everyone behind one NAT -
and it is the only key available; what it defends is a scripted caller walking token
space, which it does well enough, and not a determined attacker with a proxy pool.
"""

import time
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, HTTPException, Path, Request, status

from app.api.v1.boards import _out
from app.auth.deps import CurrentUser, Session
from app.config import settings
from app.models import Board, BoardMember, User
from app.realtime import wstoken
from app.schemas.boards import BoardOut, JoinInvitationOut, PublicBoardOut, WsTokenOut
from app.services import sharing
from app.services.board_kinds import BoardKind
from app.services.permissions import BoardRole, rank, resolve_role
from app.services.ratelimit import check as rate_limit_check

router = APIRouter(tags=["sharing"])

# A share token is a fixed-width urlsafe value. Bounding the path parameter means a
# multi-kilobyte string is refused by the router rather than being carried into a
# database query and an HMAC.
_MAX_TOKEN = 128

#: The one path parameter every route here takes.
Token = Annotated[str, Path(max_length=_MAX_TOKEN)]


async def _limit(request: Request, action: str) -> None:
    if not settings.rate_limit_enabled:
        return
    identity = request.client.host if request.client else "unknown"
    allowed = await rate_limit_check(
        request.app.state.redis,
        action=action,
        identity=identity,
        spec=settings.rate_limit_share,
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many requests"
        )


@router.get("/share/{token}", response_model=PublicBoardOut)
async def open_shared_board(
    token: Token,
    request: Request,
    session: Session,
) -> PublicBoardOut:
    """What a share link opens, for somebody holding nothing else.

    404 rather than 403 for a token that resolves to nothing, and this is the one place
    in the API where that is right. Everywhere else a 404 would leak which board ids
    exist; here the caller supplied a random string of their own and the only thing
    "not found" tells them is that their random string was not one of ours.
    """
    await _limit(request, "share-open")

    resolved = await sharing.resolve_link(session, token)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such link")

    board, role = resolved
    locked = board.locked_at is not None
    return PublicBoardOut(
        id=board.id,
        title=board.title,
        kind=BoardKind(board.kind),
        role=role,
        is_locked=locked,
        # A visitor on an editor link still cannot type into a locked board. The lock
        # is on the document, so it applies to however you got here.
        can_write=role is BoardRole.editor and not locked,
    )


@router.post("/share/{token}/ws-token", response_model=WsTokenOut)
async def mint_guest_ws_token(
    token: Token,
    request: Request,
    session: Session,
) -> WsTokenOut:
    """A websocket credential for an anonymous link visitor.

    Separate from `/ws-token` rather than a branch inside it, because the two differ in
    the thing that matters most about an endpoint: one requires a session and the other
    must not have one. Folding them together would put an `if authenticated` in the
    middle of the code path that decides who may open a socket, which is exactly the
    place that should have no branches nobody can see.

    A signed-in person on a public link does *not* come here. They post to `/ws-token`
    with the same link token and get their membership role or the link's, whichever is
    higher - which is what stops a viewer link demoting an editor who follows it.

    The guest id is minted here and thrown away by this process immediately: it lives
    only inside the signed token, and it is what lets two anonymous visitors be two
    cursors instead of one. It identifies nobody and grants nothing.
    """
    await _limit(request, "share-ws-token")

    resolved = await sharing.resolve_link(session, token)
    if resolved is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such link")

    board, role = resolved
    locked = board.locked_at is not None

    return WsTokenOut(
        token=wstoken.mint(
            str(board.id),
            None,
            # No session to inherit, so one is invented. It is what makes a revoked
            # link close the sockets it opened even if nothing evicts them sooner - see
            # `wstoken.GUEST_SESSION_TTL_SECONDS`.
            int(time.time()) + wstoken.GUEST_SESSION_TTL_SECONDS,
            guest_id=wstoken.new_guest_id(),
            link_token=token,
        ),
        expires_in=settings.ws_token_ttl_seconds,
        role=role,
        can_write=role is BoardRole.editor and not locked,
        is_locked=locked,
    )


@router.get("/invites/{token}", response_model=JoinInvitationOut)
async def read_invitation(
    token: Token,
    request: Request,
    session: Session,
) -> JoinInvitationOut:
    """What a `#/join/...` link says, to somebody who is probably not registered yet.

    Says as little as it can while still being worth reading. The address it names,
    so the person registers with the right one - registering with a different one is
    the single way to arrive with an account and still not have the board - and the
    title, so they can tell this is the thing they were told about. No board id: the
    invitation is not access, and an id is no use until it becomes access.
    """
    await _limit(request, "invite-read")

    invitation = await sharing.invitation_by_token(session, token)
    if invitation is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such invitation")

    board = await session.get(Board, invitation.board_id)
    if board is None:  # pragma: no cover - the FK cascades, so this cannot happen
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such invitation")

    inviter = (
        None if invitation.invited_by is None else await session.get(User, invitation.invited_by)
    )

    if invitation.revoked_at is not None:
        state = "revoked"
    elif invitation.accepted_at is not None:
        state = "accepted"
    else:
        state = "pending"

    return JoinInvitationOut(
        email=invitation.email,
        title=board.title,
        kind=BoardKind(board.kind),
        role=invitation.role,
        status=state,
        invited_by=None if inviter is None else inviter.display_name,
    )


@router.post("/invites/{token}/accept", response_model=BoardOut)
async def accept_invitation(
    token: Token,
    user: CurrentUser,
    session: Session,
) -> BoardOut:
    """Redeem an invitation for the account that is signed in.

    Almost always redundant, and worth keeping for the case where it is not. The usual
    path applies invitations at activation, by address, so somebody who registers with
    the address they were invited at never needs this. What is left is the person who
    already had an account when the invitation was written - they were invited before
    they registered, or under a second address they also own - and following the link
    while signed in is how they say so.

    The address still has to match. An invitation is a promise made to an address, and
    honouring it for whoever happens to be holding the link would make the address part
    decorative: forwarding the message would forward the access.
    """
    invitation = await sharing.invitation_by_token(session, token)
    if invitation is None or invitation.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such invitation")

    # citext on both sides, so this is the same case-insensitive comparison the
    # database would make.
    if invitation.email.lower() != user.email.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="that invitation was sent to a different address",
        )

    board = await session.get(Board, invitation.board_id)
    if board is None:  # pragma: no cover - the FK cascades, so this cannot happen
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such invitation")

    existing = await session.get(BoardMember, (board.id, user.id))
    if existing is None:
        session.add(
            BoardMember(board_id=board.id, user_id=user.id, role=invitation.role)
        )
    elif rank(invitation.role) > rank(existing.role):
        # Never lowers. Accepting an offer of access does not withdraw access already
        # held, which is the same rule `sharing.apply_pending` follows.
        existing.role = invitation.role

    if invitation.accepted_at is None:
        invitation.accepted_at = datetime.now(UTC)
    await session.commit()
    await session.refresh(board)

    role = await resolve_role(session, user_id=user.id, board_id=board.id)
    # The board router's own serialiser, so an accepted invitation answers with exactly
    # the shape every other board response has. The board list refreshes from this.
    return _out(board, role or invitation.role)
