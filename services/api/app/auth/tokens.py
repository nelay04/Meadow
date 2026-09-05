"""Access tokens (JWT) and refresh tokens (opaque), per ARCHITECTURE 7.

Deliberate deviation from the spec's access-token claims: it lists
`{ sub, workspace_ids, jti, exp }`, and `workspace_ids` is omitted here.

Embedding memberships in a bearer token means authorisation data that is 15 minutes
stale by design, and the moment anything reads it the revocation story breaks - a user
removed from a workspace keeps access until their token expires. Every path that needs
a role already resolves it live through `app/services/permissions.py`, so the claim
would be either unused or a bug waiting to be written. `sub` is the identity; roles are
resolved, never asserted by the client.

`sid` - the refresh-token family the token was minted for - is a deliberate reversal of
that reasoning, and it is not the same kind of claim. It asserts nothing about what the
caller may do; it names *which session asked*, so that `current_user` can look up
whether that session has since been terminated. Without it, terminating a session was a
statement about the future - no new access tokens - while the one already in the
terminated browser kept working for the rest of its fifteen minutes. The rule the
paragraph above is really making is that a token must not carry an *answer*; naming the
session so the answer can be looked up live is the opposite of that.
"""

import hashlib
import secrets
import time
import uuid
from dataclasses import dataclass

import jwt

from app.config import settings

_ALGORITHM = "HS256"
TOKEN_TYPE_ACCESS = "access"


class AccessTokenError(Exception):
    """Access token rejected. Maps to HTTP 401."""


@dataclass(frozen=True)
class AccessClaims:
    user_id: uuid.UUID
    jti: str
    expires_at: int
    #: The refresh-token family this token was minted for. Empty for a token issued
    #: before the claim existed, which is simply one that cannot be denied early.
    session_id: str = ""


def create_access_token(user_id: uuid.UUID, family_id: uuid.UUID | None = None) -> tuple[str, int]:
    """Return (token, expires_at as a unix timestamp)."""
    issued_at = int(time.time())
    expires_at = issued_at + settings.access_token_ttl_seconds
    payload = {
        "sub": str(user_id),
        "jti": uuid.uuid4().hex,
        "iat": issued_at,
        "exp": expires_at,
        "typ": TOKEN_TYPE_ACCESS,
    }
    if family_id is not None:
        payload["sid"] = str(family_id)
    return jwt.encode(payload, settings.jwt_secret, algorithm=_ALGORITHM), expires_at


def decode_access_token(token: str) -> AccessClaims:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[_ALGORITHM])
    except jwt.PyJWTError as exc:
        raise AccessTokenError(str(exc)) from exc

    # ws-tokens are signed with the same key. Without this check one would be
    # accepted as a bearer token for the whole API.
    if payload.get("typ") != TOKEN_TYPE_ACCESS:
        raise AccessTokenError("wrong token type")

    try:
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise AccessTokenError("bad subject") from exc

    return AccessClaims(
        user_id=user_id,
        jti=payload.get("jti", ""),
        expires_at=int(payload["exp"]),
        session_id=str(payload.get("sid", "")),
    )


def new_refresh_token() -> tuple[str, str]:
    """Return (raw token, sha256 hex digest).

    Opaque random rather than a JWT: refresh tokens have to be revocable, which means
    a database lookup on every use, which means there is nothing for a self-contained
    token to buy. Only the digest is stored, so a database leak yields no sessions.
    """
    raw = secrets.token_urlsafe(32)
    return raw, hash_refresh_token(raw)


def hash_refresh_token(raw: str) -> str:
    # Plain sha256, not a password KDF: this is a 256-bit random value, so there is no
    # guessable input to slow an attacker down over.
    return hashlib.sha256(raw.encode()).hexdigest()
