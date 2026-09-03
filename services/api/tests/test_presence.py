"""Presence, and specifically what a client is told when it arrives.

The room relays awareness and does not replay it, so without a snapshot on join a
client learns who else is here only when one of them next speaks - up to fifteen
seconds of an apparently empty board. That is the whole window on an ordinary join and
it is every eviction the app performs on purpose, because an eviction is a reconnect
and the reconnecting client drops every remote cursor it knew.
"""

import json

from starlette.testclient import TestClient

from tests import ywire
from tests.conftest import Actor
from tests.wsclient import ws_url

#: The awareness client ids the two test clients announce themselves under. Arbitrary,
#: and unrelated to the y-doc client ids a browser would use.
FIRST = 7
SECOND = 9


def _presence_seen_by(websocket: object) -> dict[int, str]:
    """Every awareness state this client is told about, up to its own echo.

    The room relays a client's own awareness back to it, which gives the read loop a
    terminator it can count on. Without one this would have to guess a frame count and
    then block forever on a server that had nothing more to say - a hang rather than a
    failure, which is not a test.
    """
    websocket.send_bytes(ywire.awareness(SECOND, 1, json.dumps({"user": {"name": "second"}})))  # type: ignore[attr-defined]

    seen: dict[int, str] = {}
    for _ in range(12):
        message = websocket.receive_bytes()  # type: ignore[attr-defined]
        if not message or message[0] != ywire.MESSAGE_AWARENESS:
            continue
        states = ywire.read_awareness(message)
        seen.update(states)
        if SECOND in states:
            return seen
    return seen


def test_a_joining_client_is_told_who_is_already_here(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    with client.websocket_connect(
        ws_url(board_id, owner.ws_token(board_id)["token"])
    ) as first:
        first.receive_bytes()  # the room's sync step 1
        first.send_bytes(ywire.awareness(FIRST, 1, json.dumps({"user": {"name": "first"}})))
        # The serve loop handles one message at a time, so an answer to a later sync
        # request proves the awareness ahead of it was applied.
        first.send_bytes(ywire.sync_step1(b"\x00"))
        first.receive_bytes()

        with client.websocket_connect(
            ws_url(board_id, outsider.ws_token(board_id)["token"])
        ) as second:
            states = _presence_seen_by(second)

    assert FIRST in states, "the second client was not told about the first"
    assert json.loads(states[FIRST])["user"]["name"] == "first"


def test_an_empty_room_sends_no_snapshot(client: TestClient, owner: Actor) -> None:
    """Nobody to describe, nothing to say. The first frame is the room's sync message."""
    board_id = owner.create_board()

    with client.websocket_connect(
        ws_url(board_id, owner.ws_token(board_id)["token"])
    ) as websocket:
        first = websocket.receive_bytes()

    assert first[0] == ywire.MESSAGE_SYNC
