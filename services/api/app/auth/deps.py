"""FastAPI dependencies for authentication and board authorisation."""

import uuid
from dataclasses import dataclass
from typing import Annotated

from fastapi import Depends, HTTPException, Path, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import AccessTokenError, decode_access_token
from app.db import get_session
from app.models import ApiToken, User
from app.services import api_tokens, session_events
from app.services.permissions import BoardRole, resolve_role

_bearer = HTTPBearer(auto_error=False)


def _unauthorised(detail: str) -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail=detail,
        headers={"WWW-Authenticate": "Bearer"},
    )


@dataclass(frozen=True)
class Principal:
    """Who is calling, and through what.

    `api_token` is None for a browser session. When it is set, the caller is the token's
    owner narrowed by it - see `app/services/api_tokens.py` - and every route that takes
    a `Principal` rather than a `User` has agreed to apply that narrowing.
    """

    user: User
    api_token: ApiToken | None = None

    @property
    def read_only(self) -> bool:
        return self.api_token is not None and api_tokens.is_read_only(self.api_token)

    def allows_board(self, board_id: uuid.UUID) -> bool:
        return self.api_token is None or api_tokens.allows_board(self.api_token, board_id)


async def _session_user(request: Request, raw: str, session: AsyncSession) -> User:
    try:
        claims = decode_access_token(raw)
    except AccessTokenError as exc:
        raise _unauthorised("invalid access token") from exc

    # Terminated since this token was minted. The signature is still good and the
    # expiry has not passed, which is exactly the window the sessions screen promises
    # to close: without this, ending a session you do not recognise leaves it holding a
    # working credential for the rest of its fifteen minutes.
    #
    # One Redis key lookup on a path that already makes a Postgres round trip below,
    # and it fails open - see `session_events.is_revoked` for why an unreachable Redis
    # must not sign everybody out.
    if claims.session_id != "" and await session_events.is_revoked(
        request.app.state.redis, claims.session_id
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="session was terminated"
        )

    user = await session.get(User, claims.user_id)
    if user is None:
        # Signature valid but the account is gone. Deleting a user must not leave
        # their outstanding tokens working until expiry.
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unknown user")
    return user


async def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    """A browser session, and nothing else.

    Refuses a personal access token by name rather than by failing to decode it, so the
    caller is told what is wrong. This is the default for every route, which is what
    makes token access opt-in: see `current_principal`.
    """
    if credentials is None:
        raise _unauthorised("not authenticated")
    if api_tokens.looks_like_token(credentials.credentials):
        raise _unauthorised("access tokens are not accepted on this route")
    return await _session_user(request, credentials.credentials, session)


async def current_principal(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Principal:
    """A browser session or a personal access token.

    Only for the routes an MCP client needs. Taking this instead of `CurrentUser` is the
    decision that a token may reach the route, and it comes with the obligation to honour
    `Principal.read_only` and `Principal.allows_board`.
    """
    if credentials is None:
        raise _unauthorised("not authenticated")
    raw = credentials.credentials
    if not api_tokens.looks_like_token(raw):
        return Principal(user=await _session_user(request, raw, session))

    token = await api_tokens.authenticate(session, raw)
    if token is None:
        raise _unauthorised("invalid access token")
    user = await session.get(User, token.user_id)
    if user is None:
        raise _unauthorised("unknown user")
    return Principal(user=user, api_token=token)


CurrentUser = Annotated[User, Depends(current_user)]
CurrentPrincipal = Annotated[Principal, Depends(current_principal)]
Session = Annotated[AsyncSession, Depends(get_session)]


class BoardAccess:
    """Dependency factory: resolve the caller's board role, or 403.

    Routers declare the minimum role they need and get the resolved one back, so no
    router ever reimplements the rule - `resolve_role` stays the only place it lives.

    `include_deleted` opens the dependency to boards in the trash, and only the trash
    routes set it. Everywhere else the default keeps a deleted board answering 403,
    which is `resolve_role`'s doing rather than this class's - see the note there.

    `accept_api_token` lets a personal access token through. Off by default, so a board
    route is session-only until somebody decides otherwise. When on, the token's board
    allow-list shuts other boards, and a read-scoped token is refused any minimum above
    viewer: the role is the account's, and the token only takes away from it.
    """

    def __init__(
        self,
        minimum: BoardRole,
        *,
        include_deleted: bool = False,
        accept_api_token: bool = False,
    ) -> None:
        self.minimum = minimum
        self.include_deleted = include_deleted
        self.accept_api_token = accept_api_token

    async def __call__(
        self,
        principal: CurrentPrincipal,
        session: Session,
        board_id: Annotated[uuid.UUID, Path()],
    ) -> BoardRole:
        if principal.api_token is not None and not self.accept_api_token:
            raise _unauthorised("access tokens are not accepted on this route")

        role = await resolve_role(
            session,
            user_id=principal.user.id,
            board_id=board_id,
            include_deleted=self.include_deleted,
        )
        # 403 and not 404 even when the board does not exist: a different status for
        # "no such board" would let anyone probe which board ids are real.
        if role is None or not principal.allows_board(board_id):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

        from app.services.permissions import at_least

        if not at_least(role, self.minimum):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")
        if principal.read_only and self.minimum is not BoardRole.viewer:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="read-only token")
        return role


board_viewer = BoardAccess(BoardRole.viewer)
board_editor = BoardAccess(BoardRole.editor)
board_owner = BoardAccess(BoardRole.owner)
#: Owner of a board that is in the trash. Restore and permanent delete, and nothing
#: else: a board here is not open, not editable and not shareable, so every other route
#: keeps the ordinary dependency and keeps answering 403 for it.
board_owner_trashed = BoardAccess(BoardRole.owner, include_deleted=True)
#: `board_viewer` that a personal access token may also pass. Reading board metadata.
board_viewer_or_token = BoardAccess(BoardRole.viewer, accept_api_token=True)
