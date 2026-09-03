"""Meadow API: REST plus the CRDT websocket."""

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from logging import getLogger

import anyio
from fastapi import FastAPI, WebSocket
from pycrdt.websocket import YRoom
from redis.asyncio import Redis

from app.api.v1 import router as api_router
from app.config import settings
from app.db import SessionLocal, engine
from app.realtime import wstoken
from app.realtime.guard import ReadOnlyChannel
from app.realtime.rooms import (
    WS_CLOSE_FORBIDDEN,
    WS_CLOSE_ROOM_FULL,
    WS_CLOSE_UNAUTHORIZED,
    SocketRegistry,
)
from app.realtime.server import FastAPIChannel, MeadowWebsocketServer, awareness_snapshot
from app.services.permissions import Access, resolve_access

logger = getLogger(__name__)

# Re-exported from `app.realtime.rooms`, which is where they moved once the evictor
# needed them too. Kept in this namespace because that is where they have always been
# read from.
__all__ = ["WS_CLOSE_FORBIDDEN", "WS_CLOSE_ROOM_FULL", "WS_CLOSE_UNAUTHORIZED", "app"]


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Schema is owned by Alembic from M1 on: `alembic upgrade head`. Creating tables
    # at boot would silently diverge from the migrations nobody then runs.
    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.ws_server = MeadowWebsocketServer()
    # Which sockets are open on which board, so the share dialog's lock and mode
    # switches can close them and have the handshake decide again. See
    # `app/realtime/rooms.py`.
    app.state.sockets = SocketRegistry()

    async with app.state.ws_server:
        yield

    await app.state.redis.aclose()
    await engine.dispose()


app = FastAPI(title="Meadow API", lifespan=lifespan)
app.include_router(api_router)


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


async def _watch_session(
    websocket: WebSocket, claims: wstoken.WsTokenClaims, granted: Access
) -> None:
    """Close the socket when the session behind it ends or its access changes.

    Without this the handshake is a one-time check: a socket held open for days keeps
    whatever it was granted on day one, and revoking access has no effect until the
    user happens to reconnect.

    Wakes at the earlier of the revalidation interval (ARCHITECTURE 6: every 15
    minutes) and the access token's own expiry, so an expiring session closes promptly
    rather than at the next interval boundary. A link visitor has no session to inherit
    and gets an invented one of the same length, so a revoked share link closes its
    sockets on the same schedule.

    This is the backstop and not the mechanism for anything a person does and watches
    for: locking a board, or closing it to the public, evicts its sockets immediately
    through `app.state.sockets`. Fifteen minutes is right for a grant quietly revoked
    and much too slow for a button somebody just pressed.
    """
    board_uuid = uuid.UUID(claims.board_id)

    while True:
        remaining = claims.session_expires_at - time.time()
        if remaining <= 0:
            await _close(websocket, WS_CLOSE_UNAUTHORIZED, "session expired")
            return

        await anyio.sleep(min(float(settings.ws_revalidate_interval_seconds), remaining))

        if time.time() >= claims.session_expires_at:
            await _close(websocket, WS_CLOSE_UNAUTHORIZED, "session expired")
            return

        async with SessionLocal() as session:
            current = await resolve_access(
                session,
                board_id=board_uuid,
                user_id=claims.user_id,
                link_token=claims.link_token,
            )

        # The role *and* the lock, because the read-only filter is chosen once at join
        # time from both of them. A board locked while this socket was open is a
        # connection still holding a writable channel, which is the same problem as a
        # demotion and has the same only-safe answer: close, and be re-evaluated.
        changed = current is None or (
            current.role,
            current.can_write,
        ) != (granted.role, granted.can_write)
        if changed:
            logger.info(
                "closing ws for board %s: %s/%s -> %s",
                claims.board_id,
                granted.role,
                "rw" if granted.can_write else "ro",
                "none"
                if current is None
                else f"{current.role}/{'rw' if current.can_write else 'ro'}",
            )
            await _close(websocket, WS_CLOSE_FORBIDDEN, "access changed")
            return


async def _greet_with_presence(room: YRoom, channel: FastAPIChannel) -> None:
    """Tell a joining client who is already on the board.

    Without it the faces on a reconnect arrive up to fifteen seconds late, which covers
    every eviction the app does on purpose - see `awareness_snapshot`.

    Best effort: a socket that is already gone raises from `send`, and a client that
    missed the snapshot still heals on the peers' next re-announce, which is exactly
    where it was before this existed.
    """
    message = awareness_snapshot(room)
    if message is None:
        return
    with suppress(Exception):  # noqa: BLE001 - the socket is on its way out either way
        await channel.send(message)


async def _close(websocket: WebSocket, code: int, reason: str) -> None:
    # The watchdog closes from a different task than the one serving the room, so it
    # can race a peer disconnect that already tore the socket down.
    with suppress(RuntimeError):
        await websocket.close(code=code, reason=reason)


@app.websocket("/ws/board/{board_id}")
async def board_socket(websocket: WebSocket, board_id: str, token: str = "") -> None:
    """The security boundary. Validate before joining the room, never after.

    Order matters. Every rejection below happens before the connection is attached to
    a room, because once it is attached it is already receiving document state.
    """
    await websocket.accept()

    try:
        board_uuid = uuid.UUID(board_id)
    except ValueError:
        await _close(websocket, WS_CLOSE_FORBIDDEN, "no access")
        return

    redis: Redis = websocket.app.state.redis
    try:
        claims = await wstoken.verify(token, board_id, redis)
    except wstoken.TokenScopeMismatch as exc:
        # Authentic token, wrong board. Authorisation, not authentication - see
        # wstoken.TokenScopeMismatch.
        logger.info("ws scope violation for board %s: %s", board_id, exc)
        await _close(websocket, WS_CLOSE_FORBIDDEN, "no access")
        return
    except wstoken.TokenError as exc:
        logger.info("ws rejected for board %s: %s", board_id, exc)
        await _close(websocket, WS_CLOSE_UNAUTHORIZED, str(exc))
        return

    # Resolved now, against current state, and through the one function that knows
    # about all three ways access is decided - membership, the public link, and the
    # owner's lock. The token proves who the caller is, never what they may do: it may
    # have been minted up to 60 seconds ago, and the board can have been deleted, the
    # grant revoked, the link rotated or the board locked since.
    async with SessionLocal() as session:
        access = await resolve_access(
            session,
            board_id=board_uuid,
            user_id=claims.user_id,
            link_token=claims.link_token,
        )

    if access is None:
        await _close(websocket, WS_CLOSE_FORBIDDEN, "no access")
        return

    server: MeadowWebsocketServer = websocket.app.state.ws_server
    room = await server.get_room(board_id)
    if len(room.clients) >= settings.max_clients_per_room:
        await _close(websocket, WS_CLOSE_ROOM_FULL, "room full")
        return

    channel: FastAPIChannel
    if access.can_write:
        channel = FastAPIChannel(websocket, path=board_id)
    else:
        # Viewers, commenters, and anybody at all while the board is locked: awareness
        # and sync requests pass, document writes are dropped. The client already knows
        # from the mint response and refuses the write first; this is the backstop for
        # a tampered client, and the reason the lock is a real lock rather than a
        # request that everyone behave.
        channel = ReadOnlyChannel(websocket, path=board_id, log=logger)

    sockets: SocketRegistry = websocket.app.state.sockets
    sockets.add(board_id, websocket)
    try:
        async with anyio.create_task_group() as task_group:
            task_group.start_soon(_watch_session, websocket, claims, access)
            task_group.start_soon(_greet_with_presence, room, channel)
            await server.serve(channel)
            task_group.cancel_scope.cancel()
    finally:
        sockets.discard(board_id, websocket)
