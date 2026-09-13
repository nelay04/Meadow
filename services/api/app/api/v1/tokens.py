"""Personal access tokens: mint, list, revoke. See `app/services/api_tokens.py`.

Session only, all three. `CurrentUser` refuses a token, so a token cannot mint another,
cannot see the list, and cannot revoke its siblings: a stolen one must not be a way to
make itself permanent or to take the owner's other clients offline.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.auth.deps import CurrentUser, Session
from app.models import ApiToken
from app.realtime.rooms import WS_CLOSE_UNAUTHORIZED, SocketRegistry
from app.schemas.auth import ApiTokenCreate, ApiTokenCreated, ApiTokenOut
from app.services import api_tokens
from app.services.permissions import resolve_role

router = APIRouter(prefix="/tokens", tags=["tokens"])


def _out(row: ApiToken) -> ApiTokenOut:
    return ApiTokenOut(
        id=row.id,
        name=row.name,
        prefix=row.prefix,
        scope=api_tokens.TokenScope(row.scope).value,
        board_ids=row.board_ids,
        created_at=row.created_at,
        expires_at=row.expires_at,
        last_used_at=row.last_used_at,
    )


@router.get("", response_model=list[ApiTokenOut])
async def list_tokens(user: CurrentUser, session: Session) -> list[ApiTokenOut]:
    """Live tokens, newest first. Revoked and expired ones are gone from the list."""
    return [_out(row) for row in await api_tokens.list_live(session, user.id)]


@router.post("", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
async def create_token(
    body: ApiTokenCreate, user: CurrentUser, session: Session
) -> ApiTokenCreated:
    if len(await api_tokens.list_live(session, user.id)) >= api_tokens.MAX_LIVE_TOKENS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"at most {api_tokens.MAX_LIVE_TOKENS} tokens; revoke one first",
        )

    board_ids = None
    if body.board_ids is not None:
        board_ids = list(dict.fromkeys(body.board_ids))
        # Every board named must be one the account can open now. Otherwise the
        # allow-list would answer "does this board id exist" for anybody who asked, and
        # a token naming a board you were later given would be a grant made in advance.
        for board_id in board_ids:
            if await resolve_role(session, user_id=user.id, board_id=board_id) is None:
                raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")

    issued = await api_tokens.issue(
        session,
        user_id=user.id,
        name=body.name.strip() or "Access token",
        scope=api_tokens.TokenScope(body.scope),
        board_ids=board_ids,
        expires_in_days=body.expires_in_days,
    )
    return ApiTokenCreated(**_out(issued.row).model_dump(), token=issued.raw)


@router.delete("/{token_id}", status_code=status.HTTP_204_NO_CONTENT)
async def revoke_token(
    token_id: uuid.UUID, request: Request, user: CurrentUser, session: Session
) -> None:
    """Revoke, and close every socket the token has open.

    4401 on those sockets rather than 4403: the credential is what went bad. A client
    that re-mints on 4403 would otherwise try again with the same dead token forever.
    """
    if not await api_tokens.revoke(session, user.id, token_id):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such token")

    sockets: SocketRegistry | None = getattr(request.app.state, "sockets", None)
    if sockets is not None:
        await sockets.evict_token(
            str(token_id), code=WS_CLOSE_UNAUTHORIZED, reason="access token revoked"
        )
