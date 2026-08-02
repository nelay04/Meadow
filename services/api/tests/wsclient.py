"""Helpers for driving the board websocket from tests."""

from typing import Any

import pytest
from pycrdt import Doc, Map
from starlette.testclient import TestClient, WebSocketDisconnect

from tests import ywire
from tests.conftest import Actor

WS_UNAUTHORIZED = 4401
WS_FORBIDDEN = 4403
WS_ROOM_FULL = 4429


def ws_url(board_id: str, token: str) -> str:
    return f"/ws/board/{board_id}?token={token}"


def expect_close(client: TestClient, board_id: str, token: str) -> int:
    """Connect and return the close code the server rejects with.

    The server accepts before it validates, so the rejection surfaces on the first
    receive rather than at connect time.
    """
    with (
        pytest.raises(WebSocketDisconnect) as excinfo,
        client.websocket_connect(ws_url(board_id, token)) as websocket,
    ):
        websocket.receive_bytes()
    return int(excinfo.value.code)


def drain_until_update(websocket: Any) -> bytes:
    """Read until the server answers our step 1, so we know it processed our sends."""
    for _ in range(20):
        _, sync_type, payload = ywire.parse(websocket.receive_bytes())
        if sync_type in (ywire.SYNC_STEP2, ywire.SYNC_UPDATE):
            return payload
    raise AssertionError("server never answered sync step 1")


def make_update(**objects: dict[str, Any]) -> bytes:
    """A genuine Yjs update adding objects to the flat `objects` map."""
    doc = Doc()
    doc["objects"] = root = Map()
    for key, value in objects.items():
        root[key] = value
    return bytes(doc.get_update())


def write_object(
    client: TestClient, actor: Actor, board_id: str, **objects: dict[str, Any]
) -> None:
    """Connect, push an update, wait for the server to acknowledge, disconnect."""
    with client.websocket_connect(
        ws_url(board_id, actor.ws_token(board_id)["token"])
    ) as websocket:
        websocket.send_bytes(ywire.sync_update(make_update(**objects)))
        websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(websocket)


def board_objects(client: TestClient, actor: Actor, board_id: str) -> dict[str, Any]:
    """Reconnect from scratch and read the document the server actually holds."""
    doc = Doc()
    doc["objects"] = objects = Map()

    with client.websocket_connect(
        ws_url(board_id, actor.ws_token(board_id)["token"])
    ) as websocket:
        websocket.send_bytes(ywire.sync_step1(doc.get_state()))
        update = drain_until_update(websocket)
        if update:
            doc.apply_update(update)

    return dict(objects)
