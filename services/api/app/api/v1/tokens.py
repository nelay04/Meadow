"""Personal access tokens: mint, list, change, revoke, and a token describing itself.

Everything except `GET /tokens/current` is session only. `CurrentUser` refuses a token,
so a token cannot mint another, see the list, widen its own grants or revoke its
siblings: a stolen one must not be a way to make itself permanent or to take the owner's
other clients offline. See `app/services/api_tokens.py`.
"""

import uuid

from fastapi import APIRouter, HTTPException, Request, status

from app.auth.deps import CurrentPrincipal, CurrentUser, Session
from app.models import ApiToken
from app.realtime.rooms import WS_CLOSE_FORBIDDEN, WS_CLOSE_UNAUTHORIZED, SocketRegistry
from app.schemas.auth import (
    ApiTokenCreate,
    ApiTokenCreated,
    ApiTokenCurrent,
    ApiTokenGrantIn,
    ApiTokenGrantOut,
    ApiTokenOut,
    ApiTokenPatch,
)
from app.services import api_tokens
from app.services.api_tokens import GrantSpec, TokenKind
from app.services.permissions import TokenGrant, resolve_role

router = APIRouter(prefix="/tokens", tags=["tokens"])


def _grants_out(entries: list[tuple[uuid.UUID, str, TokenGrant]]) -> list[ApiTokenGrantOut]:
    return [
        ApiTokenGrantOut(board_id=board_id, title=title, edit=grant.edit, delete=grant.delete)
        for board_id, title, grant in entries
    ]


def _out(row: ApiToken, grants: list[tuple[uuid.UUID, str, TokenGrant]]) -> ApiTokenOut:
    classic = api_tokens.is_classic(row)
    return ApiTokenOut(
        id=row.id,
        name=row.name,
        prefix=row.prefix,
        kind=TokenKind(row.kind).value,
        grants=None if classic else _grants_out(grants),
        can_create=api_tokens.can_create_glades(row),
        created_at=row.created_at,
        expires_at=row.expires_at,
        last_used_at=row.last_used_at,
    )


async def _checked_grants(
    session: Session, user_id: uuid.UUID, grants: list[ApiTokenGrantIn]
) -> list[GrantSpec]:
    """Every glade named must be one the account can open now.

    Otherwise a grant would answer "does this board id exist" for anybody who asked, and a
    grant naming a glade you were later given would be access decided in advance.
    """
    for grant in grants:
        if await resolve_role(session, user_id=user_id, board_id=grant.board_id) is None:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")
    return [GrantSpec(board_id=g.board_id, edit=g.edit, delete=g.delete) for g in grants]


async def _evict(request: Request, token_id: uuid.UUID, *, code: int, reason: str) -> None:
    sockets: SocketRegistry | None = getattr(request.app.state, "sockets", None)
    if sockets is not None:
        await sockets.evict_token(str(token_id), code=code, reason=reason)


@router.get("", response_model=list[ApiTokenOut])
async def list_tokens(user: CurrentUser, session: Session) -> list[ApiTokenOut]:
    """Live tokens, newest first. Revoked and expired ones are gone from the list."""
    rows = await api_tokens.list_live(session, user.id)
    grants = await api_tokens.grant_titles(session, [row.id for row in rows])
    return [_out(row, grants.get(row.id, [])) for row in rows]


@router.post("", response_model=ApiTokenCreated, status_code=status.HTTP_201_CREATED)
async def create_token(
    body: ApiTokenCreate, user: CurrentUser, session: Session
) -> ApiTokenCreated:
    if len(await api_tokens.list_live(session, user.id)) >= api_tokens.MAX_LIVE_TOKENS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"at most {api_tokens.MAX_LIVE_TOKENS} tokens; revoke one first",
        )
    grants = await _checked_grants(session, user.id, body.grants or [])
    issued = await api_tokens.issue(
        session,
        user_id=user.id,
        name=body.name.strip() or "Access token",
        kind=TokenKind(body.kind),
        grants=grants,
        can_create=body.can_create,
        expires_in_days=body.expires_in_days,
    )
    titles = await api_tokens.grant_titles(session, [issued.row.id])
    out = _out(issued.row, titles.get(issued.row.id, []))
    return ApiTokenCreated(**out.model_dump(), token=issued.raw)


# Before `/{token_id}`, which would otherwise claim this path and reject it as a uuid.
@router.get("/current", response_model=ApiTokenCurrent)
async def current_token(principal: CurrentPrincipal, session: Session) -> ApiTokenCurrent:
    """The token making this request, describing its own boundaries.

    Reachable by the token itself, which is the point: an MCP server reads this so the
    model knows what it may do before trying. A session is not a token and gets 404.
    Grants on glades the owner can no longer open are left out, since the handshake would
    refuse them anyway.
    """
    token = principal.api_token
    if token is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="not a token")
    classic = api_tokens.is_classic(token)
    entries: list[tuple[uuid.UUID, str, TokenGrant]] = []
    if not classic:
        for board_id, title, grant in (await api_tokens.grant_titles(session, [token.id])).get(
            token.id, []
        ):
            role = await resolve_role(session, user_id=principal.user.id, board_id=board_id)
            if role is not None:
                entries.append((board_id, title, grant))
    return ApiTokenCurrent(
        id=token.id,
        name=token.name,
        kind=TokenKind(token.kind).value,
        expires_at=token.expires_at,
        can_create_glades=api_tokens.can_create_glades(token),
        grants=None if classic else _grants_out(entries),
    )


@router.patch("/{token_id}", response_model=ApiTokenOut)
async def update_token(
    token_id: uuid.UUID, body: ApiTokenPatch, request: Request, user: CurrentUser, session: Session
) -> ApiTokenOut:
    """Rename a token, or change a fine-grained token's glades, permissions and creating.

    A changed grant closes the token's open sockets with 4403, the same code a changed
    role gets, so a client re-mints and the handshake applies the new grant. Leaving them
    open would let a socket keep a permission its owner just took away.
    """
    token = await api_tokens.load_owned(session, user.id, token_id)
    if token is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such token")
    classic = api_tokens.is_classic(token)
    if body.grants is not None and classic:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="a classic token has no grants; create a fine-grained token instead",
        )
    if body.can_create is not None and classic:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="a classic token may already create glades",
        )

    # What the token will be able to do once this patch lands, not what it does now: a
    # patch that clears the glade list and grants creating in one call is a token that
    # names nothing yet and fills its list itself, which is allowed.
    will_create = token.can_create if body.can_create is None else body.can_create
    if body.grants is not None and not body.grants and not (classic or will_create):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="a fine-grained token needs at least one glade, or leave to create them",
        )

    if body.name is not None:
        token.name = body.name.strip() or token.name
        await session.commit()
    if body.can_create is not None:
        token.can_create = body.can_create
        await session.commit()
    if body.grants is not None:
        await api_tokens.replace_grants(
            session, token, await _checked_grants(session, user.id, body.grants)
        )
        await _evict(request, token.id, code=WS_CLOSE_FORBIDDEN, reason="access token changed")

    await session.refresh(token)
    titles = await api_tokens.grant_titles(session, [token.id])
    return _out(token, titles.get(token.id, []))


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
    await _evict(request, token_id, code=WS_CLOSE_UNAUTHORIZED, reason="access token revoked")
