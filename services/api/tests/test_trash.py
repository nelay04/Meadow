"""The trash: deleting is recoverable, and stops being so on a schedule.

Deleting used to be one irreversible click on the one thing the app exists to hold, so
what is worth asserting here is not that the button works. It is the pair of properties
that make a trash a trash rather than a flag: a board in it is as unreachable as one
that was deleted for good - by every route and at every role, including its owner's -
and it comes back whole rather than as a row with its content cascaded away.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from starlette.testclient import TestClient

from tests.conftest import Actor


def _trash(client: TestClient, actor: Actor) -> list[dict[str, Any]]:
    response = client.get("/api/v1/boards/trash", headers=actor.auth)
    assert response.status_code == 200, response.text
    body: list[dict[str, Any]] = response.json()
    return body


def _titles(client: TestClient, actor: Actor) -> list[str]:
    response = client.get("/api/v1/boards", headers=actor.auth)
    assert response.status_code == 200, response.text
    return [board["title"] for board in response.json()]


def test_deleting_moves_the_board_to_the_trash(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board("Tuesday")

    assert client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth).status_code == 204

    # Gone from the list, and in the trash instead. Both halves matter: a board that
    # was only added to the trash would still be sitting in the board list.
    assert _titles(client, owner) == []
    trash = _trash(client, owner)
    assert [entry["title"] for entry in trash] == ["Tuesday"]
    assert trash[0]["deleted_by"] == owner.user_id
    assert trash[0]["purge_after"] > trash[0]["deleted_at"]


def test_a_board_in_the_trash_is_unreachable_even_to_its_owner(
    client: TestClient, owner: Actor
) -> None:
    """The property the whole design rests on.

    A soft delete is only safe if every route refuses the row, and the way that is
    achieved here is that `resolve_role` refuses it once - so this asserts the routes
    that ask it in four different ways, including the websocket credential mint.
    """
    board_id = owner.create_board()
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    assert client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).status_code == 403
    assert (
        client.patch(
            f"/api/v1/boards/{board_id}", json={"title": "Nope"}, headers=owner.auth
        ).status_code
        == 403
    )
    assert client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).status_code == 403
    assert (
        client.post(
            "/api/v1/ws-token", json={"board_id": board_id}, headers=owner.auth
        ).status_code
        == 403
    )


def test_restoring_gives_the_board_back_whole(client: TestClient, owner: Actor) -> None:
    """Membership and the share link survive, because nothing was ever taken apart."""
    board_id = owner.create_board("Wednesday")
    share = client.put(
        f"/api/v1/boards/{board_id}/share",
        json={"mode": "public", "role": "editor"},
        headers=owner.auth,
    )
    assert share.status_code == 200, share.text
    # Out of the share URL, which is where a person would get it too.
    url = share.json()["link_url"]
    assert url is not None
    link = url.split("?k=", 1)[1].split("#", 1)[0]

    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)
    # The link is a capability on a board that is not currently there.
    assert client.get(f"/api/v1/share/{link}").status_code == 404

    restored = client.post(f"/api/v1/boards/{board_id}/restore", headers=owner.auth)
    assert restored.status_code == 200, restored.text
    assert restored.json()["title"] == "Wednesday"

    assert _titles(client, owner) == ["Wednesday"]
    assert _trash(client, owner) == []
    # The same link, not a new one: rotating it on restore would break every copy of
    # an address that was only ever suspended.
    assert client.get(f"/api/v1/share/{link}").status_code == 200


def test_the_trash_is_the_owners_alone(client: TestClient, owner: Actor, make_user: Any) -> None:
    """An editor may delete nothing here, and may not see what was deleted.

    Restoring and purging are owner actions, so a trash row anybody else could see
    would be a list of somebody else's discards with nothing on it they could do.
    """
    editor = make_user("Editor")
    board_id = owner.create_board("Theirs")
    add = client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": editor.user_id, "role": "editor"},
        headers=owner.auth,
    )
    assert add.status_code in (200, 201), add.text

    # An editor cannot delete in the first place, which is unchanged.
    assert client.delete(f"/api/v1/boards/{board_id}", headers=editor.auth).status_code == 403

    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)
    assert _trash(client, editor) == []
    assert (
        client.post(f"/api/v1/boards/{board_id}/restore", headers=editor.auth).status_code == 403
    )
    assert client.delete(f"/api/v1/boards/{board_id}/purge", headers=editor.auth).status_code == 403


def test_an_outsider_gets_the_same_403_for_the_trash_routes(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """No route may distinguish "in the trash" from "not yours" for a stranger."""
    board_id = owner.create_board()
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    assert (
        client.post(f"/api/v1/boards/{board_id}/restore", headers=outsider.auth).status_code == 403
    )
    assert (
        client.delete(f"/api/v1/boards/{board_id}/purge", headers=outsider.auth).status_code == 403
    )
    # And the same answer for a board id that never existed, so the trash routes
    # cannot be used to probe which ids are real.
    missing = uuid.uuid4()
    unknown = client.post(f"/api/v1/boards/{missing}/restore", headers=outsider.auth)
    assert unknown.status_code == 403


def test_purging_is_only_offered_from_the_trash(client: TestClient, owner: Actor) -> None:
    """A live board cannot be destroyed in one call.

    This is what makes delete a click you can take back: there is no route that both
    removes a board from the list and destroys it.
    """
    board_id = owner.create_board()

    conflict = client.delete(f"/api/v1/boards/{board_id}/purge", headers=owner.auth)
    assert conflict.status_code == 409, conflict.text
    assert _titles(client, owner) == ["Test board"]

    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)
    assert client.delete(f"/api/v1/boards/{board_id}/purge", headers=owner.auth).status_code == 204

    # And now it is gone from everywhere, including the trash.
    assert _trash(client, owner) == []
    assert client.post(f"/api/v1/boards/{board_id}/restore", headers=owner.auth).status_code == 403


def test_restoring_twice_is_not_an_error(client: TestClient, owner: Actor) -> None:
    """Two tabs, one board. The second call asks for a state that already holds."""
    board_id = owner.create_board()
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    assert client.post(f"/api/v1/boards/{board_id}/restore", headers=owner.auth).status_code == 200
    assert client.post(f"/api/v1/boards/{board_id}/restore", headers=owner.auth).status_code == 200
    assert _titles(client, owner) == ["Test board"]


def test_the_retention_window_is_served_to_the_client(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A lea sweeps its own page trash, so it has to be told the deployment's window."""
    from app.config import settings

    monkeypatch.setattr(settings, "trash_retention_hours", 6)
    response = client.get("/api/v1/config")
    assert response.status_code == 200, response.text
    assert response.json()["trash_retention_hours"] == 6


@pytest.mark.parametrize("hours", [0, 1, 720])
def test_purge_after_follows_the_configured_window(
    client: TestClient, owner: Actor, monkeypatch: pytest.MonkeyPatch, hours: int
) -> None:
    from app.config import settings

    monkeypatch.setattr(settings, "trash_retention_hours", hours)
    board_id = owner.create_board()
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    entry = _trash(client, owner)[0]
    deleted_at = datetime.fromisoformat(entry["deleted_at"])
    assert datetime.fromisoformat(entry["purge_after"]) == deleted_at + timedelta(hours=hours)


def test_the_sweep_purges_what_has_outlived_the_window(
    client: TestClient, owner: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The worker's half, against a real database rather than a fake clock.

    The sweep is the only thing that ever deletes a board nobody asked it to, so the
    thing worth proving is the boundary: one board past the window goes, and one inside
    it is still there afterwards and still restorable.
    """
    import asyncio
    import logging

    from sqlalchemy import update
    from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

    from app.config import settings
    from app.models import Board
    from app.workers.trash import sweep_trash

    monkeypatch.setattr(settings, "trash_retention_hours", 24)

    stale = owner.create_board("Long gone")
    fresh = owner.create_board("Only just")
    client.delete(f"/api/v1/boards/{stale}", headers=owner.auth)
    client.delete(f"/api/v1/boards/{fresh}", headers=owner.auth)

    async def run() -> int:
        engine = create_async_engine(settings.database_url)
        factory = async_sessionmaker(engine, expire_on_commit=False)
        try:
            async with factory() as session:
                # Backdate one of them past the window. Two days, against a window of
                # one, so the assertion is not about a boundary measured in seconds.
                await session.execute(
                    update(Board)
                    .where(Board.id == uuid.UUID(stale))
                    .values(deleted_at=datetime.now(UTC) - timedelta(days=2))
                )
                await session.commit()

            ctx = {"session_factory": factory, "logger": logging.getLogger("test")}
            return await sweep_trash(ctx)
        finally:
            await engine.dispose()

    assert asyncio.run(run()) == 1

    remaining = _trash(client, owner)
    assert [entry["title"] for entry in remaining] == ["Only just"]
    assert client.post(f"/api/v1/boards/{fresh}/restore", headers=owner.auth).status_code == 200
    assert client.post(f"/api/v1/boards/{stale}/restore", headers=owner.auth).status_code == 403
