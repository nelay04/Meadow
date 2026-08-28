"""`boards.kind`: the surface a glade is drawn on.

A kind is metadata about paper, so these tests pin three things and nothing more: the
default is what every board has always been, a valid kind round-trips through create
and read, and an invented one is refused rather than stored and rendered as a blank
board by a client that has never heard of it.
"""

from typing import Any

from starlette.testclient import TestClient

from tests.conftest import Actor


def _create(client: TestClient, actor: Actor, **body: Any) -> Any:
    return client.post(
        "/api/v1/boards",
        json={"workspace_id": actor.workspace_id, "title": "Test board", **body},
        headers=actor.auth,
    )


def test_kind_defaults_to_glade(client: TestClient, owner: Actor) -> None:
    """A board created without a kind is a plain glade, as every board was before."""
    board_id = owner.create_board()
    assert client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()["kind"] == "glade"


def test_lea_round_trips_through_create_read_and_list(client: TestClient, owner: Actor) -> None:
    created = _create(client, owner, kind="lea")
    assert created.status_code == 201, created.text
    board_id = created.json()["id"]
    assert created.json()["kind"] == "lea"

    assert client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()["kind"] == "lea"

    listed = client.get("/api/v1/boards", headers=owner.auth).json()
    assert [board["kind"] for board in listed if board["id"] == board_id] == ["lea"]


def test_unknown_kind_is_refused(client: TestClient, owner: Actor) -> None:
    """422 at the schema, so the check constraint is a backstop and not the message.

    The client picks a surface from this value. An unrecognised one would render as
    no surface at all, which looks like a broken glade rather than a rejected request.
    """
    assert _create(client, owner, kind="parchment").status_code == 422


def test_kind_is_fixed_at_creation(client: TestClient, owner: Actor) -> None:
    """PATCH takes title and archive. A kind sent there is ignored, never applied."""
    board_id = _create(client, owner, kind="lea").json()["id"]
    response = client.patch(
        f"/api/v1/boards/{board_id}", json={"kind": "glade"}, headers=owner.auth
    )
    assert response.status_code == 200, response.text
    assert response.json()["kind"] == "lea"
