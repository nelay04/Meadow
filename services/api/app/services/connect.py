"""Connecting an assistant by signing in: OAuth 2.1 for the MCP endpoint.

Web assistants add a remote MCP server by URL and sign in with OAuth, with no field for a
pasted token. This module is the authorization server they sign in to. What it hands out
is an ordinary fine-grained access token (`app/services/api_tokens.py`), so everything
past the sign-in, from `resolve_access` to the websocket grant guard, is unchanged.

The flow, and where each piece of state lives:

- **Registration** (RFC 7591) is open and grants nothing. A client row is a name and the
  exact redirect addresses it may be sent back to.
- **An authorization request** is checked, then held in Redis for ten minutes while a
  person signs in and picks glades on `#/connect/<id>`. Single use.
- **Approving** turns the request into a code held in Redis for a minute, bound to the
  client, the redirect address and the PKCE challenge. The choice of glades travels with
  it, so a code nobody exchanges leaves no token behind.
- **The token endpoint** issues the access token (an hour) and a refresh token (thirty
  days, rotated on every use). A spent refresh token presented again revokes the
  connection, since one of the two holders is not who they say.
"""

import base64
import hashlib
import json
import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from enum import StrEnum
from typing import Any
from urllib.parse import urlsplit

from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import ApiToken, OAuthClient, OAuthRefreshToken
from app.services import api_tokens, client_metadata
from app.services.api_tokens import GrantSpec, TokenKind
from app.services.connect_urls import MAX_CLIENT_NAME

ACCESS_TTL = timedelta(hours=1)
REFRESH_TTL = timedelta(days=30)
REQUEST_TTL_SECONDS = 600
CODE_TTL_SECONDS = 60

AUTH_METHODS = ("none", "client_secret_post", "client_secret_basic")

_REQUEST_KEY = "connect:request:{}"
_CODE_KEY = "connect:code:{}"


def issuer() -> str:
    return settings.web_base_url.rstrip("/")


def resource() -> str:
    return f"{issuer()}/mcp"


def _hash(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


def pkce_matches(verifier: str, challenge: str) -> bool:
    if not 43 <= len(verifier) <= 128:
        return False
    digest = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    return secrets.compare_digest(digest.decode().rstrip("="), challenge)


# --- clients ---------------------------------------------------------------------


@dataclass(frozen=True)
class Registered:
    client: OAuthClient
    #: Returned once for a client that asked for a secret; None for a public client.
    secret: str | None


#: Redirect hosts that belong to one known assistant. A code only ever reaches the redirect
#: address, so a client whose every redirect is on one of these hosts is that assistant
#: whatever name it registered under. Gemini registers as "Google".
KNOWN_REDIRECT_HOSTS = {"oauth-redirect.googleusercontent.com": "Gemini"}


def known_assistant(redirect_uris: list[str]) -> str | None:
    """The assistant every redirect address belongs to, or None."""
    names = {KNOWN_REDIRECT_HOSTS.get(urlsplit(uri).hostname or "") for uri in redirect_uris}
    if len(names) != 1:
        return None
    return names.pop()


async def register(
    session: AsyncSession, *, name: str, redirect_uris: list[str], auth_method: str
) -> Registered:
    secret = None if auth_method == "none" else secrets.token_urlsafe(32)
    client = OAuthClient(
        id=f"mdwc_{secrets.token_urlsafe(18)}",
        name=known_assistant(redirect_uris) or name.strip()[:MAX_CLIENT_NAME] or "Assistant",
        redirect_uris=redirect_uris,
        secret_hash=None if secret is None else _hash(secret),
    )
    session.add(client)
    await session.commit()
    return Registered(client=client, secret=secret)


@dataclass(frozen=True)
class Client:
    """A client as a request sees it, however it was identified."""

    row: OAuthClient
    #: The domain proved by a metadata document's URL. None for a registered client,
    #: whose name is only what it said when it registered.
    verified_host: str | None = None


async def resolve_client(session: AsyncSession, redis: Redis, client_id: str) -> Client | None:
    """A registered client from its row, or a published one from its document.

    A URL is always answered from the document, never from the row stored for it when a
    token was issued: the row is a label for the profile page, and the document is what
    says where codes may go.
    """
    if client_id.startswith("https://"):
        metadata = await client_metadata.resolve(redis, client_id)
        if metadata is None:
            return None
        return Client(
            row=OAuthClient(
                id=metadata.client_id,
                name=metadata.name,
                redirect_uris=metadata.redirect_uris,
                secret_hash=None,
            ),
            verified_host=metadata.host,
        )
    if not client_id.startswith("mdwc_") or len(client_id) > 64:
        return None
    row = await session.get(OAuthClient, client_id)
    if row is None:
        return None
    known = known_assistant(row.redirect_uris)
    if known is None:
        return Client(row=row)
    # Clients registered before the host was recognised still carry their own name. A
    # detached copy, so the new name is never flushed over the stored row by accident.
    return Client(
        row=OAuthClient(
            id=row.id,
            name=known,
            redirect_uris=row.redirect_uris,
            secret_hash=row.secret_hash,
        ),
        verified_host=urlsplit(row.redirect_uris[0]).hostname,
    )


def client_secret_ok(client: OAuthClient, secret: str | None) -> bool:
    """A public client sends no secret; a confidential one must send the right one."""
    if client.secret_hash is None:
        return True
    return secret is not None and secrets.compare_digest(_hash(secret), client.secret_hash)


# --- authorization requests and codes ------------------------------------------------


@dataclass(frozen=True)
class PendingRequest:
    client_id: str
    redirect_uri: str
    code_challenge: str
    state: str | None


async def hold_request(redis: Redis, pending: PendingRequest) -> str:
    request_id = secrets.token_urlsafe(24)
    await redis.set(
        _REQUEST_KEY.format(request_id),
        json.dumps(pending.__dict__),
        ex=REQUEST_TTL_SECONDS,
    )
    return request_id


def _pending(raw: bytes | str | None) -> PendingRequest | None:
    if raw is None:
        return None
    data: dict[str, Any] = json.loads(raw)
    return PendingRequest(**data)


async def read_request(redis: Redis, request_id: str) -> PendingRequest | None:
    if len(request_id) > 64:
        return None
    return _pending(await redis.get(_REQUEST_KEY.format(request_id)))


async def take_request(redis: Redis, request_id: str) -> PendingRequest | None:
    """The request, removed as it is read, so two approvals cannot both land."""
    if len(request_id) > 64:
        return None
    return _pending(await redis.getdel(_REQUEST_KEY.format(request_id)))


@dataclass(frozen=True)
class Approval:
    user_id: uuid.UUID
    grants: list[GrantSpec]
    can_create: bool
    #: When the connection ends however often it renews, or None to renew while used.
    ends_at: datetime | None = None


async def issue_code(redis: Redis, pending: PendingRequest, approval: Approval) -> str:
    code = secrets.token_urlsafe(32)
    payload = {
        "client_id": pending.client_id,
        "redirect_uri": pending.redirect_uri,
        "code_challenge": pending.code_challenge,
        "user_id": str(approval.user_id),
        "grants": [
            {"board_id": str(g.board_id), "edit": g.edit, "delete": g.delete}
            for g in approval.grants
        ],
        "can_create": approval.can_create,
        "ends_at": None if approval.ends_at is None else approval.ends_at.isoformat(),
    }
    await redis.set(_CODE_KEY.format(_hash(code)), json.dumps(payload), ex=CODE_TTL_SECONDS)
    return code


@dataclass(frozen=True)
class RedeemedCode:
    client_id: str
    redirect_uri: str
    code_challenge: str
    approval: Approval


async def take_code(redis: Redis, code: str) -> RedeemedCode | None:
    """Single use whatever happens next: a wrong verifier spends the code as well."""
    if not code or len(code) > 128:
        return None
    raw = await redis.getdel(_CODE_KEY.format(_hash(code)))
    if raw is None:
        return None
    data: dict[str, Any] = json.loads(raw)
    return RedeemedCode(
        client_id=data["client_id"],
        redirect_uri=data["redirect_uri"],
        code_challenge=data["code_challenge"],
        approval=Approval(
            user_id=uuid.UUID(data["user_id"]),
            grants=[
                GrantSpec(board_id=uuid.UUID(g["board_id"]), edit=g["edit"], delete=g["delete"])
                for g in data["grants"]
            ],
            can_create=data["can_create"],
            # `get`, so a code minted by the release before this one still redeems.
            ends_at=(
                None if data.get("ends_at") is None else datetime.fromisoformat(data["ends_at"])
            ),
        ),
    )


# --- tokens ------------------------------------------------------------------------


@dataclass(frozen=True)
class IssuedPair:
    access_token: str
    refresh_token: str


def _capped(when: datetime, token: ApiToken) -> datetime:
    """A renewal's expiry, never past the end the person chose for the connection."""
    return when if token.ends_at is None else min(when, token.ends_at)


def _new_refresh(token: ApiToken, client_id: str, now: datetime) -> tuple[OAuthRefreshToken, str]:
    raw = secrets.token_urlsafe(32)
    row = OAuthRefreshToken(
        id=uuid.uuid4(),
        api_token_id=token.id,
        client_id=client_id,
        token_hash=_hash(raw),
        expires_at=_capped(now + REFRESH_TTL, token),
    )
    return row, raw


async def connect(session: AsyncSession, client: OAuthClient, approval: Approval) -> IssuedPair:
    if client.id.startswith("https://"):
        # The foreign key needs a row, and the profile page reads the name from it.
        await session.merge(
            OAuthClient(
                id=client.id,
                name=client.name,
                redirect_uris=client.redirect_uris,
                secret_hash=None,
            )
        )
        await session.flush()
    issued = await api_tokens.issue(
        session,
        user_id=approval.user_id,
        name=client.name,
        kind=TokenKind.fine_grained,
        grants=approval.grants,
        can_create=approval.can_create,
        expires_in_days=REFRESH_TTL.days,
    )
    now = datetime.now(UTC)
    token = issued.row
    token.oauth_client_id = client.id
    token.ends_at = approval.ends_at
    token.expires_at = _capped(now + REFRESH_TTL, token)
    token.access_expires_at = _capped(now + ACCESS_TTL, token)
    refresh, raw_refresh = _new_refresh(token, client.id, now)
    session.add(refresh)
    await session.commit()
    return IssuedPair(access_token=issued.raw, refresh_token=raw_refresh)


class RefreshOutcome(StrEnum):
    ok = "ok"
    refused = "refused"
    #: A spent token came back. The connection was revoked; its sockets should close.
    reused = "reused"


@dataclass(frozen=True)
class Refreshed:
    outcome: RefreshOutcome
    pair: IssuedPair | None = None
    token_id: uuid.UUID | None = None


async def refresh(session: AsyncSession, *, client_id: str, raw: str) -> Refreshed:
    if not raw or len(raw) > 128:
        return Refreshed(RefreshOutcome.refused)
    row = (
        await session.execute(
            select(OAuthRefreshToken)
            .where(OAuthRefreshToken.token_hash == _hash(raw))
            .with_for_update()
        )
    ).scalar_one_or_none()
    if row is None or row.client_id != client_id:
        return Refreshed(RefreshOutcome.refused)

    token = await session.get(ApiToken, row.api_token_id)
    now = datetime.now(UTC)
    if row.spent_at is not None:
        if token is not None and token.revoked_at is None:
            token.revoked_at = now
        await session.commit()
        return Refreshed(RefreshOutcome.reused, token_id=row.api_token_id)
    if token is None or row.expires_at <= now or not api_tokens.is_live(token, now):
        await session.rollback()
        return Refreshed(RefreshOutcome.refused)

    row.spent_at = now
    access = api_tokens.rotate_secret(token)
    token.expires_at = _capped(now + REFRESH_TTL, token)
    token.access_expires_at = _capped(now + ACCESS_TTL, token)
    replacement, raw_refresh = _new_refresh(token, client_id, now)
    session.add(replacement)
    await session.commit()
    return Refreshed(
        RefreshOutcome.ok, IssuedPair(access_token=access, refresh_token=raw_refresh), token.id
    )


async def client_names(session: AsyncSession, client_ids: list[str]) -> dict[str, str]:
    if not client_ids:
        return {}
    rows = await session.execute(
        select(OAuthClient.id, OAuthClient.name).where(OAuthClient.id.in_(client_ids))
    )
    return {client_id: name for client_id, name in rows.tuples()}
