"""M0 spike API.

Scope is deliberately narrow: prove the websocket handshake, CRDT convergence, and
Postgres persistence across a full server restart. No users, no workspaces, no roles.
Those arrive in M1.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from logging import getLogger

from fastapi import Depends, FastAPI, HTTPException, WebSocket
from pydantic import BaseModel
from redis.asyncio import Redis
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.db import SessionLocal, engine, get_session
from app.models import Base, Board
from app.realtime import wstoken
from app.realtime.server import FastAPIChannel, MeadowWebsocketServer

logger = getLogger(__name__)

# Close codes from ARCHITECTURE 6.
WS_CLOSE_UNAUTHORIZED = 4401
WS_CLOSE_FORBIDDEN = 4403
WS_CLOSE_ROOM_FULL = 4429


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    # M0 creates tables directly. Alembic owns the schema from M1 on.
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=True)
    app.state.ws_server = MeadowWebsocketServer()

    async with app.state.ws_server:
        yield

    await app.state.redis.aclose()
    await engine.dispose()


app = FastAPI(title="Meadow API (M0 spike)", lifespan=lifespan)


class CreateBoard(BaseModel):
    title: str = "Untitled"


class BoardOut(BaseModel):
    id: uuid.UUID
    title: str


class WsTokenRequest(BaseModel):
    board_id: uuid.UUID


class WsTokenOut(BaseModel):
    token: str
    expires_in: int


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/api/v1/boards", response_model=BoardOut)
async def create_board(
    body: CreateBoard, session: AsyncSession = Depends(get_session)
) -> BoardOut:
    board = Board(title=body.title)
    session.add(board)
    await session.commit()
    return BoardOut(id=board.id, title=board.title)


@app.get("/api/v1/boards", response_model=list[BoardOut])
async def list_boards(session: AsyncSession = Depends(get_session)) -> list[BoardOut]:
    rows = (await session.execute(select(Board).order_by(Board.created_at))).scalars()
    return [BoardOut(id=row.id, title=row.title) for row in rows]


@app.post("/api/v1/ws-token", response_model=WsTokenOut)
async def create_ws_token(
    body: WsTokenRequest, session: AsyncSession = Depends(get_session)
) -> WsTokenOut:
    """M0: no caller identity, so this only checks the board exists.

    M1 adds the access-token dependency and resolves the caller's board role before
    minting, which is what makes the token meaningful.
    """
    board = await session.get(Board, body.board_id)
    if board is None:
        raise HTTPException(status_code=404, detail="board not found")

    return WsTokenOut(
        token=wstoken.mint(str(body.board_id)),
        expires_in=settings.ws_token_ttl_seconds,
    )


@app.websocket("/ws/board/{board_id}")
async def board_socket(websocket: WebSocket, board_id: str, token: str = "") -> None:
    """The security boundary. Validate before joining the room, never after."""
    await websocket.accept()

    try:
        uuid.UUID(board_id)
    except ValueError:
        await websocket.close(code=WS_CLOSE_FORBIDDEN, reason="bad board id")
        return

    redis: Redis = websocket.app.state.redis
    try:
        await wstoken.verify(token, board_id, redis)
    except wstoken.TokenError as exc:
        logger.info("ws rejected for board %s: %s", board_id, exc)
        await websocket.close(code=WS_CLOSE_UNAUTHORIZED, reason=str(exc))
        return

    # Board existence stands in for role resolution until M1.
    async with SessionLocal() as session:
        if await session.get(Board, uuid.UUID(board_id)) is None:
            await websocket.close(code=WS_CLOSE_FORBIDDEN, reason="no access")
            return

    server: MeadowWebsocketServer = websocket.app.state.ws_server
    room = await server.get_room(board_id)
    if len(room.clients) >= settings.max_clients_per_room:
        await websocket.close(code=WS_CLOSE_ROOM_FULL, reason="room full")
        return

    channel = FastAPIChannel(websocket, path=board_id)
    await server.serve(channel)
