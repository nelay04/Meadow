"""Short-lived, single-use websocket tokens.

A browser cannot set an Authorization header on a WebSocket, so the credential has to
travel in the URL - where it lands in proxy logs and browser history. Hence 60s, one
board, one use.

The token carries *identity* and a session deadline, never a role. Roles are resolved
live at connect time through `app/services/permissions.py`; a role baked in at mint
time would be a 60s window in which a revoked user still has their old access.

Identity here is one of two things, and the token says which:

- **A user.** `user_id` is set, and the handshake resolves their membership.
- **A link visitor.** `user_id` is empty and `guest_id` holds a random per-visit value.
  There is no account behind it and it proves nothing; it exists so awareness has a
  stable key for one visitor's cursor for the length of one visit, and so two anonymous
  people on the same public board are two wanderers rather than one flickering between
  positions.

`link_token` rides along for both. It is not a second credential so much as the reason
the handshake should look at the share link at all, and it is re-checked at connect
time exactly like a role: a link revoked or a board switched back to restricted between
mint and connect must not still open it.

`session_expires_at` is inherited from the access token that authorised the mint. It
is what stops a socket outliving its session: the handshake refuses a token whose
session has already lapsed, and the watchdog closes the connection when it does. A
guest has no session to inherit, so one is invented at mint time - see
`GUEST_SESSION_TTL_SECONDS` - which is what makes a revoked link eventually close the
sockets it opened even if nothing evicts them sooner.
"""

import hashlib
import hmac
import secrets
import time
import uuid
from dataclasses import dataclass

from redis.asyncio import Redis

from app.config import settings

_REPLAY_KEY = "meadow:wstoken:used:{jti}"

# The field value standing in for "not set". A urlsafe base64 token cannot be this, a
# uuid cannot be this, and neither can a hex guest id, so it can never collide with a
# real value.
_ABSENT = "-"

#: How long an anonymous link visitor's connection may run before it is re-validated.
#:
#: The same 15 minutes a signed-in session gets, and for the same reason rather than by
#: coincidence: it is the interval at which a socket has to re-prove that what let it in
#: still lets it in. Revoking a share link or closing a board evicts its rooms
#: immediately (see `app/api/v1/boards.py`), so this is the backstop for the eviction
#: not happening - a restarted API, say - and not the mechanism.
GUEST_SESSION_TTL_SECONDS = 15 * 60


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
    #: The account behind the connection, or None for an anonymous link visitor.
    user_id: uuid.UUID | None
    #: Set instead of `user_id`, and only ever for a link visitor. Random per visit,
    #: carries no authority, and exists so presence has something to key a cursor on.
    guest_id: str | None
    #: The share link this connection came in through, if any. Re-checked at connect.
    link_token: str | None
    expires_at: int
    session_expires_at: int
    jti: str

    @property
    def subject(self) -> str:
        """A stable string for this connection's identity, for logs and presence."""
        return str(self.user_id) if self.user_id is not None else f"guest:{self.guest_id}"


def new_guest_id() -> str:
    """A per-visit identifier for somebody with no account.

    Random rather than derived from anything about the visitor. There is nothing to
    derive it from, and a value derived from an address or a user agent would be a
    fingerprint of a person who has not signed in to anything.
    """
    return secrets.token_hex(8)


def _sign(payload: str) -> str:
    return hmac.new(settings.jwt_secret.encode(), payload.encode(), hashlib.sha256).hexdigest()


def _payload(
    board_id: str,
    user: str,
    guest: str,
    link: str,
    expires_at: int | str,
    session_expires_at: int | str,
    jti: str,
) -> str:
    # The timestamps arrive as ints when minting and as the token's own raw text when
    # verifying, and verification has to rebuild the signed bytes exactly as they were
    # written. Parsing them to int first would silently canonicalise, and a payload that
    # differs from the one that was signed by even a leading zero fails to verify.
    return f"{board_id}.{user}.{guest}.{link}.{expires_at}.{session_expires_at}.{jti}"


def mint(
    board_id: str,
    user_id: uuid.UUID | None,
    session_expires_at: int,
    *,
    guest_id: str | None = None,
    link_token: str | None = None,
) -> str:
    """Issue a token. Exactly one of `user_id` and `guest_id` must be set."""
    if (user_id is None) == (guest_id is None):
        raise ValueError("a ws-token is for exactly one of a user or a guest")

    expires_at = int(time.time()) + settings.ws_token_ttl_seconds
    jti = uuid.uuid4().hex
    payload = _payload(
        board_id,
        str(user_id) if user_id is not None else _ABSENT,
        guest_id or _ABSENT,
        link_token or _ABSENT,
        expires_at,
        session_expires_at,
        jti,
    )
    return f"{payload}.{_sign(payload)}"


async def verify(token: str, board_id: str, redis: Redis) -> WsTokenClaims:
    """Validate and consume a token. Raises TokenError on any rejection."""
    parts = token.split(".")
    if len(parts) != 8:
        raise TokenInvalid("malformed token")

    (
        claimed_board,
        raw_user,
        raw_guest,
        raw_link,
        raw_expires,
        raw_session_expires,
        jti,
        signature,
    ) = parts

    payload = _payload(
        claimed_board, raw_user, raw_guest, raw_link, raw_expires, raw_session_expires, jti
    )
    if not hmac.compare_digest(_sign(payload), signature):
        raise TokenInvalid("bad signature")

    try:
        user_id = None if raw_user == _ABSENT else uuid.UUID(raw_user)
        expires_at = int(raw_expires)
        session_expires_at = int(raw_session_expires)
    except ValueError as exc:
        raise TokenInvalid("bad claims") from exc

    guest_id = None if raw_guest == _ABSENT else raw_guest
    if (user_id is None) == (guest_id is None):
        # A signature over this can only come from a mint that broke its own rule, but
        # the handshake branches on which of the two is set and must never be handed
        # both or neither.
        raise TokenInvalid("bad claims")

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
        guest_id=guest_id,
        link_token=None if raw_link == _ABSENT else raw_link,
        expires_at=expires_at,
        session_expires_at=session_expires_at,
        jti=jti,
    )
