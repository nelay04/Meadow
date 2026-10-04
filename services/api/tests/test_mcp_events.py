"""The audit trail for what an assistant did to a glade.

Written before the implementation. A route that an access token may post to is an auth
change, and the working agreement puts the test first.

What these pin down:

* Only a caller who could have made the edit may record having made it. A viewer's
  token is refused, so the trail cannot be filled with edits that never happened by a
  credential that could not have made them.
* The server attributes the event itself, from the token presenting it. Nothing in the
  body says who the actor is, so a token cannot write an event in another's name.
* A glade the caller cannot see answers 403 like any other route here, and not 404,
  which would say whether the id is real.
* The trail is readable by the people who own the glade, and by nobody else.
"""

import uuid
from typing import Any

from starlette.testclient import TestClient

from tests.conftest import Actor


def _event(**extra: Any) -> dict[str, Any]:
    body = {
        "operation_id": str(uuid.uuid4()),
        "tool": "create_nodes",
        "requested": 3,
        "accepted": 3,
        "duration_ms": 41,
        "outcome": "applied",
    }
    body.update(extra)
    return body


def _mint_classic(client: TestClient, actor: Actor) -> str:
    response = client.post(
        "/api/v1/tokens",
        json={"name": "agent", "kind": "classic"},
        headers=actor.auth,
    )
    assert response.status_code == 201, response.text
    token: str = response.json()["token"]
    return token


def _as(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_an_editor_token_records_what_it_did(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    token = _mint_classic(client, owner)
    body = _event()

    posted = client.post(f"/api/v1/boards/{board_id}/mcp-events", json=body, headers=_as(token))
    assert posted.status_code == 201, posted.text

    listed = client.get(f"/api/v1/boards/{board_id}/mcp-events", headers=owner.auth)
    assert listed.status_code == 200, listed.text
    rows = listed.json()
    assert len(rows) == 1
    assert rows[0]["operation_id"] == body["operation_id"]
    assert rows[0]["tool"] == "create_nodes"
    assert rows[0]["accepted"] == 3
    assert rows[0]["outcome"] == "applied"


def test_the_actor_is_taken_from_the_token_and_not_from_the_body(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """A token cannot sign an event in somebody else's name."""
    board_id = owner.create_board()
    token = _mint_classic(client, owner)

    posted = client.post(
        f"/api/v1/boards/{board_id}/mcp-events",
        json=_event(user_id=outsider.user_id, actor="somebody else"),
        headers=_as(token),
    )
    assert posted.status_code in (201, 422), posted.text

    rows = client.get(f"/api/v1/boards/{board_id}/mcp-events", headers=owner.auth).json()
    if rows:
        assert rows[0]["user_id"] == owner.user_id


def test_a_viewers_token_may_not_record_an_edit(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """The point of the whole route: only somebody who could edit may say they did."""
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )
    token = _mint_classic(client, outsider)

    refused = client.post(
        f"/api/v1/boards/{board_id}/mcp-events", json=_event(), headers=_as(token)
    )
    assert refused.status_code == 403, refused.text

    rows = client.get(f"/api/v1/boards/{board_id}/mcp-events", headers=owner.auth).json()
    assert rows == []


def test_a_glade_the_caller_cannot_see_is_refused_and_not_disclosed(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    token = _mint_classic(client, outsider)

    refused = client.post(
        f"/api/v1/boards/{board_id}/mcp-events", json=_event(), headers=_as(token)
    )
    assert refused.status_code == 403, refused.text

    # The same answer for a glade that does not exist at all, so the status cannot be
    # used to tell a real id from an invented one.
    invented = client.post(
        f"/api/v1/boards/{uuid.uuid4()}/mcp-events", json=_event(), headers=_as(token)
    )
    assert invented.status_code == 403, invented.text


def test_a_refusal_is_recorded_as_one(client: TestClient, owner: Actor) -> None:
    """An edit that was refused is the most interesting row in the trail."""
    board_id = owner.create_board()
    token = _mint_classic(client, owner)

    posted = client.post(
        f"/api/v1/boards/{board_id}/mcp-events",
        json=_event(accepted=0, outcome="refused", reason="board is locked"),
        headers=_as(token),
    )
    assert posted.status_code == 201, posted.text

    rows = client.get(f"/api/v1/boards/{board_id}/mcp-events", headers=owner.auth).json()
    assert rows[0]["outcome"] == "refused"
    assert rows[0]["accepted"] == 0
    assert rows[0]["reason"] == "board is locked"


def test_the_trail_is_not_readable_by_an_outsider(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    token = _mint_classic(client, owner)
    client.post(f"/api/v1/boards/{board_id}/mcp-events", json=_event(), headers=_as(token))

    refused = client.get(f"/api/v1/boards/{board_id}/mcp-events", headers=outsider.auth)
    assert refused.status_code == 403, refused.text


def test_a_browser_session_may_not_post_an_event(client: TestClient, owner: Actor) -> None:
    """The trail records machine edits. A person's own edits are not MCP mutations."""
    board_id = owner.create_board()

    refused = client.post(
        f"/api/v1/boards/{board_id}/mcp-events", json=_event(), headers=owner.auth
    )
    assert refused.status_code in (401, 403), refused.text
