"""Single-use CSRF state for the OAuth round trip.

The attack this exists for: an attacker starts the flow with *their* GitHub account,
grabs the callback URL before it is used, and gets a victim's browser to visit it. The
victim's session is then bound to the attacker's GitHub identity. The state parameter
is what makes that fail.

Two halves have to agree, and an attacker would need both:

* a random value stored in Redis, deleted the moment it is read, so a callback URL is
  usable exactly once and expires on its own;
* the same value in an httpOnly cookie, so the callback also has to arrive in the
  browser that started the flow. Redis alone would accept a state minted in any
  browser anywhere.
"""

import json
import secrets

from redis.asyncio import Redis

_KEY = "meadow:oauth:state:{state}"

# The cookie is scoped to the OAuth routes, not the whole site: nothing else ever
# needs to see it.
COOKIE_NAME = "meadow_oauth_state"
COOKIE_PATH = "/api/v1/auth/github"


async def issue(redis: Redis, *, provider: str, next_path: str, ttl_seconds: int) -> str:
    """Mint a state value and remember what it was for."""
    state = secrets.token_urlsafe(32)
    await redis.set(
        _KEY.format(state=state),
        json.dumps({"provider": provider, "next": next_path}),
        ex=ttl_seconds,
    )
    return state


async def consume(redis: Redis, state: str, *, provider: str) -> str | None:
    """Redeem a state value, returning the redirect path it carried, or None.

    GETDEL, so redemption is atomic: two callbacks racing on one state cannot both
    win, and a replayed URL finds nothing. Returning None covers every failure -
    forged, expired, already spent, or minted for another provider - because the
    caller has the same response for all of them.
    """
    if state == "":
        return None

    raw = await redis.getdel(_KEY.format(state=state))
    if raw is None:
        return None

    try:
        payload = json.loads(raw)
    except json.JSONDecodeError:  # pragma: no cover - only reachable if a key is hand-written
        return None

    if not isinstance(payload, dict) or payload.get("provider") != provider:
        return None

    next_path = payload.get("next")
    return next_path if isinstance(next_path, str) else None
