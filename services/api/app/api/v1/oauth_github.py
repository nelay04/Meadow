"""GitHub sign-in: start the flow, and handle the callback.

Both endpoints answer with a redirect, never JSON, because the browser is navigating
through them rather than fetching them. That shapes the error handling: a failure ends
at the login screen with a code in the query string, since there is no caller to read
a status code and nothing useful to show a person in a raw error body.

The session comes back the same way a password login's does - an httpOnly refresh
cookie and nothing in the URL. Tokens in a redirect URL end up in browser history,
the referrer, and any proxy log on the way, and the whole point of ARCHITECTURE 7's
cookie is that the credential is not readable by page scripts.
"""

import secrets
import uuid
from logging import getLogger
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Cookie, HTTPException, Query, Request, status
from fastapi.responses import RedirectResponse

from app.auth.deps import Session
from app.auth.session import issue_session
from app.config import settings
from app.services import accounts
from app.services.oauth import github
from app.services.oauth import state as oauth_state
from app.services.ratelimit import check as rate_limit_check

logger = getLogger(__name__)

router = APIRouter(prefix="/auth/github", tags=["auth"])

# Where an interrupted flow lands. Hash routes, because that is the app's router.
DEFAULT_NEXT = "#/"
LOGIN_NEXT = "#/"


def _require_enabled() -> None:
    if not settings.github_oauth_enabled:
        # 404 rather than 503: with no client id configured this provider does not
        # exist as far as this deployment is concerned, and /auth/providers already
        # told the client so.
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="github sign-in is off")


async def _enforce_rate_limit(request: Request, action: str) -> None:
    if not settings.rate_limit_enabled:
        return
    identity = request.client.host if request.client else "unknown"
    allowed = await rate_limit_check(
        request.app.state.redis,
        action=action,
        identity=identity,
        spec=settings.rate_limit_oauth,
    )
    if not allowed:
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail="too many requests"
        )


def _safe_next(raw: str | None) -> str:
    """Reduce a caller-supplied destination to a hash route on our own origin.

    An OAuth callback that redirects wherever the query string says is the textbook
    open redirect, and it is worth more here than usual because the URL a user is sent
    to arrives with a freshly minted session. Only `#/...` is allowed through, so the
    result can never name a host: `//evil.example` and `https://evil.example` both
    fail the first check.
    """
    if raw is None or not raw.startswith("#/") or raw.startswith("#//"):
        return DEFAULT_NEXT
    if any(char in raw for char in ("\r", "\n", "\\", " ")):
        return DEFAULT_NEXT
    return raw[:200]


def _web_url(next_path: str, *, query: str) -> str:
    """`https://host/?query#/route`. The query has to precede the fragment.

    The fragment is the app's route and everything after `#` stays in the browser, so
    a marker appended there would be indistinguishable from the route itself.
    """
    base = settings.web_base_url.rstrip("/")
    return f"{base}/?{query}{next_path}"


def _failure(reason: str) -> RedirectResponse:
    """Back to the login screen with a machine-readable reason and nothing else.

    The reasons are coarse on purpose. "This GitHub account has no verified email" is
    worth saying; which internal step failed is not, and neither is anything that
    would report whether a given email already has an account here.
    """
    response = RedirectResponse(
        _web_url(LOGIN_NEXT, query=f"auth_error={quote(reason)}"),
        status_code=status.HTTP_303_SEE_OTHER,
    )
    response.delete_cookie(oauth_state.COOKIE_NAME, path=oauth_state.COOKIE_PATH)
    return response


@router.get("/start")
async def start(
    request: Request,
    next: Annotated[str | None, Query(max_length=200)] = None,
) -> RedirectResponse:
    """Send the browser to GitHub, carrying a state value only this browser holds."""
    _require_enabled()
    await _enforce_rate_limit(request, "oauth_start")

    value = await oauth_state.issue(
        request.app.state.redis,
        provider=github.PROVIDER,
        next_path=_safe_next(next),
        ttl_seconds=settings.oauth_state_ttl_seconds,
    )

    response = RedirectResponse(
        github.authorize_url(value), status_code=status.HTTP_302_FOUND
    )
    response.set_cookie(
        oauth_state.COOKIE_NAME,
        value,
        max_age=settings.oauth_state_ttl_seconds,
        httponly=True,
        secure=settings.refresh_cookie_secure,
        # Lax, not Strict: the callback arrives as a top-level navigation from
        # github.com, and Strict would withhold the cookie on exactly that request.
        samesite="lax",
        path=oauth_state.COOKIE_PATH,
    )
    return response


@router.get("/callback")
async def callback(
    request: Request,
    session: Session,
    code: Annotated[str, Query(max_length=512)] = "",
    state: Annotated[str, Query(max_length=512)] = "",
    error: Annotated[str, Query(max_length=128)] = "",
    meadow_oauth_state: Annotated[str | None, Cookie()] = None,
) -> RedirectResponse:
    """Turn GitHub's authorization code into a Meadow session.

    Order matters, and it is the same reasoning as the websocket handshake: every
    check that can reject happens before anything is written. The state pair is
    verified before the code is spent, and the code is spent before any row is
    touched.
    """
    _require_enabled()
    await _enforce_rate_limit(request, "oauth_callback")

    if error != "":
        # The user pressed Cancel on GitHub's consent screen. Not a failure worth a
        # scary message, but the flow is over.
        logger.info("github sign-in refused upstream: %s", error)
        return _failure("denied")

    # Both halves, and `compare_digest` rather than `==`: this is a secret comparison,
    # and the timing of a mismatch should not describe the value.
    if (
        meadow_oauth_state is None
        or state == ""
        or not secrets.compare_digest(meadow_oauth_state, state)
    ):
        return _failure("state")

    next_path = await oauth_state.consume(
        request.app.state.redis, state, provider=github.PROVIDER
    )
    if next_path is None:
        return _failure("state")

    if code == "":
        return _failure("provider")

    try:
        profile = await github.fetch_profile(code)
    except github.EmailUnverified:
        return _failure("unverified_email")
    except github.GitHubOAuthError as exc:
        logger.warning("github sign-in failed: %s", exc)
        return _failure("provider")

    try:
        user, created = await accounts.link_github_profile(session, profile)
    except accounts.IdentityConflict as exc:
        logger.warning("github sign-in conflict for %s: %s", profile.username, exc)
        return _failure("conflict")

    response = RedirectResponse(
        _web_url(next_path, query="auth=github"), status_code=status.HTTP_303_SEE_OTHER
    )
    # A fresh rotation family per sign-in, exactly as a password login does: revoking
    # one stolen lineage must not log the user out of their other devices.
    await issue_session(session, response, request, user, uuid.uuid4())
    response.delete_cookie(oauth_state.COOKIE_NAME, path=oauth_state.COOKIE_PATH)
    logger.info(
        "github sign-in for user %s (%s account)", user.id, "new" if created else "existing"
    )
    return response
