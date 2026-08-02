"""Read-only enforcement for the CRDT stream.

ARCHITECTURE 6 step 7: if the role is `viewer`, drop inbound updates and accept
awareness only. This is the backstop for a tampered client, not the user experience -
the client is told its role at mint time and refuses the write before it happens. Both
halves ship together, because server-side dropping alone gives a viewer edits that
appear, persist locally, and then vanish on reload.

Wire format is y-protocols:

    [varuint messageType] ...             0 = sync, 1 = awareness
    sync: [varuint syncType] ...          0 = step1, 1 = step2, 2 = update
"""

from logging import Logger

from fastapi import WebSocket

from app.realtime.server import FastAPIChannel

MESSAGE_SYNC = 0
MESSAGE_AWARENESS = 1

SYNC_STEP1 = 0
SYNC_STEP2 = 1
SYNC_UPDATE = 2


def _read_varuint(data: bytes, pos: int) -> tuple[int, int]:
    value = 0
    shift = 0
    while pos < len(data):
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7
    raise ValueError("truncated varuint")


def is_read_only_safe(message: bytes) -> bool:
    """Whether a viewer may send this message.

    Allowed:
      - awareness, so a viewer's cursor still shows up as a wanderer
      - sync step 1, which is a *request* for state, not a mutation

    Dropped:
      - sync step 2 and sync update, the two ways a client pushes document state.
        Step 2 matters as much as update: it is how a client that edited while
        offline replays those edits on reconnect.

    Unknown message types are dropped. A new type added by a future y-protocols
    version must not become a write channel by default.
    """
    if not message:
        return False
    try:
        message_type, pos = _read_varuint(message, 0)
        if message_type == MESSAGE_AWARENESS:
            return True
        if message_type != MESSAGE_SYNC:
            return False
        sync_type, _ = _read_varuint(message, pos)
    except ValueError:
        return False
    return sync_type == SYNC_STEP1


class ReadOnlyChannel(FastAPIChannel):
    """A channel that silently swallows a viewer's writes.

    Silently on purpose: an error frame would tell a scripted client exactly which
    payloads are filtered, and a legitimate client never sends these because it
    already knows its role.
    """

    def __init__(self, websocket: WebSocket, path: str, log: Logger) -> None:
        super().__init__(websocket, path)
        self._log = log
        self.dropped = 0

    async def recv(self) -> bytes:
        while True:
            message = await super().recv()
            if is_read_only_safe(message):
                return message
            self.dropped += 1
            self._log.info(
                "dropped write from read-only client on board %s (%d so far)",
                self.path,
                self.dropped,
            )
