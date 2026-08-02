"""Short-lived, single-use websocket tokens.

M0 stub: HMAC rather than the real JWT, and no user identity yet. What it does prove
is the shape the handshake depends on, which is the part that is expensive to get
wrong later: scoped to one board, 60s TTL, and consumed on first use so a captured
token cannot be replayed.

M1 replaces the signing with the auth service key and adds `sub` plus the resolved
board role.
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
    """Base for token rejection. Maps to ws close 4401."""


class TokenInvalid(TokenError):
    pass


class TokenExpired(TokenError):
    pass


class TokenReplayed(TokenError):
    pass


@dataclass(frozen=True)
class WsTokenClaims:
    board_id: str
    expires_at: int
    jti: str


def _sign(payload: str) -> str:
    return hmac.new(
        settings.ws_token_secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


def mint(board_id: str) -> str:
    expires_at = int(time.time()) + settings.ws_token_ttl_seconds
    jti = uuid.uuid4().hex
    payload = f"{board_id}.{expires_at}.{jti}"
    return f"{payload}.{_sign(payload)}"


async def verify(token: str, board_id: str, redis: Redis) -> WsTokenClaims:
    """Validate and consume a token. Raises TokenError on any rejection."""
    parts = token.split(".")
    if len(parts) != 4:
        raise TokenInvalid("malformed token")

    claimed_board, raw_expires, jti, signature = parts

    payload = f"{claimed_board}.{raw_expires}.{jti}"
    if not hmac.compare_digest(_sign(payload), signature):
        raise TokenInvalid("bad signature")

    try:
        expires_at = int(raw_expires)
    except ValueError as exc:
        raise TokenInvalid("bad expiry") from exc

    if expires_at < int(time.time()):
        raise TokenExpired("token expired")

    # Scope check. A token minted for one board must not open another.
    if claimed_board != board_id:
        raise TokenInvalid("token scoped to a different board")

    # Consume. SET NX is atomic, so two connections racing the same token means
    # exactly one wins. TTL matches the token so keys expire on their own.
    claimed = await redis.set(
        _REPLAY_KEY.format(jti=jti),
        "1",
        nx=True,
        ex=settings.ws_token_ttl_seconds + 5,
    )
    if not claimed:
        raise TokenReplayed("token already used")

    return WsTokenClaims(board_id=claimed_board, expires_at=expires_at, jti=jti)
