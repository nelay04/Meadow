"""Third-party sign-in: start the flow, and handle the callback.

One pair of routes, built once per provider from `app.services.oauth.PROVIDERS`. The
providers differ in which URLs they call and what their payloads look like, and that is
all inside the provider module; the security-carrying parts - state, the order of the
checks, what a failure may say - are identical, and identical here means one copy.

Both endpoints answer with a redirect, never JSON, because the browser is navigating
through them rather than fetching them. That shapes the error handling: a failure ends
at the login screen with a code in the query string, since there is no caller to read a
status code and nothing useful to show a person in a raw error body.

The session comes back the same way a password login's does - an httpOnly refresh
cookie and nothing in the URL. Tokens in a redirect URL end up in browser history, the
referrer, and any proxy log on the way, and the whole point of ARCHITECTURE 7's cookie
is that the credential is not readable by page scripts.
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
from app.services.oauth import PROVIDERS, EmailUnverified, OAuthClient, OAuthError
from app.services.oauth import state as oauth_state
from app.services.ratelimit import check as rate_limit_check

logger = getLogger(__name__)

# Where an interrupted flow lands. Hash routes, because that is the app's router.
DEFAULT_NEXT = "#/"
LOGIN_NEXT = "#/"


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


def make_router(client: OAuthClient) -> APIRouter:
    """The two routes for one provider.

    A factory rather than one router with a `{provider}` path parameter: the provider
    is then resolved at import time from a fixed registry, so no request can name one,
    and an unconfigured provider is a 404 from the routing table rather than a branch
    inside a handler.
    """
    provider = client.PROVIDER
    router = APIRouter(prefix=f"/auth/{provider}", tags=["auth"])
    state_cookie_path = oauth_state.cookie_path(provider)

    def require_enabled() -> None:
        if not client.enabled():
            # 404 rather than 503: with no client id configured this provider does not
            # exist as far as this deployment is concerned, and /auth/providers already
            # told the client so.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail=f"{provider} sign-in is off"
            )

    async def enforce_rate_limit(request: Request, action: str) -> None:
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

    def failure(reason: str) -> RedirectResponse:
        """Back to the login screen with a machine-readable reason and nothing else.

        The reasons are coarse on purpose. "This account has no verified email" is
        worth saying; which internal step failed is not, and neither is anything that
        would report whether a given email already has an account here. The provider
        rides along so the message can name it, which is safe: the browser just came
        back from it.
        """
        response = RedirectResponse(
            _web_url(LOGIN_NEXT, query=f"auth_error={quote(reason)}&provider={provider}"),
            status_code=status.HTTP_303_SEE_OTHER,
        )
        response.delete_cookie(oauth_state.COOKIE_NAME, path=state_cookie_path)
        return response

    @router.get("/start")
    async def start(
        request: Request,
        next: Annotated[str | None, Query(max_length=200)] = None,
    ) -> RedirectResponse:
        """Send the browser to the provider, carrying a state only this browser holds."""
        require_enabled()
        await enforce_rate_limit(request, f"oauth_start_{provider}")

        value = await oauth_state.issue(
            request.app.state.redis,
            provider=provider,
            next_path=_safe_next(next),
            ttl_seconds=settings.oauth_state_ttl_seconds,
        )

        response = RedirectResponse(
            client.authorize_url(value), status_code=status.HTTP_302_FOUND
        )
        response.set_cookie(
            oauth_state.COOKIE_NAME,
            value,
            max_age=settings.oauth_state_ttl_seconds,
            httponly=True,
            secure=settings.refresh_cookie_secure,
            # Lax, not Strict: the callback arrives as a top-level navigation from the
            # provider, and Strict would withhold the cookie on exactly that request.
            samesite="lax",
            path=state_cookie_path,
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
        """Turn the provider's authorization code into a Meadow session.

        Order matters, and it is the same reasoning as the websocket handshake: every
        check that can reject happens before anything is written. The state pair is
        verified before the code is spent, and the code is spent before any row is
        touched.
        """
        require_enabled()
        await enforce_rate_limit(request, f"oauth_callback_{provider}")

        if error != "":
            # The user pressed Cancel on the consent screen. Not a failure worth a
            # scary message, but the flow is over.
            logger.info("%s sign-in refused upstream: %s", provider, error)
            return failure("denied")

        # Both halves, and `compare_digest` rather than `==`: this is a secret
        # comparison, and the timing of a mismatch should not describe the value.
        if (
            meadow_oauth_state is None
            or state == ""
            or not secrets.compare_digest(meadow_oauth_state, state)
        ):
            return failure("state")

        next_path = await oauth_state.consume(request.app.state.redis, state, provider=provider)
        if next_path is None:
            return failure("state")

        if code == "":
            return failure("provider")

        try:
            profile = await client.fetch_profile(code)
        except EmailUnverified:
            return failure("unverified_email")
        except OAuthError as exc:
            logger.warning("%s sign-in failed: %s", provider, exc)
            return failure("provider")

        try:
            user, created = await accounts.link_oauth_profile(session, profile)
        except accounts.IdentityConflict as exc:
            logger.warning("%s sign-in conflict for %s: %s", provider, profile.username, exc)
            return failure("conflict")

        response = RedirectResponse(
            _web_url(next_path, query=f"auth={provider}"), status_code=status.HTTP_303_SEE_OTHER
        )
        # A fresh rotation family per sign-in, exactly as a password login does:
        # revoking one stolen lineage must not log the user out of their other devices.
        await issue_session(session, response, request, user, uuid.uuid4())
        response.delete_cookie(oauth_state.COOKIE_NAME, path=state_cookie_path)
        logger.info(
            "%s sign-in for user %s (%s account)",
            provider,
            user.id,
            "new" if created else "existing",
        )
        return response

    return router


routers = [make_router(client) for client in PROVIDERS.values()]
