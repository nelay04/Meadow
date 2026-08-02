"""Meadow API: REST plus the CRDT websocket."""

import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from logging import getLogger

import anyio
from fastapi import FastAPI, WebSocket
from redis.asyncio import Redis

from app.api.v1 import router as api_router
from app.config import settings
from app.db import SessionLocal, engine
from app.realtime import wstoken
from app.realtime.guard import ReadOnlyChannel
from app.realtime.server import FastAPIChannel, MeadowWebsocketServer
from app.services.permissions import BoardRole, can_write, resolve_role

logger = getLogger(__name__)

# Close codes from ARCHITECTURE 6.
WS_CLOSE_UNAUTHORIZED = 4401  # the credential is bad: forged, expired, or spent
WS_CLOSE_FORBIDDEN = 4403  # the credential is good but does not authorise this board
WS_CLOSE_ROOM_FULL = 4429


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # Schema is owned by Alembic from M1 on: `alembic upgrade head`. Creating tables
    # at boot would silently diverge from the migrations nobody then runs.
    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.ws_server = MeadowWebsocketServer()

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
    websocket: WebSocket, claims: wstoken.WsTokenClaims, granted: BoardRole
) -> None:
    """Close the socket when the session behind it ends or its role changes.

    Without this the handshake is a one-time check: a socket held open for days keeps
    whatever role it was granted on day one, and revoking access has no effect until
    the user happens to reconnect.

    Wakes at the earlier of the revalidation interval (ARCHITECTURE 6: every 15
    minutes) and the access token's own expiry, so an expiring session closes promptly
    rather than at the next interval boundary.
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
            current = await resolve_role(session, user_id=claims.user_id, board_id=board_uuid)

        # Any change closes the connection, including an upgrade: the read-only
        # filter is chosen once at join time, so the only safe way to change role is
        # to reconnect and be re-evaluated.
        if current != granted:
            logger.info(
                "closing ws for board %s: role %s -> %s", claims.board_id, granted, current
            )
            await _close(websocket, WS_CLOSE_FORBIDDEN, "role changed")
            return


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

    # Resolved now, against current state. The token proves who the caller is, never
    # what they may do - it may have been minted up to 60 seconds ago, and the board
    # can have been deleted or the grant revoked since.
    async with SessionLocal() as session:
        role = await resolve_role(session, user_id=claims.user_id, board_id=board_uuid)

    if role is None:
        await _close(websocket, WS_CLOSE_FORBIDDEN, "no access")
        return

    server: MeadowWebsocketServer = websocket.app.state.ws_server
    room = await server.get_room(board_id)
    if len(room.clients) >= settings.max_clients_per_room:
        await _close(websocket, WS_CLOSE_ROOM_FULL, "room full")
        return

    channel: FastAPIChannel
    if can_write(role):
        channel = FastAPIChannel(websocket, path=board_id)
    else:
        # Viewers and commenters: awareness and sync requests pass, document writes
        # are dropped. The client already knows its role from the mint response and
        # refuses the write first; this is the backstop for a tampered client.
        channel = ReadOnlyChannel(websocket, path=board_id, log=logger)

    async with anyio.create_task_group() as task_group:
        task_group.start_soon(_watch_session, websocket, claims, role)
        await server.serve(channel)
        task_group.cancel_scope.cancel()
