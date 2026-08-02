"""Short-lived, single-use websocket tokens.

A browser cannot set an Authorization header on a WebSocket, so the credential has to
travel in the URL - where it lands in proxy logs and browser history. Hence 60s, one
board, one use.

The token carries identity and a session deadline, not a role. Roles are resolved
live at connect time through `app/services/permissions.py`; a role baked in at mint
time would be a 60s window in which a revoked user still has their old access.

`session_expires_at` is inherited from the access token that authorised the mint. It
is what stops a socket outliving its session: the handshake refuses a token whose
session has already lapsed, and the watchdog closes the connection when it does.
"""

import hashlib
import hmac
import time
import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

from app.config import settings

_REPLAY_KEY = "meadow:wstoken:used:{jti}"


class TokenError(Exception):
    """Base for token rejection."""


class TokenInvalid(TokenError):
    """Forged, malformed, or unparseable. Maps to ws close 4401."""


class TokenExpired(TokenError):
    """Past its 60s TTL, or the session behind it has ended. Maps to 4401."""


class TokenReplayed(TokenError):
    """Already consumed. Maps to 4401."""


class TokenScopeMismatch(TokenError):
    """Authentic, but minted for a different board. Maps to ws close 4403.

    Not 4401. The credential is genuine and unexpired, it simply does not authorise
    this board - that is authorisation, not authentication. Reporting it as 4401 would
    tell a client holding a perfectly good token to go and refresh it, which cannot
    help, and it would hide a real access violation among ordinary expiry noise.

    Note this is raised before the token is consumed, so presenting A's token to board
    B does not burn it: the legitimate holder is not denied by someone else's misuse.
    """


@dataclass(frozen=True)
class WsTokenClaims:
    board_id: str
    user_id: uuid.UUID
    expires_at: int
    session_expires_at: int
    jti: str


def _sign(payload: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def mint(board_id: str, user_id: uuid.UUID, session_expires_at: int) -> str:
    expires_at = int(time.time()) + settings.ws_token_ttl_seconds
    jti = uuid.uuid4().hex
    payload = f"{board_id}.{user_id}.{expires_at}.{session_expires_at}.{jti}"
    return f"{payload}.{_sign(payload)}"


async def verify(token: str, board_id: str, redis: Redis) -> WsTokenClaims:
    """Validate and consume a token. Raises TokenError on any rejection."""
    parts = token.split(".")
    if len(parts) != 6:
        raise TokenInvalid("malformed token")

    claimed_board, raw_user, raw_expires, raw_session_expires, jti, signature = parts

    payload = f"{claimed_board}.{raw_user}.{raw_expires}.{raw_session_expires}.{jti}"
    if not hmac.compare_digest(_sign(payload), signature):
        raise TokenInvalid("bad signature")

    try:
        user_id = uuid.UUID(raw_user)
        expires_at = int(raw_expires)
        session_expires_at = int(raw_session_expires)
    except ValueError as exc:
        raise TokenInvalid("bad claims") from exc

    now = int(time.time())
    if expires_at < now:
        raise TokenExpired("token expired")
    if session_expires_at <= now:
        raise TokenExpired("session expired")

    # Scope check before consumption - see TokenScopeMismatch.
    if claimed_board != board_id:
        raise TokenScopeMismatch("token scoped to a different board")

    # Consume. SET NX is atomic, so two connections racing the same token means
    # exactly one wins. TTL matches the token so keys expire on their own.
    claimed = await redis.set(
        _REPLAY_KEY.format(jti=jti), "1", nx=True, ex=settings.ws_token_ttl_seconds + 5
    )
    if not claimed:
        raise TokenReplayed("token already used")

    return WsTokenClaims(
        board_id=claimed_board,
        user_id=user_id,
        expires_at=expires_at,
        session_expires_at=session_expires_at,
        jti=jti,
    )
