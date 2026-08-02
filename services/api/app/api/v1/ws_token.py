"""The ws-token endpoint.

Minting resolves the role exactly as the handshake does. Both matter: minting is what
stops a caller obtaining a credential for a board they cannot open, and the handshake
is what stops a credential obtained legitimately from being used after access is gone.
Neither one alone is sufficient.
"""

import time
from contextlib import suppress
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.auth.deps import CurrentUser, Session
from app.auth.tokens import AccessTokenError, decode_access_token
from app.config import settings
from app.realtime import wstoken
from app.schemas.boards import WsTokenOut, WsTokenRequest
from app.services.permissions import resolve_role
from app.services.ratelimit import check as rate_limit_check

router = APIRouter(tags=["realtime"])

_bearer = HTTPBearer(auto_error=False)


@router.post("/ws-token", response_model=WsTokenOut)
async def create_ws_token(
    body: WsTokenRequest,
    request: Request,
    user: CurrentUser,
    session: Session,
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)] = None,
) -> WsTokenOut:
    if settings.rate_limit_enabled:
        allowed = await rate_limit_check(
            request.app.state.redis,
            action="ws-token",
            identity=str(user.id),
            spec=settings.rate_limit_ws_token,
        )
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many requests"
            )

    role = await resolve_role(session, user_id=user.id, board_id=body.board_id)
    if role is None:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    # The ws-token inherits the access token's expiry and can never outlive it. A
    # longer-lived ws-token would be a way to launder an expiring session into a
    # connection that stays open past it.
    session_expires_at = int(time.time()) + settings.access_token_ttl_seconds
    if credentials is not None:
        # CurrentUser already decoded this successfully, so the suppress is only for
        # the pathological case of the token expiring between the two decodes.
        with suppress(AccessTokenError):
            session_expires_at = decode_access_token(credentials.credentials).expires_at

    return WsTokenOut(
        token=wstoken.mint(str(body.board_id), user.id, session_expires_at),
        expires_in=settings.ws_token_ttl_seconds,
        role=role,
    )
