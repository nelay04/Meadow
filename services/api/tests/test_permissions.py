"""Role resolution and the REST checks built on it.

`resolve_role` is the single authority (ARCHITECTURE 7). These tests pin both the
resolution rule and the fact that routers actually defer to it.
"""

from typing import Any

from starlette.testclient import TestClient

from tests.conftest import Actor
from tests.wsclient import WS_FORBIDDEN, expect_close

WORKSPACE_MEMBER_IS_EDITOR = "editor"


def _share(client: TestClient, owner: Actor, board_id: str, actor: Actor, role: str) -> Any:
    return client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": actor.user_id, "role": role},
        headers=owner.auth,
    )


def test_outsider_sees_nothing(client: TestClient, owner: Actor, outsider: Actor) -> None:
    board_id = owner.create_board()

    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403
    assert client.get("/api/v1/boards", headers=outsider.auth).json() == []


def test_board_creator_is_owner_not_merely_editor(client: TestClient, owner: Actor) -> None:
    """Workspace membership maps to editor, so the creator needs an explicit grant.

    Without it, whoever creates a board in a workspace they merely belong to cannot
    delete or share it.
    """
    board_id = owner.create_board()
    body = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()
    assert body["role"] == "owner"


def test_workspace_membership_grants_editor_on_every_board(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    added = client.post(
        f"/api/v1/workspaces/{owner.workspace_id}/members",
        json={"user_id": outsider.user_id, "role": "member"},
        headers=owner.auth,
    )
    assert added.status_code == 201, added.text

    body = client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).json()
    assert body["role"] == WORKSPACE_MEMBER_IS_EDITOR


def test_effective_role_is_the_higher_of_the_two_grants(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """A board grant can raise the workspace role but must not silently lower it.

    A workspace member added to a board as `viewer` stays an editor, because the
    workspace grant still applies. Reporting `viewer` would tell an owner the
    downgrade worked when the write path still lets them through.
    """
    board_id = owner.create_board()
    client.post(
        f"/api/v1/workspaces/{owner.workspace_id}/members",
        json={"user_id": outsider.user_id, "role": "member"},
        headers=owner.auth,
    )
    _share(client, owner, board_id, outsider, "viewer")

    assert (
        client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).json()["role"] == "editor"
    )
    assert outsider.ws_token(board_id)["role"] == "editor"


def test_direct_board_share_works_without_workspace_membership(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """A board shared outside its workspace has to show up in the recipient's list."""
    board_id = owner.create_board("Shared")
    _share(client, owner, board_id, outsider, "viewer")

    listed = client.get("/api/v1/boards", headers=outsider.auth).json()
    assert [b["id"] for b in listed] == [board_id]
    assert listed[0]["role"] == "viewer"


def test_viewer_cannot_write_over_rest_either(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """The websocket is the important door, but REST must not be a way around it."""
    board_id = owner.create_board()
    _share(client, owner, board_id, outsider, "viewer")

    rename = client.patch(
        f"/api/v1/boards/{board_id}", json={"title": "hijacked"}, headers=outsider.auth
    )
    assert rename.status_code == 403
    assert client.delete(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403
    assert (
        _share(client, outsider, board_id, outsider, "owner").status_code == 403
    ), "a viewer must not be able to promote themselves"


def test_editor_can_rename_but_not_delete(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    _share(client, owner, board_id, outsider, "editor")

    renamed = client.patch(
        f"/api/v1/boards/{board_id}", json={"title": "Renamed"}, headers=outsider.auth
    )
    assert renamed.status_code == 200
    assert renamed.json()["title"] == "Renamed"

    assert client.delete(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403


def test_commenter_is_read_only_in_v1(client: TestClient, owner: Actor, outsider: Actor) -> None:
    """`commenter` exists in the enum but is inert until comments ship in v2.

    It must resolve with viewer capabilities, not accidentally with editor ones.
    """
    board_id = owner.create_board()
    _share(client, owner, board_id, outsider, "commenter")

    assert outsider.ws_token(board_id)["role"] == "commenter"
    assert (
        client.patch(
            f"/api/v1/boards/{board_id}", json={"title": "nope"}, headers=outsider.auth
        ).status_code
        == 403
    )


def test_board_in_another_workspace_is_invisible(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Creating a board needs membership in the target workspace, not just a uuid."""
    response = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "trespass"},
        headers=outsider.auth,
    )
    assert response.status_code == 403


def test_revoking_a_board_share_closes_the_door_immediately(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """REST and the websocket must agree the moment a grant is removed."""
    board_id = owner.create_board()
    _share(client, owner, board_id, outsider, "editor")
    token = outsider.ws_token(board_id)["token"]

    client.delete(f"/api/v1/boards/{board_id}/members/{outsider.user_id}", headers=owner.auth)

    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403
    assert expect_close(client, board_id, token) == WS_FORBIDDEN


def test_archived_boards_are_filtered_not_deleted(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    assert (
        client.patch(
            f"/api/v1/boards/{board_id}", json={"is_archived": True}, headers=owner.auth
        ).status_code
        == 200
    )

    assert client.get("/api/v1/boards", headers=owner.auth).json() == []
    archived = client.get("/api/v1/boards?archived=true", headers=owner.auth).json()
    assert [b["id"] for b in archived] == [board_id]
