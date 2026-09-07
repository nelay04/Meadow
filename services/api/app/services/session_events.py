"""Telling the browsers about each other, the moment something changes.

Two problems, one mechanism.

The first is the sessions list going stale. It is a picture of every browser signed in
to an account, and a picture that only updates when you reload is worse than useless on
a security screen: you check it, see nothing new, and have no way to know whether that
was true a second ago or an hour ago.

The second is the harder one. Terminating a session revoked the refresh token, which is
correct and does nothing anybody can see: the browser being terminated keeps its access
token for up to fifteen minutes and its tab looks signed in for as long as nobody
touches it. "Terminated immediately" was true of the database and false of the screen.

So a change to an account's sessions publishes on a Redis channel for that user, and
every open browser is listening on `GET /auth/sessions/stream`. Redis rather than an
in-process registry - unlike `app/realtime/rooms.py`, which is deliberately
single-instance for v1 - because there is nothing to keep in a process here: the
payload is rebuilt from the database on every event, so a second API instance needs
only to hear the bump.

The revocation denylist is the other half, and it is what makes the claim true rather
than cooperative. A browser that ignores the stream still stops working, because the
family it belongs to is listed here and `current_user` refuses an access token minted
for a listed family. Keys expire after one access-token lifetime, which is exactly how
long a token could outlive its session.
"""

import uuid
from collections.abc import AsyncIterator, Iterable
from contextlib import asynccontextmanager
from logging import getLogger

from redis.asyncio import Redis
from redis.asyncio.client import PubSub

from app.config import settings

logger = getLogger(__name__)

_CHANNEL = "meadow:sessions:{user_id}"
_REVOKED = "meadow:session-revoked:{family_id}"

#: How long a revoked family stays on the denylist. One access-token lifetime is the
#: whole window in which a token for it could still verify; after that the token's own
#: `exp` refuses it and the key would be dead weight.
_REVOKED_TTL_SECONDS = settings.access_token_ttl_seconds + 60


def channel(user_id: uuid.UUID) -> str:
    return _CHANNEL.format(user_id=user_id)


async def publish(redis: Redis, user_id: uuid.UUID) -> None:
    """Tell this user's open browsers that their session list moved.

    The message carries nothing. Every listener rebuilds the list from the database,
    which is the only copy anybody should be reading, and a payload here would be a
    second one that could disagree with it.

    Never allowed to fail a request. A login that 500s because a notification could not
    be delivered would be trading the thing that matters for the thing that does not.
    """
    try:
        await redis.publish(channel(user_id), "1")
    except Exception:  # noqa: BLE001 - any redis failure, and none of them are fatal here
        logger.warning("could not publish a session change for user %s", user_id)


async def mark_revoked(redis: Redis, family_ids: Iterable[uuid.UUID]) -> None:
    """Refuse the access tokens already minted for these sessions.

    Without this, terminating a session is a promise about the future: the refresh
    token is dead, so no *new* access token can be minted, but the one already in that
    browser's memory keeps opening every endpoint until it expires. On a screen whose
    entire purpose is ending a session you do not recognise, a quarter of an hour of
    continued access is the feature not working.
    """
    families = list(family_ids)
    if not families:
        return
    try:
        async with redis.pipeline(transaction=False) as pipe:
            for family_id in families:
                pipe.set(_REVOKED.format(family_id=family_id), "1", ex=_REVOKED_TTL_SECONDS)
            await pipe.execute()
    except Exception:  # noqa: BLE001
        # Logged loudly: unlike a missed notification this one leaves a terminated
        # session working until its access token expires, which is a security fact
        # rather than a cosmetic one.
        logger.error("could not deny-list revoked sessions %s", families)


async def is_revoked(redis: Redis, family_id: str) -> bool:
    """Has this session been terminated since its access token was minted?

    A Redis failure answers False, which lets the request through. The alternative is
    an unreachable Redis logging every user out of the whole application, and the
    refresh token - the credential that actually keeps a session alive - is checked
    against Postgres regardless.
    """
    try:
        found: int = await redis.exists(_REVOKED.format(family_id=family_id))
        return found == 1
    except Exception:  # noqa: BLE001
        logger.warning("could not check the session denylist; letting the request through")
        return False


@asynccontextmanager
async def listen(redis: Redis, user_id: uuid.UUID) -> AsyncIterator[PubSub]:
    """Subscribe to one user's session changes for as long as the block runs."""
    pubsub = redis.pubsub()
    await pubsub.subscribe(channel(user_id))
    try:
        yield pubsub
    finally:
        await pubsub.aclose()  # type: ignore[no-untyped-call]
