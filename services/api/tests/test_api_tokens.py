"""Personal access tokens: the credential an MCP client or a script holds.

Written before the implementation, because a token that can reach a board is an auth
change and the working agreement puts the test first.

Two kinds, as GitHub has them:

* **classic** - everything the account can do, on every glade it can open.
* **fine-grained** - named glades only, each with its own permissions: `read`, `edit`
  and `delete`. Edit and delete both need read. A glade that is not named does not exist
  as far as the token is concerned.

The rules these pin down:

* A token only ever *narrows* its owner. The role is still resolved live; a grant takes
  away from it and never adds. A viewer's edit grant edits nothing.
* The boundary is the server, not the client. A fine-grained token without `delete`
  cannot remove objects even by writing raw Yjs updates to the socket, and one without
  `edit` cannot change anything except removing objects.
* A token is accepted on a named handful of routes and refused everywhere else, and it
  never manages tokens or sessions.
* Revoked, expired, or changed means refused, including on a socket already open.
"""

import asyncio
import time
import uuid
from typing import Any

import asyncpg
import pytest
from pycrdt import Array, Doc, Map
from starlette.testclient import TestClient, WebSocketDisconnect

from tests import ywire
from tests.conftest import TEST_DATABASE_URL, Actor, _asyncpg_dsn
from tests.wsclient import (
    WS_FORBIDDEN,
    WS_UNAUTHORIZED,
    drain_until_update,
    expect_close,
    ws_url,
)


def _mint(client: TestClient, actor: Actor, body: dict[str, Any]) -> dict[str, Any]:
    response = client.post("/api/v1/tokens", json={"name": "agent", **body}, headers=actor.auth)
    assert response.status_code == 201, response.text
    created: dict[str, Any] = response.json()
    return created


def _classic(client: TestClient, actor: Actor, **extra: Any) -> dict[str, Any]:
    return _mint(client, actor, {"kind": "classic", **extra})


def _fine(
    client: TestClient, actor: Actor, grants: dict[str, set[str]], **extra: Any
) -> dict[str, Any]:
    return _mint(
        client,
        actor,
        {
            "kind": "fine_grained",
            "grants": [
                {
                    "board_id": board_id,
                    "read": "read" in perms,
                    "edit": "edit" in perms,
                    "delete": "delete" in perms,
                }
                for board_id, perms in grants.items()
            ],
            **extra,
        },
    )


def _as_token(client: TestClient, actor: Actor, raw: str) -> Actor:
    """The same account, presenting the access token instead of a session."""
    holder = Actor(client, actor.email, actor.password)
    holder.access_token = raw
    holder.user_id = actor.user_id
    holder.workspace_id = actor.workspace_id
    return holder


def _sql(statement: str, *args: Any) -> None:
    async def run() -> None:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            await conn.execute(statement, *args)
        finally:
            await conn.close()

    asyncio.run(run())


# --- the document, over the socket -----------------------------------------------------


def _doc() -> tuple[Doc, Map, Map, Array]:
    doc = Doc()
    doc["objects"] = objects = Map()
    doc["bindings"] = bindings = Map()
    doc["order"] = order = Array()
    doc["meta"] = Map()
    return doc, objects, bindings, order


def _sync(websocket: Any, doc: Doc) -> None:
    websocket.send_bytes(ywire.sync_step1(doc.get_state()))
    update = drain_until_update(websocket)
    if update:
        doc.apply_update(update)


def _read(client: TestClient, actor: Actor, board_id: str) -> dict[str, Any]:
    doc, objects, _, _ = _doc()
    with client.websocket_connect(ws_url(board_id, actor.ws_token(board_id)["token"])) as ws:
        _sync(ws, doc)
    return {key: dict(value) for key, value in objects.items()}


def _seed(client: TestClient, owner: Actor, board_id: str, *keys: str) -> None:
    doc, objects, _, order = _doc()
    with client.websocket_connect(ws_url(board_id, owner.ws_token(board_id)["token"])) as ws:
        _sync(ws, doc)
        before = doc.get_state()
        with doc.transaction():
            for key in keys:
                objects[key] = Map({"id": key, "type": "rect", "x": 0, "y": 0})
                order.append(key)
        ws.send_bytes(ywire.sync_update(doc.get_update(before)))
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)


def _change(client: TestClient, token: str, board_id: str, change: Any) -> None:
    """Connect with a ws-token, apply `change(objects, bindings, order)`, push it."""
    doc, objects, bindings, order = _doc()
    with client.websocket_connect(ws_url(board_id, token)) as ws:
        _sync(ws, doc)
        before = doc.get_state()
        with doc.transaction():
            change(objects, bindings, order)
        ws.send_bytes(ywire.sync_update(doc.get_update(before)))
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)


def _add(key: str) -> Any:
    def change(objects: Map, _bindings: Map, order: Array) -> None:
        objects[key] = Map({"id": key, "type": "rect", "x": 5, "y": 5})
        order.append(key)

    return change


def _move(key: str) -> Any:
    def change(objects: Map, _bindings: Map, _order: Array) -> None:
        objects[key]["x"] = 99

    return change


def _remove(key: str) -> Any:
    def change(objects: Map, _bindings: Map, order: Array) -> None:
        del objects[key]
        for index, value in enumerate(list(order)):
            if value == key:
                del order[index]
                break

    return change


# --- issuing ---------------------------------------------------------------------------


def test_the_secret_is_shown_once_and_never_listed(client: TestClient, owner: Actor) -> None:
    created = _classic(client, owner)
    raw = created["token"]
    assert raw.startswith("mdw_"), "a recognisable prefix is what lets secret scanners find it"
    assert created["prefix"] == raw[: len(created["prefix"])]
    assert created["kind"] == "classic"
    assert created["grants"] is None

    listed = client.get("/api/v1/tokens", headers=owner.auth)
    assert listed.status_code == 200, listed.text
    [row] = listed.json()
    assert row["id"] == created["id"]
    assert "token" not in row, "the list must never carry the secret"
    assert raw not in listed.text


def test_a_fine_grained_token_lists_its_grants_with_titles(
    client: TestClient, owner: Actor
) -> None:
    a = owner.create_board("Alpha")
    c = owner.create_board("Charlie")
    created = _fine(client, owner, {a: {"read", "edit"}, c: {"read", "delete"}})
    assert created["kind"] == "fine_grained"
    grants = {grant["board_id"]: grant for grant in created["grants"]}
    assert grants[a] == {
        "board_id": a,
        "title": "Alpha",
        "read": True,
        "edit": True,
        "delete": False,
    }
    assert grants[c] == {
        "board_id": c,
        "title": "Charlie",
        "read": True,
        "edit": False,
        "delete": True,
    }


@pytest.mark.parametrize(
    "body",
    [
        {"kind": "fine_grained"},
        {"kind": "fine_grained", "grants": []},
        {"kind": "classic", "grants": [{"board_id": str(uuid.uuid4()), "read": True}]},
        {"kind": "fine_grained", "grants": "{board}:edit-without-read"},
        {"kind": "fine_grained", "grants": "{board}:twice"},
        {"kind": "sometimes"},
    ],
)
def test_malformed_token_requests_are_refused(
    client: TestClient, owner: Actor, body: dict[str, Any]
) -> None:
    board = owner.create_board()
    if body.get("grants") == "{board}:edit-without-read":
        body = {**body, "grants": [{"board_id": board, "read": False, "edit": True}]}
    if body.get("grants") == "{board}:twice":
        body = {**body, "grants": [{"board_id": board, "read": True}] * 2}
    response = client.post("/api/v1/tokens", json={"name": "x", **body}, headers=owner.auth)
    assert response.status_code == 422, response.text


def test_a_grant_may_only_name_glades_the_owner_can_open(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Otherwise a grant is a way to learn which board ids exist."""
    foreign = outsider.create_board()
    response = client.post(
        "/api/v1/tokens",
        json={"name": "x", "kind": "fine_grained", "grants": [{"board_id": foreign, "read": True}]},
        headers=owner.auth,
    )
    assert response.status_code == 403, response.text


def test_tokens_are_private_to_their_owner(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    created = _classic(client, owner)
    assert client.get("/api/v1/tokens", headers=outsider.auth).json() == []
    stolen = client.delete(f"/api/v1/tokens/{created['id']}", headers=outsider.auth)
    assert stolen.status_code == 404
    edited = client.patch(
        f"/api/v1/tokens/{created['id']}", json={"name": "mine now"}, headers=outsider.auth
    )
    assert edited.status_code == 404


# --- a token describing itself ---------------------------------------------------------


def test_a_token_can_read_its_own_boundaries(client: TestClient, owner: Actor) -> None:
    """What an MCP server reads so the model knows what it may do before it tries."""
    a = owner.create_board("Alpha")
    created = _fine(client, owner, {a: {"read", "edit"}}, expires_in_days=30)
    holder = _as_token(client, owner, created["token"])

    current = client.get("/api/v1/tokens/current", headers=holder.auth)
    assert current.status_code == 200, current.text
    body = current.json()
    assert body["id"] == created["id"]
    assert body["kind"] == "fine_grained"
    assert body["can_create_glades"] is False
    assert body["expires_at"] is not None
    assert body["grants"] == [
        {"board_id": a, "title": "Alpha", "read": True, "edit": True, "delete": False}
    ]

    classic = _as_token(client, owner, _classic(client, owner)["token"])
    assert client.get("/api/v1/tokens/current", headers=classic.auth).json()["can_create_glades"]

    # A session is not a token and has nothing to describe here.
    assert client.get("/api/v1/tokens/current", headers=owner.auth).status_code == 404


# --- where a token is accepted ---------------------------------------------------------


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("post", "/api/v1/tokens"),
        ("get", "/api/v1/tokens"),
        ("patch", "/api/v1/tokens/{token}"),
        ("delete", "/api/v1/tokens/{token}"),
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
    """Fail closed, for the most powerful kind of token there is."""
    board_id = owner.create_board()
    created = _classic(client, owner)
    holder = _as_token(client, owner, created["token"])
    response = client.request(
        method,
        path.format(board=board_id, token=created["id"]),
        headers=holder.auth,
        json={"name": "x", "kind": "classic", "title": "x", "mode": "public", "role": "viewer"},
    )
    assert response.status_code == 401, f"{method} {path}: {response.status_code} {response.text}"
    assert client.get("/api/v1/tokens", headers=owner.auth).status_code == 200


def test_a_malformed_token_is_unauthorised(client: TestClient) -> None:
    response = client.get("/api/v1/boards", headers={"Authorization": "Bearer mdw_nope"})
    assert response.status_code == 401


# --- classic ---------------------------------------------------------------------------


def test_a_classic_token_does_what_the_account_can(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board("Launch plan")
    _seed(client, owner, board_id, "keep", "doomed")
    holder = _as_token(client, owner, _classic(client, owner)["token"])

    listed = client.get("/api/v1/boards", headers=holder.auth).json()
    assert [(b["id"], b["can_edit"], b["can_delete"]) for b in listed] == [(board_id, True, True)]
    assert client.get("/api/v1/auth/me", headers=holder.auth).json()["id"] == owner.user_id

    minted = holder.ws_token(board_id)
    assert (minted["can_write"], minted["can_edit"], minted["can_delete"]) == (True, True, True)
    _change(client, minted["token"], board_id, _move("keep"))
    _change(client, holder.ws_token(board_id)["token"], board_id, _remove("doomed"))
    objects = _read(client, owner, board_id)
    assert objects["keep"]["x"] == 99
    assert "doomed" not in objects

    made = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "made by an agent"},
        headers=holder.auth,
    )
    assert made.status_code == 201, made.text


def test_a_token_never_raises_a_viewer(client: TestClient, owner: Actor, outsider: Actor) -> None:
    board_id = owner.create_board()
    _seed(client, owner, board_id, "a")
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )
    for created in (
        _classic(client, outsider),
        _fine(client, outsider, {board_id: {"read", "edit", "delete"}}),
    ):
        holder = _as_token(client, outsider, created["token"])
        minted = holder.ws_token(board_id)
        assert minted["role"] == "viewer"
        assert (minted["can_write"], minted["can_edit"], minted["can_delete"]) == (
            False,
            False,
            False,
        )
        _change(client, minted["token"], board_id, _remove("a"))
    assert "a" in _read(client, owner, board_id)


# --- fine-grained: which glades --------------------------------------------------------


def test_a_fine_grained_token_sees_only_its_glades(client: TestClient, owner: Actor) -> None:
    """Five glades, three granted: the other two do not exist for this token."""
    boards = {name: owner.create_board(name) for name in "abcde"}
    created = _fine(
        client,
        owner,
        {
            boards["a"]: {"read", "edit"},
            boards["c"]: {"read", "delete"},
            boards["d"]: {"read", "edit"},
        },
    )
    holder = _as_token(client, owner, created["token"])

    listed = {b["title"]: b for b in client.get("/api/v1/boards", headers=holder.auth).json()}
    assert sorted(listed) == ["a", "c", "d"]
    assert (listed["a"]["can_edit"], listed["a"]["can_delete"]) == (True, False)
    assert (listed["c"]["can_edit"], listed["c"]["can_delete"]) == (False, True)

    for name in "be":
        assert client.get(f"/api/v1/boards/{boards[name]}", headers=holder.auth).status_code == 403
        denied = client.post(
            "/api/v1/ws-token", json={"board_id": boards[name]}, headers=holder.auth
        )
        assert denied.status_code == 403

    made = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "x"},
        headers=holder.auth,
    )
    assert made.status_code == 403, "a fine-grained token without the permission cannot create"


def test_a_fine_grained_token_can_be_allowed_to_create_glades(
    client: TestClient, owner: Actor
) -> None:
    """The create permission, and the grant the new glade comes with.

    A token minted with no glades at all: it can reach nothing until it makes something,
    and then only what it made. That is the whole point of giving an assistant this
    rather than a classic token.
    """
    existing = owner.create_board("Not yours")
    created = _mint(client, owner, {"kind": "fine_grained", "grants": [], "can_create": True})
    assert created["can_create"] is True
    assert created["grants"] == []
    holder = _as_token(client, owner, created["token"])

    assert client.get("/api/v1/tokens/current", headers=holder.auth).json()["can_create_glades"]
    assert client.get("/api/v1/boards", headers=holder.auth).json() == []
    assert client.get(f"/api/v1/boards/{existing}", headers=holder.auth).status_code == 403

    made = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "Made by the agent"},
        headers=holder.auth,
    )
    assert made.status_code == 201, made.text
    board_id = made.json()["id"]

    # The glade it just made is its to work on, fully, and nothing else has changed.
    current = client.get("/api/v1/tokens/current", headers=holder.auth).json()
    assert current["grants"] == [
        {
            "board_id": board_id,
            "title": "Made by the agent",
            "read": True,
            "edit": True,
            "delete": True,
        }
    ]
    assert client.get(f"/api/v1/boards/{board_id}", headers=holder.auth).status_code == 200
    assert client.get(f"/api/v1/boards/{existing}", headers=holder.auth).status_code == 403

    # And it can actually write to it over the socket, which is where a missing grant
    # would show up rather than in the REST answer above.
    _change(client, holder.ws_token(board_id)["token"], board_id, _add("made-it"))
    assert "made-it" in _read(client, owner, board_id)


def test_the_create_permission_can_be_granted_and_taken_away(
    client: TestClient, owner: Actor
) -> None:
    board = owner.create_board("Alpha")
    created = _fine(client, owner, {board: {"read", "edit"}})
    holder = _as_token(client, owner, created["token"])
    assert created["can_create"] is False

    def make(title: str) -> int:
        return client.post(
            "/api/v1/boards",
            json={"workspace_id": owner.workspace_id, "title": title},
            headers=holder.auth,
        ).status_code

    assert make("no") == 403
    granted = client.patch(
        f"/api/v1/tokens/{created['id']}", json={"can_create": True}, headers=owner.auth
    )
    assert granted.status_code == 200, granted.text
    assert granted.json()["can_create"] is True
    assert make("yes") == 201

    taken = client.patch(
        f"/api/v1/tokens/{created['id']}", json={"can_create": False}, headers=owner.auth
    )
    assert taken.status_code == 200, taken.text
    assert make("no again") == 403
    # Taking the permission away does not take back what it already made: that glade is
    # on its list now, and removing it is done by editing the list.
    titles = {b["title"] for b in client.get("/api/v1/boards", headers=holder.auth).json()}
    assert titles == {"Alpha", "yes"}


def test_a_classic_token_is_not_asked_about_creating(client: TestClient, owner: Actor) -> None:
    """It may already. Offering the flag would suggest there is a classic token that cannot."""
    refused = client.post(
        "/api/v1/tokens",
        json={"name": "x", "kind": "classic", "can_create": True},
        headers=owner.auth,
    )
    assert refused.status_code == 422, refused.text

    created = _classic(client, owner)
    assert created["can_create"] is True
    patched = client.patch(
        f"/api/v1/tokens/{created['id']}", json={"can_create": False}, headers=owner.auth
    )
    assert patched.status_code == 422, patched.text


def test_a_token_that_cannot_create_still_needs_a_glade(client: TestClient, owner: Actor) -> None:
    """Emptying the list is only allowed for a token that can fill it itself."""
    board = owner.create_board("Alpha")
    created = _fine(client, owner, {board: {"read"}})
    emptied = client.patch(
        f"/api/v1/tokens/{created['id']}", json={"grants": []}, headers=owner.auth
    )
    assert emptied.status_code == 422, emptied.text

    both = client.patch(
        f"/api/v1/tokens/{created['id']}",
        json={"grants": [], "can_create": True},
        headers=owner.auth,
    )
    assert both.status_code == 200, both.text
    assert both.json()["grants"] == []


def test_the_handshake_checks_the_grant_too(client: TestClient, owner: Actor) -> None:
    """The mint is one gate and the handshake is the other; neither alone is enough."""
    from app.config import settings
    from app.realtime import wstoken

    allowed = owner.create_board("allowed")
    other = owner.create_board("other")
    created = _fine(client, owner, {allowed: {"read"}})
    token = wstoken.mint(
        other,
        uuid.UUID(owner.user_id),
        int(time.time()) + settings.access_token_ttl_seconds,
        api_token_id=uuid.UUID(created["id"]),
    )
    assert expect_close(client, other, token) == WS_FORBIDDEN


# --- fine-grained: what on each glade, enforced at the socket ---------------------------


def test_read_only_grant_changes_nothing(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _seed(client, owner, board_id, "a")
    holder = _as_token(client, owner, _fine(client, owner, {board_id: {"read"}})["token"])

    minted = holder.ws_token(board_id)
    assert (minted["can_write"], minted["can_edit"], minted["can_delete"]) == (False, False, False)
    for change in (_add("new"), _move("a"), _remove("a")):
        _change(client, holder.ws_token(board_id)["token"], board_id, change)

    objects = _read(client, owner, board_id)
    assert sorted(objects) == ["a"]
    assert objects["a"]["x"] == 0


def test_edit_without_delete_cannot_remove_objects(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _seed(client, owner, board_id, "a", "b")
    holder = _as_token(
        client, owner, _fine(client, owner, {board_id: {"read", "edit"}})["token"]
    )
    minted = holder.ws_token(board_id)
    assert (minted["can_write"], minted["can_edit"], minted["can_delete"]) == (True, True, False)

    _change(client, minted["token"], board_id, _add("new"))
    _change(client, holder.ws_token(board_id)["token"], board_id, _move("a"))
    # A raw Yjs update removing an object: the client-side check is bypassed entirely.
    _change(client, holder.ws_token(board_id)["token"], board_id, _remove("b"))

    objects = _read(client, owner, board_id)
    assert sorted(objects) == ["a", "b", "new"], "the removal must be dropped at the server"
    assert objects["a"]["x"] == 99


def test_delete_without_edit_can_only_remove(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _seed(client, owner, board_id, "a", "b")
    holder = _as_token(
        client, owner, _fine(client, owner, {board_id: {"read", "delete"}})["token"]
    )
    minted = holder.ws_token(board_id)
    assert (minted["can_write"], minted["can_edit"], minted["can_delete"]) == (True, False, True)

    _change(client, minted["token"], board_id, _add("new"))
    _change(client, holder.ws_token(board_id)["token"], board_id, _move("a"))
    _change(client, holder.ws_token(board_id)["token"], board_id, _remove("b"))

    objects = _read(client, owner, board_id)
    assert sorted(objects) == ["a"], "only the removal may land"
    assert objects["a"]["x"] == 0


def test_a_mixed_update_is_refused_whole(client: TestClient, owner: Actor) -> None:
    """An update that removes and edits at once, from an edit-only token, lands not at all."""
    board_id = owner.create_board()
    _seed(client, owner, board_id, "a", "b")
    holder = _as_token(
        client, owner, _fine(client, owner, {board_id: {"read", "edit"}})["token"]
    )

    def both(objects: Map, bindings: Map, order: Array) -> None:
        _move("a")(objects, bindings, order)
        _remove("b")(objects, bindings, order)

    _change(client, holder.ws_token(board_id)["token"], board_id, both)
    objects = _read(client, owner, board_id)
    assert sorted(objects) == ["a", "b"]
    assert objects["a"]["x"] == 0


def test_different_glades_get_different_permissions(client: TestClient, owner: Actor) -> None:
    a = owner.create_board("a")
    c = owner.create_board("c")
    _seed(client, owner, a, "x")
    _seed(client, owner, c, "x")
    holder = _as_token(
        client, owner, _fine(client, owner, {a: {"read", "edit"}, c: {"read", "delete"}})["token"]
    )

    _change(client, holder.ws_token(a)["token"], a, _remove("x"))
    _change(client, holder.ws_token(c)["token"], c, _remove("x"))
    assert "x" in _read(client, owner, a)
    assert "x" not in _read(client, owner, c)


# --- changing, revoking, expiring ------------------------------------------------------


def test_changing_a_grant_takes_effect_on_open_sockets(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _fine(client, owner, {board_id: {"read", "edit"}})
    holder = _as_token(client, owner, created["token"])

    with (
        pytest.raises(WebSocketDisconnect) as excinfo,
        client.websocket_connect(ws_url(board_id, holder.ws_token(board_id)["token"])) as ws,
    ):
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)
        patched = client.patch(
            f"/api/v1/tokens/{created['id']}",
            json={"grants": [{"board_id": board_id, "read": True}]},
            headers=owner.auth,
        )
        assert patched.status_code == 200, patched.text
        while True:
            ws.receive_bytes()
    assert excinfo.value.code == WS_FORBIDDEN, "4403 so the client re-mints under the new grant"

    assert holder.ws_token(board_id)["can_edit"] is False


def test_a_classic_token_cannot_be_given_grants(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _classic(client, owner)
    response = client.patch(
        f"/api/v1/tokens/{created['id']}",
        json={"grants": [{"board_id": board_id, "read": True}]},
        headers=owner.auth,
    )
    assert response.status_code == 422, response.text


def test_a_revoked_token_is_refused_everywhere(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _classic(client, owner)
    holder = _as_token(client, owner, created["token"])
    ws = holder.ws_token(board_id)["token"]

    assert client.delete(f"/api/v1/tokens/{created['id']}", headers=owner.auth).status_code == 204
    assert client.get("/api/v1/boards", headers=holder.auth).status_code == 401
    denied = client.post("/api/v1/ws-token", json={"board_id": board_id}, headers=holder.auth)
    assert denied.status_code == 401
    assert expect_close(client, board_id, ws) == WS_UNAUTHORIZED
    assert client.get("/api/v1/tokens", headers=owner.auth).json() == []


def test_an_expired_token_is_refused(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _classic(client, owner, expires_in_days=30)
    holder = _as_token(client, owner, created["token"])
    ws = holder.ws_token(board_id)["token"]
    _sql(
        "update api_tokens set expires_at = now() - interval '1 second' where id = $1",
        uuid.UUID(created["id"]),
    )
    assert client.get("/api/v1/boards", headers=holder.auth).status_code == 401
    assert expect_close(client, board_id, ws) == WS_UNAUTHORIZED


def test_revoking_a_token_closes_the_sockets_it_opened(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    created = _classic(client, owner)
    holder = _as_token(client, owner, created["token"])

    with (
        pytest.raises(WebSocketDisconnect) as excinfo,
        client.websocket_connect(ws_url(board_id, holder.ws_token(board_id)["token"])) as ws,
    ):
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)
        assert (
            client.delete(f"/api/v1/tokens/{created['id']}", headers=owner.auth).status_code == 204
        )
        while True:
            ws.receive_bytes()
    assert excinfo.value.code == WS_UNAUTHORIZED


def test_a_session_socket_is_not_closed_by_revoking_a_token(
    client: TestClient, owner: Actor
) -> None:
    board_id = owner.create_board()
    created = _classic(client, owner)
    with client.websocket_connect(ws_url(board_id, owner.ws_token(board_id)["token"])) as ws:
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)
        client.delete(f"/api/v1/tokens/{created['id']}", headers=owner.auth)
        doc, objects, _, _ = _doc()
        objects["still-here"] = Map({"id": "still-here", "type": "rect"})
        ws.send_bytes(ywire.sync_update(doc.get_update()))
        ws.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(ws)
    assert "still-here" in _read(client, owner, board_id)


def test_a_deleted_glade_leaves_the_grant_list(client: TestClient, owner: Actor) -> None:
    keep = owner.create_board("keep")
    gone = owner.create_board("gone")
    created = _fine(client, owner, {keep: {"read"}, gone: {"read"}})
    _sql("delete from boards where id = $1", uuid.UUID(gone))
    [row] = client.get("/api/v1/tokens", headers=owner.auth).json()
    assert [grant["board_id"] for grant in row["grants"]] == [keep]
    assert row["id"] == created["id"]


def test_using_a_token_records_when(client: TestClient, owner: Actor) -> None:
    created = _classic(client, owner)
    assert client.get("/api/v1/tokens", headers=owner.auth).json()[0]["last_used_at"] is None
    client.get("/api/v1/boards", headers=_as_token(client, owner, created["token"]).auth)
    assert client.get("/api/v1/tokens", headers=owner.auth).json()[0]["last_used_at"] is not None


def test_deleting_the_account_ends_its_tokens(client: TestClient, owner: Actor) -> None:
    created = _classic(client, owner)
    _sql("delete from users where id = $1", uuid.UUID(owner.user_id))
    holder = _as_token(client, owner, created["token"])
    assert client.get("/api/v1/boards", headers=holder.auth).status_code == 401
