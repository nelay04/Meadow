"""Registration, login, refresh rotation, logout, profile. ARCHITECTURE 6 and 7.

Third-party sign-in lives next door in `oauth.py`; the two share `app/auth/session.py`
for issuing a session and `app/services/accounts.py` for everything about an account,
so neither flow has its own copy of either.
"""

import uuid
from datetime import UTC, datetime
from logging import getLogger
from typing import Annotated

from fastapi import APIRouter, Cookie, HTTPException, Query, Request, Response, status
from fastapi.responses import RedirectResponse
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
    PasswordReset,
    PasswordResetRequest,
    ProfileUpdate,
    ProvidersOut,
    RegisterRequest,
    RegistrationPending,
    ResendActivation,
    TokenPair,
    UserOut,
)
from app.services import accounts, activation
from app.services.mail import MailError
from app.services.oauth import PROVIDERS
from app.services.ratelimit import check as rate_limit_check

logger = getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])

# Three refusals, and they say which is which.
#
# This is a deliberate reversal of the earlier design, which answered every failure
# identically so that registration and login could not be used to enumerate accounts.
# What that cost was the two cases a real person actually hits: an address that has
# never registered, and one that registered through a different door. Both were told
# only "no", which reads as the app being broken rather than as an instruction. The
# trade is real - anyone can now probe whether an address has an account here - and the
# rate limits (5/min on login, 3/hour on register, per IP) are what is left holding it
# down. Nothing here reveals anything beyond existence: no name, no provider, no hash.
_UNREGISTERED = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED, detail="email is not registered"
)
_NO_PASSWORD = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED, detail="account has no password"
)
_WRONG_PASSWORD = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED, detail="invalid email or password"
)
# 403 rather than 401: the credentials were right. What is missing is not proof of who
# they are but proof that the address is theirs.
_NOT_ACTIVATED = HTTPException(
    status_code=status.HTTP_403_FORBIDDEN, detail="account is not activated"
)


def _web_url(query: str) -> str:
    """`https://host/?query#/`. Same shape the OAuth callback redirects to.

    The query has to precede the fragment, and the fragment is the app's route: anything
    after `#` never leaves the browser, so a marker put there would be indistinguishable
    from the route itself.
    """
    return f"{settings.web_base_url.rstrip('/')}/?{query}#/"


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


@router.post(
    "/register", response_model=RegistrationPending, status_code=status.HTTP_202_ACCEPTED
)
async def register(
    body: RegisterRequest, request: Request, session: Session
) -> RegistrationPending:
    """Open an account and mail it a link. Deliberately does not sign anybody in.

    202, not 201: the account row exists, but the registration is not finished until the
    address answers. Handing back a session here would mean handing back a session for an
    account that every other endpoint refuses.
    """
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
        # Named, not generic: the person in front of this form has an account and needs
        # to be told to log in instead. See the note on the refusals above for what that
        # costs and why it is accepted.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="email is already registered"
        ) from exc

    await accounts.create_personal_workspace(session, user)
    sent = await _start_activation(session, user)
    await session.commit()
    return RegistrationPending(
        email=user.email,
        activation_required=user.activated_at is None,
        activation_sent=sent,
    )


async def _start_activation(session: Session, user: User) -> bool:
    """Mail the link, or open the account when this deployment cannot send mail.

    A relay that refuses is not allowed to lose the registration: the account stays,
    unactivated, and the client is told no mail went out so it can offer to try again.
    Silently discarding the row would be worse, because the address would then be free
    for someone else to claim.
    """
    if not settings.mail_enabled:
        await activation.activate_without_mail(session, user)
        return False
    try:
        await activation.send(session, user)
    except MailError:
        return False
    return True


@router.post("/login", response_model=AuthResponse)
async def login(
    body: LoginRequest, request: Request, response: Response, session: Session
) -> AuthResponse:
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "login", identity, settings.rate_limit_login)

    user = (
        await session.execute(select(User).where(User.email == str(body.email)))
    ).scalar_one_or_none()

    if user is None:
        raise _UNREGISTERED
    # No password hash means the account signs in through a linked provider, and no
    # password opens it. Worth saying, because otherwise the only way to find out is to
    # keep guessing a password that does not exist.
    if user.password_hash is None:
        raise _NO_PASSWORD
    if not passwords.verify_password(user.password_hash, body.password):
        raise _WRONG_PASSWORD
    # Checked after the password on purpose: "that account is not activated" would
    # otherwise be readable without knowing the password, which turns the message into
    # a report on somebody else's account.
    if user.activated_at is None:
        raise _NOT_ACTIVATED

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


@router.get("/activate")
async def activate(
    request: Request, session: Session, token: Annotated[str, Query(max_length=256)] = ""
) -> RedirectResponse:
    """Spend an activation link and sign the account in.

    A redirect, not JSON: this URL is opened from a mail client, so the caller is a
    person looking at a browser. Signing them in here is what makes the link the end of
    registration rather than a step in the middle of it - the click proves control of
    the address, which is the same thing a password login proves about the password.
    """
    outcome, user = await activation.redeem(session, token)

    if outcome is activation.Outcome.activated and user is not None:
        response = RedirectResponse(
            _web_url("activated=1"), status_code=status.HTTP_303_SEE_OTHER
        )
        await issue_session(session, response, request, user, uuid.uuid4())
        return response

    await session.commit()
    if outcome is activation.Outcome.already_active:
        # Clicking the link twice, or clicking an old one after a newer mail. The
        # account is open; nothing here is a failure.
        return RedirectResponse(
            _web_url("activated=already"), status_code=status.HTTP_303_SEE_OTHER
        )
    return RedirectResponse(
        _web_url(f"activation_error={outcome.value}"), status_code=status.HTTP_303_SEE_OTHER
    )


@router.post("/activation/resend", status_code=status.HTTP_204_NO_CONTENT)
async def resend_activation(
    body: ResendActivation, request: Request, session: Session
) -> None:
    """Send another link, for a mail that never arrived or has expired.

    Always 204, and deliberately the one endpoint here that says nothing about whether
    the account exists. Not for enumeration - login and registration already answer that
    - but because this one sends mail to an address the caller chose, and a caller who
    can tell hits from misses can use it to find live addresses to post to.
    """
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "resend", identity, settings.rate_limit_register)

    user = (
        await session.execute(select(User).where(User.email == str(body.email)))
    ).scalar_one_or_none()
    if user is None or user.activated_at is not None:
        return

    if not settings.mail_enabled:
        await activation.activate_without_mail(session, user)
        await session.commit()
        return

    try:
        await activation.send(session, user)
    except MailError:
        await session.rollback()
        return
    await session.commit()


@router.post("/password/reset-request", status_code=status.HTTP_204_NO_CONTENT)
async def request_password_reset(
    body: PasswordResetRequest, request: Request, session: Session
) -> None:
    """Post a reset link, for a forgotten password or a first one.

    Also the profile page's "set a password" button: an account opened through GitHub or
    Google has no password, and adding one is the same request as replacing one. The mail
    says which of the two it is.

    Always 204, like the activation resend and for the same reason: this endpoint sends
    mail to an address the caller chose, and a caller who can tell hits from misses can
    use it to find live addresses.
    """
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "password_reset", identity, settings.rate_limit_register)

    user = (
        await session.execute(select(User).where(User.email == str(body.email)))
    ).scalar_one_or_none()
    if user is None:
        return

    if user.activated_at is None:
        # An account that has never been opened does not need a password yet; what it
        # needs is the activation link, and it proves the same thing.
        await _start_activation(session, user)
        await session.commit()
        return

    if not settings.mail_enabled:
        # No relay, so no link can be delivered. Refusing silently is the honest
        # outcome: inventing a way to change a password without the mail would be a
        # second, weaker door into every account.
        logger.warning("password reset asked for but no smtp is configured")
        return

    try:
        await activation.send_password_reset(session, user)
    except MailError:
        await session.rollback()
        return
    await session.commit()


@router.post("/password/change-request", status_code=status.HTTP_204_NO_CONTENT)
async def request_password_change(request: Request, user: CurrentUser, session: Session) -> None:
    """The profile page's button: mail me a link to set or change my own password.

    Separate from the public reset endpoint precisely so it can tell the truth. That one
    answers 204 whatever happens, because it posts mail to an address a stranger typed;
    this one is the caller's own account, so "the relay refused" is not a fact worth
    hiding, and a screen that says "email sent" when nothing was sent is worse than an
    error.
    """
    identity = str(user.id)
    await _enforce_rate_limit(request, "password_change", identity, settings.rate_limit_register)

    if not settings.mail_enabled:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="mail is not configured"
        )

    try:
        await activation.send_password_reset(session, user)
    except MailError as exc:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="could not send the email"
        ) from exc
    await session.commit()


@router.get("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def check_reset_link(
    request: Request, session: Session, token: Annotated[str, Query(max_length=256)] = ""
) -> None:
    """Is this link still good? Asked by the reset page before it draws a form.

    Without it a spent link opens a working-looking form and only says so on submit,
    after someone has chosen a password and typed it twice. The token is not spent here:
    this only reads.

    Not an oracle worth worrying about - the token is 256 bits of randomness, so
    guessing one to learn it does not exist is not an attack - but it is rate limited
    with everything else on this router regardless.
    """
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "password_reset", identity, settings.rate_limit_register)

    outcome, _ = await activation.inspect_password_reset(session, token)
    if outcome is not activation.Outcome.activated:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "expired reset link"
                if outcome is activation.Outcome.expired
                else "invalid reset link"
            ),
        )


@router.post("/password/reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(body: PasswordReset, request: Request, session: Session) -> None:
    """Spend a reset link and set the password behind it.

    Every session on the account ends here, including the caller's. Two reasons, and the
    second is the one that matters: someone resetting a password they did not lose is
    doing it because they think somebody else has it, and leaving that somebody's
    refresh token alive would make the reset decorative.
    """
    identity = request.client.host if request.client else "unknown"
    await _enforce_rate_limit(request, "password_reset", identity, settings.rate_limit_register)

    outcome, user = await activation.redeem_password_reset(session, body.token)
    if outcome is not activation.Outcome.activated or user is None:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "expired reset link"
                if outcome is activation.Outcome.expired
                else "invalid reset link"
            ),
        )

    user.password_hash = passwords.hash_password(body.password)
    await session.execute(
        update(RefreshToken)
        .where(RefreshToken.user_id == user.id, RefreshToken.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    await session.commit()
    logger.info("password set for user %s", user.id)


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
