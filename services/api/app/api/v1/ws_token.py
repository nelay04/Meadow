"""The ws-token endpoint, for a caller who is signed in.

Minting resolves access exactly as the handshake does, through the same
`resolve_access`. Both matter: minting is what stops a caller obtaining a credential
for a board they cannot open, and the handshake is what stops a credential obtained
legitimately from being used after access is gone. Neither one alone is sufficient.

An anonymous visitor on a public link mints at `/share/{token}/ws-token` instead - see
`app/api/v1/share.py`. The split is deliberate: this route requires a session, that one
must not have one, and an `if authenticated` in the middle of the code path that hands
out websocket credentials is a branch nobody would see while reading either half.
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
from app.services.permissions import resolve_access
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

    # Membership *and* the share link the browser arrived with, whichever gives more.
    # Presenting the link on every mint rather than only when membership fails is what
    # stops a viewer link demoting an editor who follows one, and what lets a person
    # with no grant at all open a public board without a second endpoint.
    access = await resolve_access(
        session,
        board_id=body.board_id,
        user_id=user.id,
        link_token=body.link_token,
    )
    if access is None:
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
        token=wstoken.mint(
            str(body.board_id),
            user.id,
            session_expires_at,
            # Carried into the token so the handshake resolves the same way this mint
            # did. Without it a member-by-link would be refused at connect time, sixty
            # seconds after being told they were welcome.
            link_token=body.link_token,
        ),
        expires_in=settings.ws_token_ttl_seconds,
        role=access.role,
        can_write=access.can_write,
        is_locked=access.locked,
    )
