"""Personal access tokens: the credential an MCP client or a script holds.

Written before the implementation, because a token that can reach a board is an auth
change and the working agreement puts the test first.

The rules these pin down:

* A token can only ever *narrow* what its owner may do. `resolve_access` still decides
  the role; a read-scoped token turns writing off on top of that, and a board allow-list
  shuts every other board. Nothing about a token raises anybody.
* It is accepted on an explicit handful of routes and refused everywhere else. A new
  route does not become reachable by a leaked token by being written.
* It never manages accounts: it cannot mint, list or revoke tokens, and it cannot end
  sessions. Stealing one must not be a way to keep one.
* Revoked or expired means refused at the REST layer, at the ws-token mint, at the
  handshake, and on a socket that is already open.
"""

import asyncio
import time
import uuid
from typing import Any

import asyncpg
import pytest
from pycrdt import Doc, Map
from starlette.testclient import TestClient, WebSocketDisconnect

from tests import ywire
from tests.conftest import TEST_DATABASE_URL, Actor, _asyncpg_dsn
from tests.wsclient import (
    WS_FORBIDDEN,
    WS_UNAUTHORIZED,
    board_objects,
    drain_until_update,
    expect_close,
    ws_url,
)


def _mint(
    client: TestClient,
    actor: Actor,
    *,
    scope: str = "write",
    board_ids: list[str] | None = None,
    expires_in_days: int | None = None,
    name: str = "Claude Code",
) -> dict[str, Any]:
    body: dict[str, Any] = {"name": name, "scope": scope}
    if board_ids is not None:
        body["board_ids"] = board_ids
    if expires_in_days is not None:
        body["expires_in_days"] = expires_in_days
    response = client.post("/api/v1/tokens", json=body, headers=actor.auth)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def _as_token(client: TestClient, actor: Actor, raw: str) -> Actor:
    """The same account, presenting the access token instead of a session."""
    holder = Actor(client, actor.email, actor.password)
    holder.access_token = raw
    holder.user_id = actor.user_id
    holder.workspace_id = actor.workspace_id
    return holder


def _write(client: TestClient, token: str, board_id: str, key: str) -> None:
    doc = Doc()
    doc["objects"] = objects = Map()
    objects[key] = {"id": key, "type": "rect", "x": 0, "y": 0}
    with client.websocket_connect(ws_url(board_id, token)) as websocket:
        websocket.send_bytes(ywire.sync_update(doc.get_update()))
        websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(websocket)


def _sql(statement: str, *args: Any) -> None:
    async def run() -> None:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            await conn.execute(statement, *args)
        finally:
            await conn.close()

    asyncio.run(run())


# --- issuing ---------------------------------------------------------------------------


def test_the_secret_is_shown_once_and_never_listed(client: TestClient, owner: Actor) -> None:
    created = _mint(client, owner)
    raw = created["token"]
    assert raw.startswith("mdw_"), "a recognisable prefix is what lets secret scanners find it"
    assert created["prefix"] == raw[: len(created["prefix"])]

    listed = client.get("/api/v1/tokens", headers=owner.auth)
    assert listed.status_code == 200, listed.text
    [row] = listed.json()
    assert row["id"] == created["id"]
    assert row["name"] == "Claude Code"
    assert row["scope"] == "write"
    assert "token" not in row, "the list must never carry the secret"
    assert raw not in listed.text


def test_tokens_are_private_to_their_owner(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    created = _mint(client, owner)
    assert client.get("/api/v1/tokens", headers=outsider.auth).json() == []

    # 404, not 403: the statement is scoped to the caller, as the sessions route is.
    stolen = client.delete(f"/api/v1/tokens/{created['id']}", headers=outsider.auth)
    assert stolen.status_code == 404

    still = client.get("/api/v1/boards", headers=_as_token(client, owner, created["token"]).auth)
    assert still.status_code == 200


def test_a_board_allow_list_may_only_name_boards_the_owner_can_open(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Otherwise the allow-list is a way to learn which board ids exist."""
    foreign = outsider.create_board()
    response = client.post(
        "/api/v1/tokens",
        json={"name": "sneaky", "scope": "read", "board_ids": [foreign]},
        headers=owner.auth,
    )
    assert response.status_code == 403, response.text


# --- where a token is accepted ---------------------------------------------------------


def test_a_token_reads_boards_and_mints_ws_tokens(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board("Launch plan")
    holder = _as_token(client, owner, _mint(client, owner)["token"])

    listed = client.get("/api/v1/boards", headers=holder.auth)
    assert listed.status_code == 200, listed.text
    assert [board["id"] for board in listed.json()] == [board_id]

    one = client.get(f"/api/v1/boards/{board_id}", headers=holder.auth)
    assert one.status_code == 200, one.text

    me = client.get("/api/v1/auth/me", headers=holder.auth)
    assert me.status_code == 200, me.text
    assert me.json()["id"] == owner.user_id

    minted = holder.ws_token(board_id)
    assert minted["can_write"] is True


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/v1/tokens"),
        ("get", "/api/v1/tokens"),
        ("get", "/api/v1/auth/sessions"),
        ("delete", "/api/v1/auth/sessions"),
        ("patch", "/api/v1/auth/me"),
        ("patch", "/api/v1/boards/{board}"),
        ("delete", "/api/v1/boards/{board}"),
        ("put", "/api/v1/boards/{board}/share"),
        ("get", "/api/v1/boards/{board}/members"),
        ("get", "/api/v1/workspaces"),
    ],
)
def test_a_token_is_refused_everywhere_it_was_not_let_in(
    client: TestClient, owner: Actor, method: str, path: str
) -> None:
    """Fail closed: the routes a token reaches are named, and these are not among them.

    401 rather than 403, because the problem is the credential and not the board: the
    same person with a session would be let in.
    """
    board_id = owner.create_board()
    holder = _as_token(client, owner, _mint(client, owner)["token"])
    response = client.request(
        method,
        path.format(board=board_id),
        headers=holder.auth,
        json={"name": "x", "scope": "write", "title": "x", "mode": "public", "role": "viewer"},
    )
    assert response.status_code == 401, f"{method} {path}: {response.status_code} {response.text}"

    # And the session still works there, or the test proves nothing.
    assert client.get("/api/v1/tokens", headers=owner.auth).status_code == 200


def test_a_malformed_token_is_unauthorised(client: TestClient) -> None:
    response = client.get("/api/v1/boards", headers={"Authorization": "Bearer mdw_nope"})
    assert response.status_code == 401


# --- scope narrows, never widens -------------------------------------------------------


def test_a_read_token_cannot_write_even_for_the_owner(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    holder = _as_token(client, owner, _mint(client, owner, scope="read")["token"])

    minted = holder.ws_token(board_id)
    assert minted["role"] == "owner", "the role is still the account's"
    assert minted["can_write"] is False, "the client disables its tools from this"

    # The backstop: a tampered client that writes anyway is dropped at the socket.
    _write(client, minted["token"], board_id, "from-read-token")
    assert board_objects(client, owner, board_id) == {}

    created = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "nope"},
        headers=holder.auth,
    )
    assert created.status_code == 403, created.text


def test_a_write_token_writes(client: TestClient, owner: Actor) -> None:
    """The control for the test above."""
    board_id = owner.create_board()
    holder = _as_token(client, owner, _mint(client, owner, scope="write")["token"])
    _write(client, holder.ws_token(board_id)["token"], board_id, "from-write-token")
    assert "from-write-token" in board_objects(client, owner, board_id)

    created = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "made by an agent"},
        headers=holder.auth,
    )
    assert created.status_code == 201, created.text


def test_a_write_token_does_not_raise_a_viewer(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    granted = client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )
    assert granted.status_code == 201, granted.text

    holder = _as_token(client, outsider, _mint(client, outsider, scope="write")["token"])
    minted = holder.ws_token(board_id)
    assert minted["role"] == "viewer"
    assert minted["can_write"] is False

    _write(client, minted["token"], board_id, "viewer-via-token")
    assert board_objects(client, owner, board_id) == {}


# --- the board allow-list --------------------------------------------------------------


def test_a_board_scoped_token_sees_and_opens_only_its_boards(
    client: TestClient, owner: Actor
) -> None:
    allowed = owner.create_board("allowed")
    other = owner.create_board("other")
    created = _mint(client, owner, board_ids=[allowed])
    holder = _as_token(client, owner, created["token"])

    listed = client.get("/api/v1/boards", headers=holder.auth).json()
    assert [board["id"] for board in listed] == [allowed]

    assert client.get(f"/api/v1/boards/{other}", headers=holder.auth).status_code == 403
    denied = client.post("/api/v1/ws-token", json={"board_id": other}, headers=holder.auth)
    assert denied.status_code == 403

    # A board-scoped token cannot create boards: the new one would not be on its list,
    # and quietly adding it would be a token widening itself.
    made = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "x"},
        headers=holder.auth,
    )
    assert made.status_code == 403, made.text


def test_the_handshake_checks_the_allow_list_too(client: TestClient, owner: Actor) -> None:
    """Minting is one gate and the handshake is the other; neither alone is enough.

    A ws-token for the wrong board cannot come out of the mint, so this signs one
    directly - the handshake must not trust that the mint was the only way to get one.
    """
    from app.config import settings
    from app.realtime import wstoken

    allowed = owner.create_board("allowed")
    other = owner.create_board("other")
    created = _mint(client, owner, board_ids=[allowed])

    token = wstoken.mint(
        other,
        uuid.UUID(owner.user_id),
        int(time.time()) + settings.access_token_ttl_seconds,
        api_token_id=uuid.UUID(created["id"]),
    )
    assert expect_close(client, other, token) == WS_FORBIDDEN


# --- revocation and expiry -------------------------------------------------------------


def test_a_revoked_token_is_refused_everywhere(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _mint(client, owner)
    holder = _as_token(client, owner, created["token"])

    # Minted while the token was good, used after it was revoked.
    ws = holder.ws_token(board_id)["token"]

    revoked = client.delete(f"/api/v1/tokens/{created['id']}", headers=owner.auth)
    assert revoked.status_code == 204, revoked.text

    assert client.get("/api/v1/boards", headers=holder.auth).status_code == 401
    denied = client.post("/api/v1/ws-token", json={"board_id": board_id}, headers=holder.auth)
    assert denied.status_code == 401
    assert expect_close(client, board_id, ws) == WS_UNAUTHORIZED

    listed = client.get("/api/v1/tokens", headers=owner.auth).json()
    assert listed == [], "a revoked token leaves the list"


def test_an_expired_token_is_refused(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _mint(client, owner, expires_in_days=30)
    holder = _as_token(client, owner, created["token"])
    ws = holder.ws_token(board_id)["token"]

    _sql(
        "update api_tokens set expires_at = now() - interval '1 second' where id = $1",
        uuid.UUID(created["id"]),
    )

    assert client.get("/api/v1/boards", headers=holder.auth).status_code == 401
    assert expect_close(client, board_id, ws) == WS_UNAUTHORIZED


def test_revoking_a_token_closes_the_sockets_it_opened(client: TestClient, owner: Actor) -> None:
    """An agent holding a board open must not keep editing for fifteen minutes."""
    board_id = owner.create_board()
    created = _mint(client, owner)
    holder = _as_token(client, owner, created["token"])

    with (
        pytest.raises(WebSocketDisconnect) as excinfo,
        client.websocket_connect(ws_url(board_id, holder.ws_token(board_id)["token"])) as ws,
    ):
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)
        revoked = client.delete(f"/api/v1/tokens/{created['id']}", headers=owner.auth)
        assert revoked.status_code == 204
        while True:
            ws.receive_bytes()

    assert excinfo.value.code == WS_UNAUTHORIZED


def test_a_session_socket_is_not_closed_by_revoking_a_token(
    client: TestClient, owner: Actor
) -> None:
    """The control: eviction is by token, not by account."""
    board_id = owner.create_board()
    created = _mint(client, owner)

    with client.websocket_connect(ws_url(board_id, owner.ws_token(board_id)["token"])) as ws:
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)
        client.delete(f"/api/v1/tokens/{created['id']}", headers=owner.auth)
        doc = Doc()
        doc["objects"] = objects = Map()
        objects["still-here"] = {"id": "still-here", "type": "rect"}
        ws.send_bytes(ywire.sync_update(doc.get_update()))
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)

    assert "still-here" in board_objects(client, owner, board_id)


def test_using_a_token_records_when(client: TestClient, owner: Actor) -> None:
    created = _mint(client, owner)
    assert client.get("/api/v1/tokens", headers=owner.auth).json()[0]["last_used_at"] is None
    client.get("/api/v1/boards", headers=_as_token(client, owner, created["token"]).auth)
    assert client.get("/api/v1/tokens", headers=owner.auth).json()[0]["last_used_at"] is not None


def test_deleting_the_account_ends_its_tokens(client: TestClient, owner: Actor) -> None:
    created = _mint(client, owner)
    _sql("delete from users where id = $1", uuid.UUID(owner.user_id))
    response = client.get("/api/v1/boards", headers=_as_token(client, owner, created["token"]).auth)
    assert response.status_code == 401
