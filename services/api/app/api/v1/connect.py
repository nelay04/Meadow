"""Connecting an assistant by signing in. The OAuth routes; the rules are in the service.

Three of these are unauthenticated because OAuth needs them to be: registration, the
authorization request (which only checks and redirects to the web app), and the token
endpoint, which authenticates with a code or refresh token instead of a session. The
consent routes take `CurrentUser`, which refuses an access token by name, so a token can
never approve a connection and mint itself a sibling.

Errors follow RFC 6749: `{"error": ..., "error_description": ...}`, sent back to the
client's redirect address only once that address is known to be one it registered.
"""

import base64
import binascii
import uuid
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse, RedirectResponse

from app.api.v1.tokens import _checked_grants
from app.auth.deps import CurrentUser, Session
from app.config import settings
from app.realtime.rooms import WS_CLOSE_UNAUTHORIZED, SocketRegistry
from app.schemas.auth import ConnectApproval, ConnectRedirect, ConnectRequestOut
from app.services import api_tokens, connect
from app.services.connect_urls import MAX_REDIRECT_URIS, valid_redirect
from app.services.ratelimit import check as rate_limit_check

router = APIRouter(prefix="/connect", tags=["connect"])

_NO_STORE = {"Cache-Control": "no-store", "Pragma": "no-cache"}


def _error(code: str, description: str, status_code: int = 400) -> JSONResponse:
    headers = dict(_NO_STORE)
    if code == "invalid_client":
        headers["WWW-Authenticate"] = "Basic"
    return JSONResponse(
        {"error": code, "error_description": description},
        status_code=status_code,
        headers=headers,
    )


def _with_query(uri: str, params: dict[str, str | None]) -> str:
    query = urlencode({key: value for key, value in params.items() if value is not None})
    return f"{uri}{'&' if urlsplit(uri).query else '?'}{query}"


async def _limit(request: Request, action: str) -> bool:
    if not settings.rate_limit_enabled:
        return True
    identity = request.client.host if request.client else "unknown"
    return await rate_limit_check(
        request.app.state.redis, action=action, identity=identity, spec=settings.rate_limit_share
    )


# --- registration ------------------------------------------------------------------


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=None)
async def register_client(request: Request, session: Session) -> JSONResponse:
    if not await _limit(request, "connect-register"):
        return _error("slow_down", "too many registrations", status.HTTP_429_TOO_MANY_REQUESTS)
    try:
        body: Any = await request.json()
    except ValueError:
        return _error("invalid_client_metadata", "the body must be JSON")
    if not isinstance(body, dict):
        return _error("invalid_client_metadata", "the body must be a JSON object")

    uris = body.get("redirect_uris")
    if (
        not isinstance(uris, list)
        or not uris
        or len(uris) > MAX_REDIRECT_URIS
        or not all(isinstance(uri, str) for uri in uris)
    ):
        return _error("invalid_redirect_uri", "redirect_uris must list at least one address")
    if not all(valid_redirect(uri) for uri in uris):
        return _error(
            "invalid_redirect_uri", "redirect addresses must be https, or http on loopback"
        )

    method = body.get("token_endpoint_auth_method", "none")
    if method not in connect.AUTH_METHODS:
        return _error("invalid_client_metadata", "unsupported token_endpoint_auth_method")
    name = body.get("client_name")
    registered = await connect.register(
        session,
        name=name if isinstance(name, str) else "Assistant",
        redirect_uris=uris,
        auth_method=method,
    )

    out: dict[str, Any] = {
        "client_id": registered.client.id,
        "client_name": registered.client.name,
        "redirect_uris": registered.client.redirect_uris,
        "grant_types": ["authorization_code", "refresh_token"],
        "response_types": ["code"],
        "token_endpoint_auth_method": method,
        "client_id_issued_at": int(datetime.now(UTC).timestamp()),
    }
    if registered.secret is not None:
        out["client_secret"] = registered.secret
        out["client_secret_expires_at"] = 0
    return JSONResponse(out, status_code=status.HTTP_201_CREATED, headers=_NO_STORE)


# --- authorization request -----------------------------------------------------------


@router.get("/authorize", response_model=None)
async def authorize(request: Request, session: Session) -> JSONResponse | RedirectResponse:
    """Check the request, hold it, and send the browser to the consent screen."""
    params = request.query_params
    resolved = await connect.resolve_client(
        session, request.app.state.redis, params.get("client_id", "")
    )
    if resolved is None:
        return _error("invalid_client", "unknown client", status.HTTP_400_BAD_REQUEST)
    client = resolved.row
    redirect_uri = params.get("redirect_uri") or (
        client.redirect_uris[0] if len(client.redirect_uris) == 1 else ""
    )
    if redirect_uri not in client.redirect_uris:
        return _error("invalid_request", "redirect_uri is not registered for this client")

    state = params.get("state")

    def back(error: str, description: str) -> RedirectResponse:
        return RedirectResponse(
            _with_query(
                redirect_uri,
                {"error": error, "error_description": description, "state": state},
            ),
            status_code=status.HTTP_302_FOUND,
        )

    if params.get("response_type") != "code":
        return back("unsupported_response_type", "only the code flow is supported")
    challenge = params.get("code_challenge", "")
    if not challenge or params.get("code_challenge_method") != "S256" or len(challenge) > 128:
        return back("invalid_request", "PKCE with S256 is required")
    target = params.get("resource")
    if target is not None and not target.rstrip("/").startswith(connect.issuer()):
        return back("invalid_target", "this server issues tokens for its own MCP endpoint")

    request_id = await connect.hold_request(
        request.app.state.redis,
        connect.PendingRequest(
            client_id=client.id,
            redirect_uri=redirect_uri,
            code_challenge=challenge,
            state=state,
        ),
    )
    return RedirectResponse(
        f"{connect.issuer()}/#/connect/{request_id}", status_code=status.HTTP_302_FOUND
    )


# --- consent -----------------------------------------------------------------------


async def _pending_client(
    request: Request, session: Session, request_id: str
) -> tuple[connect.PendingRequest, connect.Client]:
    redis = request.app.state.redis
    pending = await connect.read_request(redis, request_id)
    client = (
        None if pending is None else await connect.resolve_client(session, redis, pending.client_id)
    )
    if pending is None or client is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such request")
    return pending, client


@router.get("/requests/{request_id}", response_model=ConnectRequestOut)
async def read_request(
    request_id: str, request: Request, user: CurrentUser, session: Session
) -> ConnectRequestOut:
    pending, client = await _pending_client(request, session, request_id)
    return ConnectRequestOut(
        client_name=client.row.name,
        client_host=client.verified_host,
        redirect_host=urlsplit(pending.redirect_uri).hostname or "",
    )


@router.post("/requests/{request_id}/approve", response_model=ConnectRedirect)
async def approve_request(
    request_id: str,
    body: ConnectApproval,
    request: Request,
    user: CurrentUser,
    session: Session,
) -> ConnectRedirect:
    await _pending_client(request, session, request_id)
    if len(await api_tokens.list_live(session, user.id)) >= api_tokens.MAX_LIVE_TOKENS:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"at most {api_tokens.MAX_LIVE_TOKENS} tokens; revoke one first",
        )
    grants = await _checked_grants(session, user.id, body.grants)

    pending = await connect.take_request(request.app.state.redis, request_id)
    if pending is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such request")
    code = await connect.issue_code(
        request.app.state.redis,
        pending,
        connect.Approval(user_id=user.id, grants=grants, can_create=body.can_create),
    )
    return ConnectRedirect(
        redirect_url=_with_query(pending.redirect_uri, {"code": code, "state": pending.state})
    )


@router.post("/requests/{request_id}/deny", response_model=ConnectRedirect)
async def deny_request(request_id: str, request: Request, user: CurrentUser) -> ConnectRedirect:
    pending = await connect.take_request(request.app.state.redis, request_id)
    if pending is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="no such request")
    return ConnectRedirect(
        redirect_url=_with_query(
            pending.redirect_uri,
            {
                "error": "access_denied",
                "error_description": "the request was declined",
                "state": pending.state,
            },
        )
    )


# --- token endpoint ----------------------------------------------------------------


def _basic_credentials(request: Request) -> tuple[str, str] | None:
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip(), validate=True).decode()
    except (binascii.Error, UnicodeDecodeError):
        return None
    client_id, sep, secret = decoded.partition(":")
    return (client_id, secret) if sep else None


def _tokens(pair: connect.IssuedPair) -> JSONResponse:
    return JSONResponse(
        {
            "access_token": pair.access_token,
            "token_type": "Bearer",
            "expires_in": int(connect.ACCESS_TTL.total_seconds()),
            "refresh_token": pair.refresh_token,
        },
        headers=_NO_STORE,
    )


@router.post("/token", response_model=None)
async def token(request: Request, session: Session) -> JSONResponse:
    if not await _limit(request, "connect-token"):
        return _error("slow_down", "too many requests", status.HTTP_429_TOO_MANY_REQUESTS)
    raw_body = await request.body()
    if len(raw_body) > 8192:
        return _error("invalid_request", "request too large")
    form = {key: values[0] for key, values in parse_qs(raw_body.decode(errors="replace")).items()}

    basic = _basic_credentials(request)
    client_id = basic[0] if basic is not None else form.get("client_id", "")
    secret = basic[1] if basic is not None else form.get("client_secret")
    resolved = await connect.resolve_client(session, request.app.state.redis, client_id)
    client = None if resolved is None else resolved.row
    if client is None or not connect.client_secret_ok(client, secret):
        return _error("invalid_client", "client authentication failed", 401)

    grant_type = form.get("grant_type")
    if grant_type == "authorization_code":
        redeemed = await connect.take_code(request.app.state.redis, form.get("code", ""))
        if (
            redeemed is None
            or redeemed.client_id != client.id
            or redeemed.redirect_uri != form.get("redirect_uri", redeemed.redirect_uri)
            or not connect.pkce_matches(form.get("code_verifier", ""), redeemed.code_challenge)
        ):
            return _error("invalid_grant", "the code is invalid, spent or does not match")
        if (
            len(await api_tokens.list_live(session, redeemed.approval.user_id))
            >= api_tokens.MAX_LIVE_TOKENS
        ):
            return _error("invalid_grant", "the account has too many live tokens")
        return _tokens(await connect.connect(session, client, redeemed.approval))

    if grant_type == "refresh_token":
        refreshed = await connect.refresh(
            session, client_id=client.id, raw=form.get("refresh_token", "")
        )
        if refreshed.outcome is connect.RefreshOutcome.reused and refreshed.token_id is not None:
            await _evict(request, refreshed.token_id)
        if refreshed.pair is None:
            return _error("invalid_grant", "the refresh token is invalid, spent or expired")
        return _tokens(refreshed.pair)

    return _error("unsupported_grant_type", "use authorization_code or refresh_token")


async def _evict(request: Request, token_id: uuid.UUID) -> None:
    sockets: SocketRegistry | None = getattr(request.app.state, "sockets", None)
    if sockets is not None:
        await sockets.evict_token(
            str(token_id), code=WS_CLOSE_UNAUTHORIZED, reason="access token revoked"
        )


# --- discovery, served at the site root ------------------------------------------------

well_known = APIRouter(prefix="/.well-known", tags=["connect"])


@well_known.get("/oauth-authorization-server")
async def authorization_server() -> dict[str, Any]:
    base = connect.issuer()
    return {
        "issuer": base,
        "authorization_endpoint": f"{base}/api/v1/connect/authorize",
        "token_endpoint": f"{base}/api/v1/connect/token",
        "registration_endpoint": f"{base}/api/v1/connect/register",
        "response_types_supported": ["code"],
        "grant_types_supported": ["authorization_code", "refresh_token"],
        "code_challenge_methods_supported": ["S256"],
        "token_endpoint_auth_methods_supported": list(connect.AUTH_METHODS),
        "client_id_metadata_document_supported": True,
        "service_documentation": f"{base}/source/",
    }


@well_known.get("/oauth-protected-resource")
@well_known.get("/oauth-protected-resource/mcp")
async def protected_resource() -> dict[str, Any]:
    return {
        "resource": connect.resource(),
        "authorization_servers": [connect.issuer()],
        "bearer_methods_supported": ["header"],
        "resource_name": "Meadow",
    }
