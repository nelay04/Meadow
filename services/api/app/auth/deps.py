"""FastAPI dependencies for authentication and board authorisation."""

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Path, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import AccessTokenError, decode_access_token
from app.db import get_session
from app.models import User
from app.services import session_events
from app.services.permissions import BoardRole, resolve_role

_bearer = HTTPBearer(auto_error=False)


async def current_user(
    request: Request,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> User:
    if credentials is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    try:
        claims = decode_access_token(credentials.credentials)
    except AccessTokenError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid access token",
            headers={"WWW-Authenticate": "Bearer"},
        ) from exc

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


CurrentUser = Annotated[User, Depends(current_user)]
Session = Annotated[AsyncSession, Depends(get_session)]


class BoardAccess:
    """Dependency factory: resolve the caller's board role, or 403.

    Routers declare the minimum role they need and get the resolved one back, so no
    router ever reimplements the rule - `resolve_role` stays the only place it lives.

    `include_deleted` opens the dependency to boards in the trash, and only the trash
    routes set it. Everywhere else the default keeps a deleted board answering 403,
    which is `resolve_role`'s doing rather than this class's - see the note there.
    """

    def __init__(self, minimum: BoardRole, *, include_deleted: bool = False) -> None:
        self.minimum = minimum
        self.include_deleted = include_deleted

    async def __call__(
        self,
        user: CurrentUser,
        session: Session,
        board_id: Annotated[uuid.UUID, Path()],
    ) -> BoardRole:
        role = await resolve_role(
            session,
            user_id=user.id,
            board_id=board_id,
            include_deleted=self.include_deleted,
        )
        # 403 and not 404 even when the board does not exist: a different status for
        # "no such board" would let anyone probe which board ids are real.
        if role is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

        from app.services.permissions import at_least

        if not at_least(role, self.minimum):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")
        return role


board_viewer = BoardAccess(BoardRole.viewer)
board_editor = BoardAccess(BoardRole.editor)
board_owner = BoardAccess(BoardRole.owner)
#: Owner of a board that is in the trash. Restore and permanent delete, and nothing
#: else: a board here is not open, not editable and not shareable, so every other route
#: keeps the ordinary dependency and keeps answering 403 for it.
board_owner_trashed = BoardAccess(BoardRole.owner, include_deleted=True)
