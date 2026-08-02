"""FastAPI dependencies for authentication and board authorisation."""

import uuid
from typing import Annotated

from fastapi import Depends, HTTPException, Path, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.tokens import AccessTokenError, decode_access_token
from app.db import get_session
from app.models import User
from app.services.permissions import BoardRole, resolve_role

_bearer = HTTPBearer(auto_error=False)


async def current_user(
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
    """

    def __init__(self, minimum: BoardRole) -> None:
        self.minimum = minimum

    async def __call__(
        self,
        user: CurrentUser,
        session: Session,
        board_id: Annotated[uuid.UUID, Path()],
    ) -> BoardRole:
        role = await resolve_role(session, user_id=user.id, board_id=board_id)
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
