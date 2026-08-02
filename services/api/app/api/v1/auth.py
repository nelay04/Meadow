"""Registration, login, refresh rotation, logout. ARCHITECTURE 6 and 7."""

import ipaddress
import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.auth import password as passwords
from app.auth.deps import CurrentUser, Session
from app.auth.tokens import create_access_token, hash_refresh_token, new_refresh_token
from app.config import settings
from app.models import RefreshToken, User, Workspace, WorkspaceMember
from app.schemas.auth import AuthResponse, LoginRequest, RegisterRequest, TokenPair, UserOut
from app.services.permissions import WorkspaceRole
from app.services.ratelimit import check as rate_limit_check

router = APIRouter(prefix="/auth", tags=["auth"])

_INVALID_CREDENTIALS = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password"
)


async def _enforce_rate_limit(request: Request, action: str, identity: str, spec: str) -> None:
    if not settings.rate_limit_enabled:
        return
    allowed = await rate_limit_check(
        request.app.state.redis, action=action, identity=identity, spec=spec
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many requests"
        )


def _client_ip(request: Request) -> str | None:
    """The peer address, but only if it really is one.

    `ip` is an inet column, so anything unparseable fails the insert and takes the
    whole login with it. ASGI does not promise a numeric host - the test client sends
    a name, and a mangled proxy header would do the same in production. Audit metadata
    is never worth failing an auth request over.
    """
    if request.client is None:
        return None
    try:
        ipaddress.ip_address(request.client.host)
    except ValueError:
        return None
    return request.client.host


def _slugify(name: str, suffix: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "workspace"
    return f"{base[:40]}-{suffix}"


def _set_refresh_cookie(response: Response, raw_token: str) -> None:
    response.set_cookie(
        settings.refresh_cookie_name,
        raw_token,
        max_age=settings.refresh_token_ttl_days * 24 * 3600,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        samesite="lax",
        path="/api/v1/auth",
    )


async def _issue_session(
    session: Session, response: Response, request: Request, user: User, family_id: uuid.UUID
) -> TokenPair:
    """Mint an access token and a fresh refresh token in `family_id`'s lineage."""
    raw_refresh, token_hash = new_refresh_token()
    session.add(
        RefreshToken(
            user_id=user.id,
            token_hash=token_hash,
            family_id=family_id,
            expires_at=datetime.now(UTC) + timedelta(days=settings.refresh_token_ttl_days),
            user_agent=request.headers.get("user-agent"),
            ip=_client_ip(request),
        )
    )
    await session.commit()

    access_token, expires_at = create_access_token(user.id)
    _set_refresh_cookie(response, raw_refresh)
    return TokenPair(
        access_token=access_token, expires_in=expires_at - int(datetime.now(UTC).timestamp())
    )


async def _default_workspace_id(session: Session, user: User) -> uuid.UUID | None:
    return (
        await session.execute(
            select(Workspace.id)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
            .where(WorkspaceMember.user_id == user.id)
            .order_by(Workspace.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()


@router.post("/register", response_model=AuthResponse, status_code=status.HTTP_201_CREATED)
async def register(
    body: RegisterRequest, request: Request, response: Response, session: Session
) -> AuthResponse:
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "register", identity, settings.rate_limit_register)

    user = User(
        email=str(body.email),
        password_hash=passwords.hash_password(body.password),
        display_name=body.display_name,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        await session.rollback()
        # Deliberately the same message as a bad password on login. Distinguishing
        # them turns registration into an account-enumeration oracle.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="could not create account"
        ) from exc

    # A personal workspace, so a new user can create a board immediately. Boards
    # always live in a workspace - that is where the shared permission grant lives.
    workspace = Workspace(
        name=f"{body.display_name}'s workspace",
        slug=_slugify(body.display_name, uuid.uuid4().hex[:8]),
        owner_id=user.id,
    )
    session.add(workspace)
    await session.flush()
    session.add(
        WorkspaceMember(
            workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.owner
        )
    )

    tokens = await _issue_session(session, response, request, user, uuid.uuid4())
    return AuthResponse(
        **tokens.model_dump(),
        user=UserOut(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            default_workspace_id=workspace.id,
        ),
    )


@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest, request: Request, response: Response, session: Session
) -> AuthResponse:
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "login", identity, settings.rate_limit_login)

    user = (
        await session.execute(select(User).where(User.email == str(body.email)))
    ).scalar_one_or_none()

    if user is None or not passwords.verify_password(user.password_hash, body.password):
        raise _INVALID_CREDENTIALS

    if passwords.needs_rehash(user.password_hash):
        # The only moment the plaintext exists to upgrade the cost parameters with.
        user.password_hash = passwords.hash_password(body.password)

    # A new login starts a new rotation family: revoking one stolen lineage should
    # not log the user out of their other devices.
    tokens = await _issue_session(session, response, request, user, uuid.uuid4())
    return AuthResponse(
        **tokens.model_dump(),
        user=UserOut(
            id=user.id,
            email=user.email,
            display_name=user.display_name,
            avatar_url=user.avatar_url,
            default_workspace_id=await _default_workspace_id(session, user),
        ),
    )


@router.post("/refresh", response_model=TokenPair)
async def refresh(
    request: Request,
    response: Response,
    session: Session,
    meadow_refresh: Annotated[str | None, Cookie()] = None,
) -> TokenPair:
    """Rotate the refresh token. Reuse of a spent one revokes the whole family.

    The theft case this defends: an attacker steals a refresh token and redeems it.
    Now both they and the real user hold tokens in one lineage. Whoever presents the
    already-rotated token second proves a copy exists, and the entire family dies -
    the legitimate user is logged out, which is the correct outcome, because the
    alternative is an attacker with an indefinitely renewing session.
    """
    if meadow_refresh is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="no refresh token")

    row = (
        await session.execute(
            select(RefreshToken).where(
                RefreshToken.token_hash == hash_refresh_token(meadow_refresh)
            )
        )
    ).scalar_one_or_none()

    if row is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid refresh token"
        )

    now = datetime.now(UTC)

    if row.revoked_at is not None:
        await session.execute(
            update(RefreshToken)
            .where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None))
            .values(revoked_at=now)
        )
        await session.commit()
        response.delete_cookie(settings.refresh_cookie_name, path="/api/v1/auth")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token reuse detected"
        )

    if row.expires_at <= now:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="refresh token expired"
        )

    user = await session.get(User, row.user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="unknown user")

    # Mark spent rather than delete: reuse detection needs the evidence to survive.
    row.revoked_at = now
    return await _issue_session(session, response, request, user, row.family_id)


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    response: Response,
    session: Session,
    meadow_refresh: Annotated[str | None, Cookie()] = None,
) -> None:
    """Revoke the whole family, not just this token: logout means this device is done."""
    if meadow_refresh is not None:
        row = (
            await session.execute(
                select(RefreshToken).where(
                    RefreshToken.token_hash == hash_refresh_token(meadow_refresh)
                )
            )
        ).scalar_one_or_none()
        if row is not None:
            await session.execute(
                update(RefreshToken)
                .where(RefreshToken.family_id == row.family_id, RefreshToken.revoked_at.is_(None))
                .values(revoked_at=datetime.now(UTC))
            )
            await session.commit()
    response.delete_cookie(settings.refresh_cookie_name, path="/api/v1/auth")


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser, session: Session) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        default_workspace_id=await _default_workspace_id(session, user),
    )
