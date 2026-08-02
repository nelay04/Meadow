"""Room management and the Starlette/FastAPI Channel adapter.

pycrdt-websocket 0.16 dropped the server-level `ystore` argument: WebsocketServer
creates bare YRooms and persistence is a per-room concern. So `get_room` is overridden
here to attach a PostgresYStore and to load existing state before the room starts.
"""

from logging import Logger, getLogger
from typing import Any

from anyio import Lock
from fastapi import WebSocket
from pycrdt import Channel, Doc
from pycrdt.websocket import WebsocketServer, YRoom

from app.realtime.ystore import PostgresYStore

logger = getLogger(__name__)


class FastAPIChannel(Channel):
    """Adapts a Starlette WebSocket to the pycrdt Channel protocol.

    `path` is what WebsocketServer.serve uses to pick the room, so it carries the
    board id, not the URL path.
    """

    def __init__(self, websocket: WebSocket, path: str) -> None:
        self._websocket = websocket
        self._path = path
        self._send_lock = Lock()

    @property
    def path(self) -> str:
        return self._path

    async def send(self, message: bytes) -> None:
        async with self._send_lock:
            await self._websocket.send_bytes(message)

    async def recv(self) -> bytes:
        return bytes(await self._websocket.receive_bytes())

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except Exception:  # noqa: BLE001 - any recv failure means the socket is gone
            raise StopAsyncIteration from None


class MeadowWebsocketServer(WebsocketServer):
    """WebsocketServer that persists each room to Postgres."""

    def __init__(self, log: Logger | None = None) -> None:
        # auto_clean_rooms evicts the moment the last client leaves. ARCHITECTURE 6
        # wants a 30s grace period; that is M5. Kept on for M0 because it makes the
        # last-disconnect persistence path the default path, which is the one the
        # gate needs to prove.
        super().__init__(auto_clean_rooms=True, log=log or logger)

    async def get_room(self, name: str) -> YRoom:
        if name not in self.rooms:
            # Doc is generic over its root types. The server only relays and persists
            # binary updates and never reads the document, so Any is accurate here.
            ydoc: Doc[Any] = Doc()
            ystore = PostgresYStore(path=name, log=self.log)

            # Load before constructing the YRoom. The room only starts writing to the
            # store once started, so replaying history here does not re-append it.
            await ystore.apply_updates(ydoc)

            self.rooms[name] = YRoom(
                ready=self.rooms_ready,
                ystore=ystore,
                ydoc=ydoc,
                exception_handler=self.exception_handler,
                log=self.log,
            )

        room = self.rooms[name]
        await self.start_room(room)
        return room
