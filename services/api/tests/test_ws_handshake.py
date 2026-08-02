"""The websocket handshake is the security boundary (ARCHITECTURE 6).

These five tests were written before the implementation, and are the reason M1 exists
in the shape it does. REST permission checks are decorative if any of them fail.

Close codes:
    4401  the credential is bad - forged, expired, or already spent
    4403  the credential is good but does not authorise this board
"""

import time
import uuid

import pytest
from pycrdt import Doc, Map
from starlette.testclient import TestClient, WebSocketDisconnect

from tests import ywire
from tests.conftest import Actor
from tests.wsclient import (
    WS_FORBIDDEN,
    WS_UNAUTHORIZED,
    board_objects,
    drain_until_update,
    expect_close,
    ws_url,
)


def test_valid_token_but_no_membership_is_forbidden(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """A real user, a real board, their own correctly signed token, and no access.

    Both gates, because neither alone is enough. Minting refuses a board the caller
    cannot open. The handshake refuses a token minted while they still could - the
    60s lifetime is a window in which access can be revoked, and a ws-token is bound
    to an identity, so it grants whatever that identity has *now*, not at mint time.
    """
    board_id = owner.create_board()

    denied = client.post(
        "/api/v1/ws-token", json={"board_id": board_id}, headers=outsider.auth
    )
    assert denied.status_code == 403, "minting must resolve the role too, not just the handshake"

    granted = client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )
    assert granted.status_code == 201, granted.text
    token = outsider.ws_token(board_id)["token"]

    revoked = client.delete(
        f"/api/v1/boards/{board_id}/members/{outsider.user_id}", headers=owner.auth
    )
    assert revoked.status_code == 204, revoked.text

    assert expect_close(client, board_id, token) == WS_FORBIDDEN


def test_token_minted_for_another_board_is_forbidden(client: TestClient, owner: Actor) -> None:
    """Board scope is per-token. Access to A must not carry over to B.

    4403 and not 4401: the token is authentic and unexpired, it simply does not
    authorise this board. Treating it as an authentication failure would tell a caller
    holding a valid token to go and refresh it, which cannot help.
    """
    board_a = owner.create_board("A")
    board_b = owner.create_board("B")

    token_for_a = owner.ws_token(board_a)["token"]
    assert expect_close(client, board_b, token_for_a) == WS_FORBIDDEN


def test_board_deleted_between_mint_and_connect_is_forbidden(
    client: TestClient, owner: Actor
) -> None:
    """The 60s token lifetime is a window where the board can disappear.

    Role resolution has to happen at connect time against current state. A token
    minted a moment ago is not evidence the board still exists.
    """
    board_id = owner.create_board()
    token = owner.ws_token(board_id)["token"]

    deleted = client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)
    assert deleted.status_code == 204, deleted.text

    assert expect_close(client, board_id, token) == WS_FORBIDDEN


def test_room_closes_when_the_access_token_expires_mid_session(
    client: TestClient, owner: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A live socket must not outlive the session that authorised it.

    Without this the handshake is a one-time check and a connection held open for days
    keeps whatever role it was granted on day one. The watchdog wakes at the earlier of
    the revalidation interval and the access token's own expiry.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "access_token_ttl_seconds", 2)
    monkeypatch.setattr(settings, "ws_revalidate_interval_seconds", 1)

    owner.login()  # re-issue the access token under the shortened TTL
    board_id = owner.create_board()
    token = owner.ws_token(board_id)["token"]

    started = time.monotonic()
    with (
        pytest.raises(WebSocketDisconnect) as excinfo,
        client.websocket_connect(ws_url(board_id, token)) as websocket,
    ):
        # Drains the server's opening sync, then blocks until the watchdog closes.
        while True:
            websocket.receive_bytes()

    elapsed = time.monotonic() - started
    assert excinfo.value.code == WS_UNAUTHORIZED
    assert elapsed < 10, "watchdog did not fire promptly"


def test_viewer_updates_are_dropped_and_the_role_is_reported(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Both halves of the viewer story, which have to ship together (ARCHITECTURE 6).

    Server-side dropping alone gives a viewer edits that appear, persist locally, and
    vanish on reload. So the client is told its role and refuses the write up front,
    and the server drop is the backstop for a tampered client.
    """
    board_id = owner.create_board()
    granted = client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )
    assert granted.status_code == 201, granted.text

    minted = outsider.ws_token(board_id)
    assert minted["role"] == "viewer", "the client cannot disable its tools without this"

    # A genuine, well-formed update - the kind an editor's client would send.
    forged = Doc()
    forged["objects"] = objects = Map()
    objects["viewer-obj"] = {"id": "viewer-obj", "type": "rect", "x": 10, "y": 10}

    with client.websocket_connect(ws_url(board_id, minted["token"])) as websocket:
        websocket.send_bytes(ywire.sync_update(forged.get_update()))
        websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(websocket)

    assert board_objects(client, owner, board_id) == {}, "viewer write reached the document"


def test_a_viewer_write_never_reaches_the_live_room(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Not persisted is not enough: it must never enter the server's in-memory doc.

    A drop applied only on the persistence path would still broadcast the edit to
    everyone currently connected, who would watch it appear and then disappear on
    their next reload. So this reads the live room while the viewer is still attached,
    rather than reading Postgres after everyone has left.

    (Worth knowing when testing this by hand: two y-websocket clients in one process
    sync through lib0's BroadcastChannel behind the server's back, which looks exactly
    like a failed drop. Real browsers only share it between tabs of the same user, who
    necessarily hold the same role.)
    """
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )

    forged = Doc()
    forged["objects"] = objects = Map()
    objects["viewer-obj"] = {"id": "viewer-obj", "type": "rect"}

    editor_token = owner.ws_token(board_id)["token"]
    viewer_token = outsider.ws_token(board_id)["token"]

    with (
        client.websocket_connect(ws_url(board_id, editor_token)) as editor,
        client.websocket_connect(ws_url(board_id, viewer_token)) as viewer,
    ):
        viewer.send_bytes(ywire.sync_update(forged.get_update()))

        # Ask the still-running room for its whole state.
        seen = Doc()
        seen["objects"] = seen_objects = Map()
        editor.send_bytes(ywire.sync_step1(seen.get_state()))
        update = drain_until_update(editor)
        if update:
            seen.apply_update(update)

    assert dict(seen_objects) == {}, "viewer write entered the live room doc"


def test_editor_updates_are_kept(client: TestClient, owner: Actor) -> None:
    """The control for the test above: same path, writable role, update survives.

    Without this, a handshake that dropped every inbound update would pass the viewer
    test perfectly.
    """
    board_id = owner.create_board()
    assert owner.ws_token(board_id)["role"] == "owner"

    doc = Doc()
    doc["objects"] = objects = Map()
    objects["owner-obj"] = {"id": "owner-obj", "type": "rect", "x": 1, "y": 2}

    with client.websocket_connect(ws_url(board_id, owner.ws_token(board_id)["token"])) as websocket:
        websocket.send_bytes(ywire.sync_update(doc.get_update()))
        websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(websocket)

    assert "owner-obj" in board_objects(client, owner, board_id)


def test_unknown_board_is_forbidden_not_found(client: TestClient, owner: Actor) -> None:
    """Never distinguish "no access" from "no such board" over the socket."""
    token = owner.ws_token(owner.create_board())["token"]
    assert expect_close(client, str(uuid.uuid4()), token) == WS_FORBIDDEN
