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

from collections.abc import Callable
from dataclasses import dataclass, field
from logging import Logger
from typing import Any

from fastapi import WebSocket
from pycrdt import Array, Doc, Map

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


# --- fine-grained access tokens: edit and delete, apart ---------------------------------


def _sync_update(message: bytes) -> bytes | None:
    """The update carried by a sync step 2 or sync update message, or None for anything else."""
    try:
        message_type, pos = _read_varuint(message, 0)
        if message_type != MESSAGE_SYNC:
            return None
        sync_type, pos = _read_varuint(message, pos)
        if sync_type not in (SYNC_STEP2, SYNC_UPDATE):
            return None
        length, pos = _read_varuint(message, pos)
    except ValueError:
        return None
    payload = message[pos : pos + length]
    return payload if len(payload) == length else None


@dataclass
class Effect:
    """What one update would do to a board, in the two terms a grant is made of."""

    #: Objects taken off the board, by id.
    removed: set[str] = field(default_factory=set)
    #: Anything that is not a removal or its tidy-up: an object added, a field or a
    #: letter changed, the stacking order rebuilt, the board's settings touched.
    edits: bool = False
    #: The tidy-up a removal brings with it: the removed object's place in the stacking
    #: order, its arrows' bindings, and arrow ends that pointed at it set free.
    cleanup: bool = False


def effect_of(board_state: bytes, update: bytes) -> Effect:
    """Replay an update on a copy of the board and report what it changed.

    A copy, because a Y.Doc has no rollback: once an update is applied to the room it is
    applied for everybody, so the question has to be asked before. The copy is rebuilt
    from the room's state for every message, which costs a board's worth of decoding
    per write. That is paid only on connections through a fine-grained token that
    splits edit from delete, which is an agent making a handful of writes, never a
    browser.
    """
    # Any-typed: the copy only relays what a peer wrote, and never reads a value back out.
    shadow: Doc[Any] = Doc()
    objects: Map[Any] = Map()
    bindings: Map[Any] = Map()
    order: Array[Any] = Array()
    meta: Map[Any] = Map()
    shadow["objects"] = objects
    shadow["bindings"] = bindings
    shadow["order"] = order
    shadow["meta"] = meta
    shadow.apply_update(board_state)

    effect = Effect()

    def on_objects(events: list[Any]) -> None:
        for event in events:
            if list(event.path):
                effect.edits = True
                continue
            for key, change in event.keys.items():
                if change["action"] == "delete":
                    effect.removed.add(str(key))
                else:
                    effect.edits = True

    def on_bindings(events: list[Any]) -> None:
        for event in events:
            path = list(event.path)
            if not path:
                for change in event.keys.values():
                    if change["action"] == "delete":
                        effect.cleanup = True
                    else:
                        effect.edits = True
                continue
            freed = len(path) == 1 and all(
                key == "targetId" and change["action"] == "update" and change["newValue"] is None
                for key, change in event.keys.items()
            )
            if freed:
                effect.cleanup = True
            else:
                effect.edits = True

    def on_order(events: list[Any]) -> None:
        for event in events:
            for step in event.delta:
                if "insert" in step:
                    effect.edits = True
                elif "delete" in step:
                    effect.cleanup = True

    def on_meta(events: list[Any]) -> None:
        if events:
            effect.edits = True

    objects.observe_deep(on_objects)
    bindings.observe_deep(on_bindings)
    order.observe_deep(on_order)
    meta.observe_deep(on_meta)
    shadow.apply_update(update)
    return effect


def allowed(effect: Effect, *, can_edit: bool, can_delete: bool) -> bool:
    """Whether a grant permits this effect, whole. Part of an update is never applied."""
    if effect.removed and not can_delete:
        return False
    if effect.edits and not can_edit:
        return False
    # Tidy-up on its own, with nothing removed, is taking an object out of the stacking
    # order or unbinding an arrow, which is an edit.
    return not (effect.cleanup and not effect.removed and not can_edit)


class GrantedChannel(FastAPIChannel):
    """A writable channel that holds a fine-grained token to exactly its grant.

    For a token that may edit but not delete, or delete but not edit. Every document
    write is replayed on a copy of the board first (`effect_of`) and dropped whole if it
    does anything the grant does not allow. Silently, as `ReadOnlyChannel` drops a
    viewer's writes, and for its reason: a well-behaved client (the MCP server) refuses
    first and never sends one, so a drop here is a tampered client, and an error frame
    would tell it exactly what is filtered.

    Awareness and sync requests pass untouched.
    """

    def __init__(
        self,
        websocket: WebSocket,
        path: str,
        log: Logger,
        board: Callable[[], bytes],
        *,
        can_edit: bool,
        can_delete: bool,
    ) -> None:
        super().__init__(websocket, path)
        self._log = log
        self._board = board
        self._can_edit = can_edit
        self._can_delete = can_delete
        self.dropped = 0

    async def recv(self) -> bytes:
        while True:
            message = await super().recv()
            update = _sync_update(message)
            if update is None:
                return message
            try:
                effect = effect_of(self._board(), update)
            except Exception:  # noqa: BLE001 - an update the copy cannot read is not let through
                effect = Effect(edits=True, removed={"?"})
            if allowed(effect, can_edit=self._can_edit, can_delete=self._can_delete):
                return message
            self.dropped += 1
            self._log.info(
                "dropped a write outside its token grant on board %s (%d so far)",
                self.path,
                self.dropped,
            )
