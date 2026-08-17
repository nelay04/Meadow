"""Registration, login, refresh rotation, logout, profile. ARCHITECTURE 6 and 7.

Third-party sign-in lives next door in `oauth.py`; the two share `app/auth/session.py`
for issuing a session and `app/services/accounts.py` for everything about an account,
so neither flow has its own copy of either.
"""

import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Request, Response, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError

from app.auth import password as passwords
from app.auth.deps import CurrentUser, Session
from app.auth.session import clear_refresh_cookie, issue_session
from app.auth.tokens import hash_refresh_token
from app.config import settings
from app.models import RefreshToken, User
from app.schemas.auth import (
    AuthResponse,
    LoginRequest,
    ProfileUpdate,
    ProvidersOut,
    RegisterRequest,
    TokenPair,
    UserOut,
)
from app.services import accounts
from app.services.oauth import PROVIDERS
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


@router.get("/providers", response_model=ProvidersOut)
async def providers() -> ProvidersOut:
    """Which third-party sign-ins this deployment can actually complete.

    Read from the same registry the routes are built from, so a button can never be
    offered for a provider whose endpoints are a 404.
    """
    return ProvidersOut.model_validate(
        {name: client.enabled() for name, client in PROVIDERS.items()}
    )


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
        # them turns registration into an account-enumeration oracle, and it would
        # also report which emails have signed in with GitHub.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="could not create account"
        ) from exc

    workspace = await accounts.create_personal_workspace(session, user)

    tokens = await issue_session(session, response, request, user, uuid.uuid4())
    return AuthResponse(
        **tokens.model_dump(),
        user=await accounts.build_user_out(session, user, workspace_id=workspace.id),
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

    # An account created through a provider has no password hash, and there is no
    # password that opens it. Same refusal as a wrong one: telling the caller "this
    # account uses GitHub" would answer a question they have not proved they may ask.
    if (
        user is None
        or user.password_hash is None
        or not passwords.verify_password(user.password_hash, body.password)
    ):
        raise _INVALID_CREDENTIALS

    if passwords.needs_rehash(user.password_hash):
        # The only moment the plaintext exists to upgrade the cost parameters with.
        user.password_hash = passwords.hash_password(body.password)

    # A new login starts a new rotation family: revoking one stolen lineage should
    # not log the user out of their other devices.
    tokens = await issue_session(session, response, request, user, uuid.uuid4())
    return AuthResponse(
        **tokens.model_dump(),
        user=await accounts.build_user_out(session, user),
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
        clear_refresh_cookie(response)
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
    return await issue_session(session, response, request, user, row.family_id)


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
    clear_refresh_cookie(response)


@router.get("/me", response_model=UserOut)
async def me(user: CurrentUser, session: Session) -> UserOut:
    return await accounts.build_user_out(session, user)


@router.patch("/me", response_model=UserOut)
async def update_me(body: ProfileUpdate, user: CurrentUser, session: Session) -> UserOut:
    """Edit the parts of the profile that belong to the user.

    Exactly two fields, and neither of them is a provider's. `display_name` is seeded
    from the provider at first sign-in and is the user's own from that moment;
    `avatar_source` chooses between initials and the picture on any linked account. The
    identity rows themselves are never written here - they are what the providers say,
    and they stay that way.
    """
    if body.display_name is not None:
        name = body.display_name.strip()
        if name == "":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="display name is empty"
            )
        user.display_name = name

    if body.avatar_source is not None:
        if body.avatar_source == "none":
            user.avatar_source = "none"
            user.avatar_url = None
        else:
            # Naming a provider is only meaningful if the caller has linked it and it
            # has a picture. Refused rather than silently downgraded to initials, so a
            # client that asks for something impossible hears about it.
            identity = await accounts.identity_for(session, user.id, body.avatar_source)
            if identity is None or identity.avatar_url is None:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail=f"no linked {body.avatar_source} avatar",
                )
            user.avatar_source = body.avatar_source
            user.avatar_url = identity.avatar_url

    await session.commit()
    return await accounts.build_user_out(session, user)
