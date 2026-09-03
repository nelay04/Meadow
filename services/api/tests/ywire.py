"""Minimal y-protocols codec, so tests can speak the wire format directly.

Enough of `y-protocols/sync` to build a sync step 1, read a step 2, and push an
update. Writing these by hand is the point: the viewer test has to prove the server
drops a genuine, well-formed update rather than one a helper quietly malformed.

Envelope, from `y-protocols`:

    [varuint messageType] ...            0 = sync, 1 = awareness
    sync: [varuint syncType] [varuint8array payload]
          0 = step1 (state vector), 1 = step2 (update), 2 = update
"""

MESSAGE_SYNC = 0
MESSAGE_AWARENESS = 1

SYNC_STEP1 = 0
SYNC_STEP2 = 1
SYNC_UPDATE = 2


def write_varuint(value: int) -> bytes:
    out = bytearray()
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out.append(byte | 0x80)
        else:
            out.append(byte)
            return bytes(out)


def read_varuint(data: bytes, pos: int = 0) -> tuple[int, int]:
    """Return (value, next_position)."""
    value = 0
    shift = 0
    while True:
        if pos >= len(data):
            raise ValueError("truncated varuint")
        byte = data[pos]
        pos += 1
        value |= (byte & 0x7F) << shift
        if not byte & 0x80:
            return value, pos
        shift += 7


def _var_bytes(payload: bytes) -> bytes:
    return write_varuint(len(payload)) + payload


def sync_step1(state_vector: bytes) -> bytes:
    return write_varuint(MESSAGE_SYNC) + write_varuint(SYNC_STEP1) + _var_bytes(state_vector)


def sync_step2(update: bytes) -> bytes:
    return write_varuint(MESSAGE_SYNC) + write_varuint(SYNC_STEP2) + _var_bytes(update)


def sync_update(update: bytes) -> bytes:
    return write_varuint(MESSAGE_SYNC) + write_varuint(SYNC_UPDATE) + _var_bytes(update)


def parse(message: bytes) -> tuple[int, int | None, bytes]:
    """Return (message_type, sync_type or None, payload)."""
    message_type, pos = read_varuint(message)
    if message_type != MESSAGE_SYNC:
        return message_type, None, message[pos:]
    sync_type, pos = read_varuint(message, pos)
    length, pos = read_varuint(message, pos)
    return message_type, sync_type, message[pos : pos + length]


def _var_string(text: str) -> bytes:
    return _var_bytes(text.encode())


def awareness(client_id: int, clock: int, state: str) -> bytes:
    """One client's awareness entry, in the y-protocols envelope.

    `state` is the JSON the client publishes, or the literal "null" for a client
    announcing that it has left.
    """
    update = write_varuint(1) + write_varuint(client_id) + write_varuint(clock) + _var_string(state)
    return write_varuint(MESSAGE_AWARENESS) + _var_bytes(update)


def read_awareness(message: bytes) -> dict[int, str]:
    """The states in an awareness message, by client id."""
    message_type, pos = read_varuint(message)
    if message_type != MESSAGE_AWARENESS:
        raise ValueError("not an awareness message")
    length, pos = read_varuint(message, pos)
    payload = message[pos : pos + length]

    count, pos = read_varuint(payload)
    states: dict[int, str] = {}
    for _ in range(count):
        client_id, pos = read_varuint(payload, pos)
        _clock, pos = read_varuint(payload, pos)
        size, pos = read_varuint(payload, pos)
        states[client_id] = payload[pos : pos + size].decode()
        pos += size
    return states
