"""One bad connection must not end the realtime layer.

Written from a production failure rather than from a design document. A peer went away
while the room was relaying to it, `FastAPIChannel.send` raised, and because the relay
spawns each write on the *room's* task group and pycrdt re-raises what it cannot
handle, the unwind went room -> server. From that moment the server had no task group,
and every websocket connect on every board answered "The WebsocketServer is not
running" for the rest of the process's life. The connection pill read Offline for hours
and nothing in the deployment could sync.

The property under test is not "sends succeed". It is that the blast radius of one
connection is one connection.
"""

from logging import getLogger
from typing import Any

import pytest
from starlette.websockets import WebSocketDisconnect

from app.realtime.server import GONE, FastAPIChannel, _only_gone, _survive


class _GoneSocket:
    """A websocket whose peer has left, which is all `send` needs to know about it."""

    def __init__(self, error: BaseException) -> None:
        self.error = error
        self.attempts = 0

    async def send_bytes(self, message: bytes) -> None:
        self.attempts += 1
        raise self.error


@pytest.mark.parametrize(
    "error",
    [
        WebSocketDisconnect(1006),
        RuntimeError('Cannot call "send" once a close message has been sent.'),
    ],
)
async def test_sending_to_a_departed_peer_is_not_an_error(error: BaseException) -> None:
    """The fan-out writes to every client in the room, and one of them may have left.

    Raising here is what took the whole server down, because this coroutine is spawned
    on the room's task group.
    """
    socket = _GoneSocket(error)
    channel = FastAPIChannel(socket, path="board-1")  # type: ignore[arg-type]

    await channel.send(b"anything")

    assert socket.attempts == 1


async def test_a_real_send_failure_still_raises() -> None:
    """Only the departure family is swallowed. A bug is still a bug."""
    socket = _GoneSocket(ValueError("that is not a websocket problem"))
    channel = FastAPIChannel(socket, path="board-1")  # type: ignore[arg-type]

    with pytest.raises(ValueError):
        await channel.send(b"anything")


def test_the_server_survives_a_room_task_failing() -> None:
    """The backstop. Nothing a room hits may unwind the server's task group."""
    assert _survive(RuntimeError("something went wrong"), getLogger("test-realtime")) is True
    assert _survive(WebSocketDisconnect(1006), getLogger("test-realtime")) is True


def test_a_mass_disconnect_is_read_as_routine(caplog: Any) -> None:
    """Everybody leaving at once arrives as a group, and is not a fault.

    An eviction closes every socket on a board, so the fan-out that follows fails once
    per client. Read only at the outermost type, that is an exception group and would be
    logged with a traceback every time the owner pressed the lock button.
    """
    departures = BaseExceptionGroup(
        "fan-out", [WebSocketDisconnect(1006), WebSocketDisconnect(1006)]
    )
    assert _only_gone(departures) is True

    mixed = BaseExceptionGroup("fan-out", [WebSocketDisconnect(1006), ValueError("real")])
    assert _only_gone(mixed) is False

    log = getLogger("test-realtime-quiet")
    with caplog.at_level("DEBUG", logger="test-realtime-quiet"):
        assert _survive(departures, log) is True  # type: ignore[arg-type]

    assert [record.levelname for record in caplog.records] == ["DEBUG"]


def test_the_departure_family_is_the_one_the_stack_actually_raises() -> None:
    """The four types are not a guess: each is a layer that reports the same fact."""
    assert WebSocketDisconnect in GONE
    assert RuntimeError in GONE
