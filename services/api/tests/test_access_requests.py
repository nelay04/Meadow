"""Asking to be let in to a restricted board.

The half of sharing that was missing. A restricted link worked and the board behind it
refused you, with nothing to do about it inside the app - so the tests here are mostly
about what a stranger is told, which has to be enough to act on and not one word more.
"""

import pytest
from starlette.testclient import TestClient, WebSocketDisconnect

from tests.conftest import Actor
from tests.wsclient import ws_url


def _ask(client: TestClient, actor: Actor, board_id: str, role: str = "viewer"):
    return client.post(
        f"/api/v1/boards/{board_id}/access-requests",
        json={"role": role},
        headers=actor.auth,
    )


def test_a_stranger_can_ask_and_the_owner_sees_it(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()

    asked = _ask(client, outsider, board_id, "editor")
    assert asked.status_code == 202, asked.text
    assert asked.json() == {"status": "pending", "role": "editor", "has_access": False}

    waiting = client.get(f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth)
    assert waiting.status_code == 200, waiting.text
    assert [(r["email"], r["role"]) for r in waiting.json()] == [(outsider.email, "editor")]

    # The dialog reads one response, so the request has to be in the share state too.
    share = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth)
    assert [r["email"] for r in share.json()["requests"]] == [outsider.email]


def test_asking_does_not_grant_anything(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """The whole safety property. A request is a record, never a key."""
    board_id = owner.create_board()
    _ask(client, outsider, board_id, "editor")

    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403
    assert (
        client.post(
            "/api/v1/ws-token", json={"board_id": board_id}, headers=outsider.auth
        ).status_code
        == 403
    )


def test_asking_twice_is_one_request(client: TestClient, owner: Actor, outsider: Actor) -> None:
    board_id = owner.create_board()
    _ask(client, outsider, board_id, "viewer")
    _ask(client, outsider, board_id, "editor")

    waiting = client.get(f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth).json()
    assert len(waiting) == 1
    # The later ask replaces the earlier one rather than queueing behind it.
    assert waiting[0]["role"] == "editor"


def test_approving_grants_the_role_and_clears_the_queue(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    _ask(client, outsider, board_id, "editor")
    request_id = client.get(
        f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth
    ).json()[0]["id"]

    decided = client.post(
        f"/api/v1/boards/{board_id}/access-requests/{request_id}",
        json={"approve": True},
        headers=owner.auth,
    )
    assert decided.status_code == 200, decided.text
    assert decided.json()["requests"] == []
    assert (outsider.email, "editor") in [
        (m["email"], m["role"]) for m in decided.json()["members"]
    ]

    opened = client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth)
    assert opened.status_code == 200
    assert opened.json()["role"] == "editor"
    assert outsider.ws_token(board_id)["can_write"] is True


def test_an_owner_may_grant_less_than_was_asked_for(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """The request says what they want; the decision says what they get."""
    board_id = owner.create_board()
    _ask(client, outsider, board_id, "editor")
    request_id = client.get(
        f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth
    ).json()[0]["id"]

    client.post(
        f"/api/v1/boards/{board_id}/access-requests/{request_id}",
        json={"approve": True, "role": "viewer"},
        headers=owner.auth,
    )

    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).json()["role"] == (
        "viewer"
    )


def test_declining_grants_nothing_and_says_so(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    _ask(client, outsider, board_id, "editor")
    request_id = client.get(
        f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth
    ).json()[0]["id"]

    client.post(
        f"/api/v1/boards/{board_id}/access-requests/{request_id}",
        json={"approve": False},
        headers=owner.auth,
    )

    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403
    mine = client.get(
        f"/api/v1/boards/{board_id}/access-requests/mine", headers=outsider.auth
    ).json()
    assert mine["status"] == "declined"
    assert mine["has_access"] is False
    # And it can be asked again: a decline is usually "I do not know who you are", and
    # that is answered somewhere this app cannot see.
    assert _ask(client, outsider, board_id, "viewer").json()["status"] == "pending"


def test_the_waiting_screen_learns_about_access_it_was_given_another_way(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """`has_access` is the field that screen acts on, and here nothing decided the row.

    An owner who reaches for the member list instead of the request has still answered
    the question, and somebody left watching their own pending row would sit in front
    of a board that was open.
    """
    board_id = owner.create_board()
    _ask(client, outsider, board_id, "editor")
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    mine = client.get(
        f"/api/v1/boards/{board_id}/access-requests/mine", headers=outsider.auth
    ).json()
    assert mine["status"] == "pending"
    assert mine["has_access"] is True


def test_asking_for_what_you_already_have_is_not_a_request(
    client: TestClient, owner: Actor
) -> None:
    board_id = owner.create_board()
    answer = _ask(client, owner, board_id, "editor")

    assert answer.json() == {"status": "granted", "role": "editor", "has_access": True}
    assert client.get(f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth).json() == []


def test_a_board_that_does_not_exist_answers_like_one_that_does(
    client: TestClient, outsider: Actor
) -> None:
    """The uniform answer, which is what stops this being an id oracle.

    A caller pointing at a random uuid learns exactly what a caller pointing at a real
    board with no request on it learns.
    """
    nowhere = "00000000-0000-4000-8000-000000000000"

    assert client.get(
        f"/api/v1/boards/{nowhere}/access-requests/mine", headers=outsider.auth
    ).json() == {"status": "none", "role": None, "has_access": False}
    assert _ask(client, outsider, nowhere).status_code == 202


def test_only_an_owner_sees_or_decides_requests(
    client: TestClient, owner: Actor, outsider: Actor, make_user
) -> None:
    board_id = owner.create_board()
    editor = make_user()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": editor.user_id, "role": "editor"},
        headers=owner.auth,
    )
    _ask(client, outsider, board_id, "editor")
    request_id = client.get(
        f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth
    ).json()[0]["id"]

    assert (
        client.get(f"/api/v1/boards/{board_id}/access-requests", headers=editor.auth).status_code
        == 403
    )
    assert (
        client.post(
            f"/api/v1/boards/{board_id}/access-requests/{request_id}",
            json={"approve": True},
            headers=editor.auth,
        ).status_code
        == 403
    )


def test_a_request_may_not_ask_for_ownership(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Nothing that can be asked for may carry deletion or membership changes."""
    board_id = owner.create_board()
    assert _ask(client, outsider, board_id, "owner").status_code == 422


def test_a_request_belongs_to_its_board(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """An id alone must not be enough to decide somebody else's request."""
    board_id = owner.create_board()
    other_board = owner.create_board("Second")
    _ask(client, outsider, board_id, "editor")
    request_id = client.get(
        f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth
    ).json()[0]["id"]

    assert (
        client.post(
            f"/api/v1/boards/{other_board}/access-requests/{request_id}",
            json={"approve": True},
            headers=owner.auth,
        ).status_code
        == 404
    )


def test_approval_closes_the_sockets_so_the_new_role_takes_effect(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """A viewer promoted mid-session is holding a read-only channel chosen at join."""
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )
    _ask(client, outsider, board_id, "editor")
    request_id = client.get(
        f"/api/v1/boards/{board_id}/access-requests", headers=owner.auth
    ).json()[0]["id"]

    with client.websocket_connect(
        ws_url(board_id, outsider.ws_token(board_id)["token"])
    ) as websocket:
        websocket.receive_bytes()
        client.post(
            f"/api/v1/boards/{board_id}/access-requests/{request_id}",
            json={"approve": True},
            headers=owner.auth,
        )
        with pytest.raises(WebSocketDisconnect) as excinfo:
            for _ in range(5):
                websocket.receive_bytes()

    assert excinfo.value.code == 4403
