"""Pins: a person's own shortlist of glades and leas, kept to the top of their list.

A pin belongs to the person, not to the board. What is worth asserting is that it
stays theirs: pinning is offered at every role because it changes nothing anybody
else sees, and it is refused wherever the board itself would be, so a pin can never
be a way to learn that a board id exists.
"""

from typing import Any

from starlette.testclient import TestClient

from tests.conftest import Actor


def _pinned(client: TestClient, actor: Actor) -> dict[str, bool]:
    response = client.get("/api/v1/boards", headers=actor.auth)
    assert response.status_code == 200, response.text
    boards: list[dict[str, Any]] = response.json()
    return {board["title"]: board["pinned"] for board in boards}


def test_a_board_starts_unpinned_and_pins_and_unpins(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board("Tuesday")
    owner.create_board("Wednesday")
    assert _pinned(client, owner) == {"Tuesday": False, "Wednesday": False}

    assert client.put(f"/api/v1/boards/{board_id}/pin", headers=owner.auth).status_code == 204
    assert _pinned(client, owner) == {"Tuesday": True, "Wednesday": False}

    # The single board answers the same way the list does.
    single = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()
    assert single["pinned"] is True

    assert client.delete(f"/api/v1/boards/{board_id}/pin", headers=owner.auth).status_code == 204
    assert _pinned(client, owner) == {"Tuesday": False, "Wednesday": False}


def test_pinning_twice_and_unpinning_twice_are_both_fine(
    client: TestClient, owner: Actor
) -> None:
    """A double click, or two tabs, must not turn into an error toast."""
    board_id = owner.create_board()
    for _ in range(2):
        assert client.put(f"/api/v1/boards/{board_id}/pin", headers=owner.auth).status_code == 204
    for _ in range(2):
        assert (
            client.delete(f"/api/v1/boards/{board_id}/pin", headers=owner.auth).status_code
            == 204
        )


def test_pinning_does_not_count_as_an_edit(client: TestClient, owner: Actor) -> None:
    """Pins live off the board row, so "Last modified" is not moved by tidying a list."""
    board_id = owner.create_board()
    before = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()["updated_at"]
    client.put(f"/api/v1/boards/{board_id}/pin", headers=owner.auth)
    after = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()["updated_at"]
    assert after == before


def test_a_pin_is_the_pinners_alone(client: TestClient, owner: Actor, outsider: Actor) -> None:
    """A viewer may pin a shared board, and the owner's list does not change for it."""
    board_id = owner.create_board("Shared")
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )

    assert client.put(f"/api/v1/boards/{board_id}/pin", headers=outsider.auth).status_code == 204
    assert _pinned(client, outsider) == {"Shared": True}
    assert _pinned(client, owner) == {"Shared": False}


def test_a_stranger_cannot_pin_a_board_they_cannot_see(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()

    assert client.put(f"/api/v1/boards/{board_id}/pin", headers=outsider.auth).status_code == 403
    assert (
        client.delete(f"/api/v1/boards/{board_id}/pin", headers=outsider.auth).status_code == 403
    )


def test_a_board_in_the_trash_cannot_be_pinned(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    assert client.put(f"/api/v1/boards/{board_id}/pin", headers=owner.auth).status_code == 403


def test_a_pin_survives_the_trash(client: TestClient, owner: Actor) -> None:
    """Restoring gives the board back as it was, and that includes where it sat."""
    board_id = owner.create_board("Kept")
    client.put(f"/api/v1/boards/{board_id}/pin", headers=owner.auth)
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)
    client.post(f"/api/v1/boards/{board_id}/restore", headers=owner.auth)

    assert _pinned(client, owner) == {"Kept": True}


def test_losing_access_drops_the_board_from_the_list_pin_or_not(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """A pin is not a grant: it can never keep a board on a list it was removed from."""
    board_id = owner.create_board("Shared")
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )
    client.put(f"/api/v1/boards/{board_id}/pin", headers=outsider.auth)

    removed = client.delete(
        f"/api/v1/boards/{board_id}/members/{outsider.user_id}", headers=owner.auth
    )
    assert removed.status_code == 204, removed.text
    assert _pinned(client, outsider) == {}
