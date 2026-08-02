"""Redis fixed-window rate limiting, per ARCHITECTURE 7.

Fixed window, not a sliding log: it is two Redis commands and the failure mode is
allowing up to 2x the limit across a window boundary. For "stop credential stuffing"
that is fine, and the sliding version is not worth the memory per key.

Keys are namespaced by action so raising the login limit cannot accidentally widen
the registration one.
"""

from redis.asyncio import Redis

_KEY = "meadow:ratelimit:{action}:{identity}"


def parse_limit(spec: str) -> tuple[int, int]:
    """"<count>/<window seconds>" -> (count, window)."""
    count, _, window = spec.partition("/")
    return int(count), int(window)


async def check(redis: Redis, *, action: str, identity: str, spec: str) -> bool:
    """Count one hit. Returns False when the caller is over the limit.

    INCR then EXPIRE only on the first hit, so the window starts at the first request
    rather than sliding forward with every one - otherwise a caller hammering the
    endpoint keeps resetting their own expiry and is never let back in.
    """
    limit, window = parse_limit(spec)
    key = _KEY.format(action=action, identity=identity)

    hits = await redis.incr(key)
    if hits == 1:
        await redis.expire(key, window)
    return bool(hits <= limit)
