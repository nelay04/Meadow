"""Room management and the Starlette/FastAPI Channel adapter.

pycrdt-websocket 0.16 dropped the server-level `ystore` argument: WebsocketServer
creates bare YRooms and persistence is a per-room concern. So `get_room` is overridden
here to attach a PostgresYStore and to load existing state before the room starts.
"""

from collections import defaultdict
from logging import Logger, getLogger
from typing import Any

from anyio import BrokenResourceError, ClosedResourceError, Lock
from fastapi import WebSocket
from pycrdt import Channel, Doc, create_awareness_message
from pycrdt.websocket import WebsocketServer, YRoom
from starlette.websockets import WebSocketDisconnect

from app.realtime.ystore import PostgresYStore

logger = getLogger(__name__)

#: The ways "the peer is not there any more" arrives, which is not an error condition.
#:
#: Four types for one fact, because it can be noticed at four layers: Starlette raises
#: `WebSocketDisconnect` when the ASGI send is refused, uvicorn raises
#: `ClientDisconnected` underneath it, anyio raises its own pair when the stream behind
#: it is already closed, and a `RuntimeError` is what Starlette gives for a send after
#: a close has been sent - which is the same fact stated a fifth way.
GONE = (
    WebSocketDisconnect,
    BrokenResourceError,
    ClosedResourceError,
    RuntimeError,
)


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
        """Write one message, treating a peer that has left as ordinary.

        This is the fan-out path: the room relays every update and every awareness
        frame to every client it has, and a client leaving between the fan-out and the
        write is a race that happens constantly rather than an error.

        It was not treated as one, and the consequence was out of all proportion. The
        relay spawns each write on the *room's* task group, so a `WebSocketDisconnect`
        here unwound the room; `YRoom` re-raised it, which unwound the **server's** task
        group, because a room is started as a child of it. From that moment
        `WebsocketServer` had no task group, and every websocket connect on every board
        answered "The WebsocketServer is not running" for the rest of the process's
        life. One person closing a laptop lid at the wrong instant took realtime down
        for everybody until somebody restarted the API.

        Dropping the message is the whole of the fix, and it loses nothing: the socket
        is gone, so there is nobody to deliver to, and the serve loop's own teardown
        removes the client from the room a moment later.
        """
        async with self._send_lock:
            try:
                await self._websocket.send_bytes(message)
            except GONE:
                logger.debug("dropped a message to a client that had left %s", self._path)

    async def recv(self) -> bytes:
        return bytes(await self._websocket.receive_bytes())

    async def __anext__(self) -> bytes:
        try:
            return await self.recv()
        except Exception:  # noqa: BLE001 - any recv failure means the socket is gone
            raise StopAsyncIteration from None


def awareness_snapshot(room: YRoom) -> bytes | None:
    """Everyone already in the room, as one message for a client that has just joined.

    pycrdt relays awareness and never replays it: `YRoom.serve` greets a new client
    with a sync message and nothing else, so a client learns who else is here only when
    one of them next says something. y-protocols re-announces on a fifteen-second
    timer, so it heals - eventually, and after a silence that reads as an empty room.

    That silence is worst exactly where it is least acceptable. Every eviction is a
    reconnect, and y-websocket drops every remote awareness state when a socket closes
    (`closeWebsocketConnection`), so a client coming back from a lock, a role change or
    a dropped connection starts with nobody on the board and waits out the timer before
    the faces return. The peers cannot help: they never lost the reconnecting client,
    so to them nothing happened worth announcing.

    The reference y-websocket server sends this snapshot on connect. So does this one.

    An earlier attempt at it hung the room, and the note in `sync/awareness.ts` blamed
    the idea; the fault was the placement. Written into the channel before `YRoom.serve`
    had taken it over, it raced the room's own first write. Here it only builds the
    message - the caller sends it from inside the connection's task group, alongside the
    room, through the channel's own send lock.

    Returns None when there is nobody to describe, including the room's own local state:
    the server keeps an awareness entry of its own, and a client rendering peers would
    have to know to skip it.
    """
    awareness = room.awareness
    client_ids = [
        client_id
        for client_id, state in awareness.states.items()
        if client_id != awareness.client_id and state
    ]
    if not client_ids:
        return None
    return create_awareness_message(awareness.encode_awareness_update(client_ids))


def _only_gone(exception: BaseException) -> bool:
    """Whether this is nothing but departed peers, however deeply it is wrapped.

    anyio hands an exception group to the handler when several tasks fail together, and
    a fan-out to a room full of clients that have all closed at once is exactly that.
    Reading only the outermost type would log a routine mass disconnect - everybody
    leaving when a board is evicted, say - as an error with a traceback.
    """
    if isinstance(exception, BaseExceptionGroup):
        return all(_only_gone(inner) for inner in exception.exceptions)
    return isinstance(exception, GONE)


def _survive(exception: Exception, log: Logger) -> bool:
    """Keep one connection's failure from ending the realtime layer.

    Without a handler here, pycrdt re-raises anything a room task hits. A room is
    started as a child of the server's task group, so re-raising unwinds the room, then
    the server, and every websocket connect on every board afterwards answers "The
    WebsocketServer is not running" until the process is restarted. That happened in
    production from a single peer disconnecting mid-relay, and it is the failure this
    exists to make impossible: the blast radius of one bad connection has to be one
    connection.

    So it returns True for everything, and this is deliberate rather than lazy. There
    is no exception a *relay* can hit for which "stop relaying for everybody, until a
    human notices" is the better answer - the room is stopped either way, the board it
    was serving reloads from Postgres, and clients reconnect on their own.

    Handled is not hidden. A departed peer is logged at debug, because it is routine and
    is already dealt with in `FastAPIChannel.send`; everything else is logged with its
    traceback at error, so a real fault is as loud as it ever was and is simply no
    longer fatal.
    """
    if _only_gone(exception):
        log.debug("realtime: a client went away mid-message: %r", exception)
    else:
        log.error("realtime: room task failed, continuing", exc_info=exception)
    return True


class MeadowWebsocketServer(WebsocketServer):
    """WebsocketServer that persists each room to Postgres."""

    def __init__(self, log: Logger | None = None) -> None:
        # auto_clean_rooms evicts the moment the last client leaves. ARCHITECTURE 6
        # wants a 30s grace period; that is M5. Kept on for M0 because it makes the
        # last-disconnect persistence path the default path, which is the one the
        # gate needs to prove.
        super().__init__(
            auto_clean_rooms=True,
            log=log or logger,
            exception_handler=_survive,
        )
        # One lock per board, held across the whole of `get_room`. See there.
        self._room_locks: defaultdict[str, Lock] = defaultdict(Lock)

    async def delete_room(self, *, name: str | None = None, room: YRoom | None = None) -> None:
        """Idempotent room deletion.

        `WebsocketServer.serve` deletes the room whenever the client it was serving
        was the last one out. Two clients disconnecting at the same instant both
        observe an empty client set, so both call this - and upstream's version
        resolves the name with `list(...).index(room)`, which raises ValueError once
        the first call has already removed it. The exception surfaces from the
        teardown path of a perfectly ordinary disconnect.

        Resolving the name defensively and popping once makes the second call a no-op.
        """
        if name is not None and room is not None:
            raise RuntimeError("Cannot pass name and room")

        if name is None:
            if room is None:
                return
            name = next((key for key, value in self.rooms.items() if value is room), None)
            if name is None:
                return

        existing = self.rooms.pop(name, None)
        if existing is None:
            return
        await existing.stop()

    async def get_room(self, name: str) -> YRoom:
        """The one room for a board, created at most once.

        The lock is the whole point of this override existing in the form it does.
        Between the "is there a room" check and the assignment there is an `await` -
        the store replaying the board's history - and an await is a place another
        connection runs. Two clients arriving inside that window both found no room,
        both built one, and the second overwrote the first in `self.rooms`.

        Nothing raised. The first client went on being served by a room that was no
        longer registered, which is far worse than a crash: two rooms on one board are
        two documents. Neither client sees the other's edits or the other's cursor,
        both write their own updates into the same store, and the board they reload
        into afterwards is whichever of the two histories interleaved last. It read
        exactly like the app "going out of sync", and it happened where clients arrive
        together - two people opening a board at once, and every eviction, because an
        eviction is everybody reconnecting at the same instant.

        Per board rather than one lock for the server: replaying a long history is a
        database read, and one lock would make every board's first join wait behind
        every other board's.
        """
        async with self._room_locks[name]:
            if name not in self.rooms:
                # Doc is generic over its root types. The server only relays and
                # persists binary updates and never reads the document, so Any is
                # accurate here.
                ydoc: Doc[Any] = Doc()
                ystore = PostgresYStore(path=name, log=self.log)

                # Load before constructing the YRoom. The room only starts writing to
                # the store once started, so replaying history here does not re-append
                # it.
                await ystore.apply_updates(ydoc)

                self.rooms[name] = YRoom(
                    ready=self.rooms_ready,
                    ystore=ystore,
                    ydoc=ydoc,
                    exception_handler=self.exception_handler,
                    log=self.log,
                )

            room = self.rooms[name]
            # Inside the lock as well. `start_room` has the same shape of race - it
            # checks `started` and then awaits - and starting a room twice raises from
            # the second caller.
            await self.start_room(room)
            return room
