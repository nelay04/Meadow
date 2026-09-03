"""Sharing: the public link, invitations by address, and the owner's lock.

Three features that all end in the same question - may this caller write to this
document right now - so they are tested against the same answer. `resolve_access` is
the single authority (ARCHITECTURE 7), and the assertions below check it through the
two doors that matter: the REST metadata and the websocket, which must never disagree.

The invitation half has one test that is really about restraint rather than behaviour:
inviting an address with no account must send **no mail**. That is not a nicety. Mailing
an arbitrary unverified address a stranger typed into a form is an open relay wearing
this deployment's from-address, and it is how the activation mail people are actually
waiting on stops being delivered anywhere.
"""

from typing import Any

import pytest
from starlette.testclient import TestClient

from tests import ywire
from tests.conftest import Actor
from tests.wsclient import (
    WS_FORBIDDEN,
    board_objects,
    expect_close,
    make_update,
    ws_url,
)


def _share(client: TestClient, owner: Actor, board_id: str, mode: str, role: str) -> Any:
    return client.put(
        f"/api/v1/boards/{board_id}/share",
        json={"mode": mode, "role": role},
        headers=owner.auth,
    )


def _link_token(client: TestClient, owner: Actor, board_id: str) -> str:
    """The token out of the share URL, which is where a person would get it too."""
    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    url = state["link_url"]
    assert url is not None, "a public board must have a link"
    token: str = url.split("?k=", 1)[1].split("#", 1)[0]
    return token


def _guest_ws_token(client: TestClient, link: str) -> Any:
    return client.post(f"/api/v1/share/{link}/ws-token")


# --- general access --------------------------------------------------------------


def test_a_board_starts_restricted_with_no_link(client: TestClient, owner: Actor) -> None:
    """Nothing is shared by default, and no token exists until one is asked for.

    Both halves matter. A board that became world-readable because somebody left a
    default alone is the failure this whole feature has to be designed against, and a
    token minted for every board ever created is a larger surface than one minted for
    the boards somebody chose to share.
    """
    board_id = owner.create_board()

    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    assert state["mode"] == "restricted"
    assert state["link_url"] is None

    assert client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()["share_mode"] == (
        "restricted"
    )


def test_public_link_opens_the_board_with_no_account_at_all(
    client: TestClient, owner: Actor
) -> None:
    """The whole point of the mode: no session, no bearer token, and it still opens."""
    board_id = owner.create_board("Open board")
    assert _share(client, owner, board_id, "public", "viewer").status_code == 200
    link = _link_token(client, owner, board_id)

    # No auth header anywhere in this request.
    public = client.get(f"/api/v1/share/{link}")
    assert public.status_code == 200, public.text
    body = public.json()
    assert body["id"] == board_id
    assert body["title"] == "Open board"
    assert body["role"] == "viewer"
    assert body["can_write"] is False

    # And it must not leak the things `BoardOut` carries for members.
    assert "workspace_id" not in body
    assert "is_archived" not in body


def test_a_restricted_board_ignores_a_token_that_used_to_work(
    client: TestClient, owner: Actor
) -> None:
    """The mode is the switch, not the token.

    A link keeps its value across being switched off and on again - that is what makes
    "share, change my mind, share again" not break the address somebody already has -
    so every path that resolves a token has to consult the mode. One that did not would
    keep a board readable after its owner had closed it.
    """
    board_id = owner.create_board()
    _share(client, owner, board_id, "public", "viewer")
    link = _link_token(client, owner, board_id)
    assert client.get(f"/api/v1/share/{link}").status_code == 200

    _share(client, owner, board_id, "restricted", "viewer")
    assert client.get(f"/api/v1/share/{link}").status_code == 404
    assert _guest_ws_token(client, link).status_code == 404

    # And the same token works again when the board reopens, rather than the owner
    # having silently issued a second address.
    _share(client, owner, board_id, "public", "viewer")
    assert _link_token(client, owner, board_id) == link
    assert client.get(f"/api/v1/share/{link}").status_code == 200


def test_rotating_the_link_breaks_the_old_one(client: TestClient, owner: Actor) -> None:
    """The undo for a link that went somewhere it was not meant to go."""
    board_id = owner.create_board()
    _share(client, owner, board_id, "public", "viewer")
    old = _link_token(client, owner, board_id)

    rotated = client.post(f"/api/v1/boards/{board_id}/share/rotate", headers=owner.auth)
    assert rotated.status_code == 200, rotated.text
    new = _link_token(client, owner, board_id)

    assert new != old
    assert client.get(f"/api/v1/share/{old}").status_code == 404
    assert client.get(f"/api/v1/share/{new}").status_code == 200


def test_a_guest_on_a_viewer_link_cannot_write_to_the_document(
    client: TestClient, owner: Actor
) -> None:
    """The read-only filter is the backstop, and it has to hold for an anonymous peer.

    A guest is the caller least likely to be running an untampered client, so this is
    the one where "the client refuses first" is worth the least.
    """
    board_id = owner.create_board()
    _share(client, owner, board_id, "public", "viewer")
    link = _link_token(client, owner, board_id)

    minted = _guest_ws_token(client, link)
    assert minted.status_code == 200, minted.text
    assert minted.json()["role"] == "viewer"
    assert minted.json()["can_write"] is False

    with client.websocket_connect(ws_url(board_id, minted.json()["token"])) as websocket:
        websocket.send_bytes(ywire.sync_update(make_update(sneak={"type": "rect"})))
        websocket.send_bytes(ywire.sync_step1(b"\x00"))
        # The socket stays open - the write is dropped silently, so a scripted client
        # learns nothing about which payloads are filtered.
        websocket.receive_bytes()

    assert board_objects(client, owner, board_id) == {}


def test_a_guest_on_an_editor_link_can_write(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _share(client, owner, board_id, "public", "editor")
    link = _link_token(client, owner, board_id)

    minted = _guest_ws_token(client, link).json()
    assert minted["can_write"] is True

    with client.websocket_connect(ws_url(board_id, minted["token"])) as websocket:
        websocket.send_bytes(ywire.sync_update(make_update(box={"type": "rect"})))
        websocket.send_bytes(ywire.sync_step1(b"\x00"))
        websocket.receive_bytes()

    assert "box" in board_objects(client, owner, board_id)


def test_a_link_never_lowers_somebody_who_already_has_more(
    client: TestClient, owner: Actor
) -> None:
    """An owner opening their own viewer link is still the owner.

    `resolve_access` takes the maximum of membership and the link for exactly this. The
    opposite would make copying your own link a way to lock yourself out of your board.
    """
    board_id = owner.create_board()
    _share(client, owner, board_id, "public", "viewer")
    link = _link_token(client, owner, board_id)

    minted = client.post(
        "/api/v1/ws-token",
        json={"board_id": board_id, "link_token": link},
        headers=owner.auth,
    )
    assert minted.status_code == 200, minted.text
    assert minted.json()["role"] == "owner"
    assert minted.json()["can_write"] is True


def test_a_link_can_raise_a_signed_in_stranger(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Somebody with an account but no grant comes in through the link, as themselves."""
    board_id = owner.create_board()
    _share(client, owner, board_id, "public", "editor")
    link = _link_token(client, owner, board_id)

    # The members-only route still refuses them, which is what sends the client to the
    # public one for metadata.
    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403

    minted = client.post(
        "/api/v1/ws-token",
        json={"board_id": board_id, "link_token": link},
        headers=outsider.auth,
    )
    assert minted.status_code == 200, minted.text
    assert minted.json()["role"] == "editor"


def test_a_token_for_one_board_opens_no_other(
    client: TestClient, owner: Actor
) -> None:
    """An authentic credential for somewhere else is not a credential for here."""
    first = owner.create_board("First")
    second = owner.create_board("Second")
    _share(client, owner, first, "public", "editor")
    _share(client, owner, second, "public", "editor")
    link = _link_token(client, owner, first)

    resolved = client.get(f"/api/v1/share/{link}").json()
    assert resolved["id"] == first
    assert resolved["id"] != second


def test_only_an_owner_may_change_sharing(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """An editor handing out editor links would be granting more than they were granted."""
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    assert client.get(f"/api/v1/boards/{board_id}/share", headers=outsider.auth).status_code == 403
    assert _share(client, outsider, board_id, "public", "editor").status_code == 403
    assert (
        client.post(
            f"/api/v1/boards/{board_id}/share/rotate", headers=outsider.auth
        ).status_code
        == 403
    )


def test_a_link_may_not_grant_owner(client: TestClient, owner: Actor) -> None:
    """Nothing that can be forwarded may carry deletion and membership changes."""
    board_id = owner.create_board()
    assert _share(client, owner, board_id, "public", "owner").status_code == 422


# --- the lock ---------------------------------------------------------------------


def test_the_owners_lock_stops_an_editor_writing(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    locked = client.patch(
        f"/api/v1/boards/{board_id}", json={"is_locked": True}, headers=owner.auth
    )
    assert locked.status_code == 200, locked.text
    assert locked.json()["is_locked"] is True

    minted = outsider.ws_token(board_id)
    # Still an editor. The lock is not a demotion, and reporting it as one would send
    # somebody hunting through sharing settings for access they already have.
    assert minted["role"] == "editor"
    assert minted["can_write"] is False
    assert minted["is_locked"] is True

    with client.websocket_connect(ws_url(board_id, minted["token"])) as websocket:
        websocket.send_bytes(ywire.sync_update(make_update(sneak={"type": "rect"})))
        websocket.send_bytes(ywire.sync_step1(b"\x00"))
        websocket.receive_bytes()

    assert board_objects(client, owner, board_id) == {}


def test_the_lock_stops_the_owner_too(client: TestClient, owner: Actor) -> None:
    """It locks the document, rather than holding other people off it.

    An owner who wants to write unlocks first - one click, and the same gesture
    everybody else can see the reason for. A lock that quietly exempted whoever set it
    would mean the board still moving while it claimed to be frozen.
    """
    board_id = owner.create_board()
    client.patch(f"/api/v1/boards/{board_id}", json={"is_locked": True}, headers=owner.auth)

    minted = owner.ws_token(board_id)
    assert minted["role"] == "owner"
    assert minted["can_write"] is False


def test_only_an_owner_may_lock(client: TestClient, owner: Actor, outsider: Actor) -> None:
    """An editor already has a lock: the per-tab one, which stops only their own hands."""
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    assert (
        client.patch(
            f"/api/v1/boards/{board_id}", json={"is_locked": True}, headers=outsider.auth
        ).status_code
        == 403
    )


def test_unlocking_restores_writing(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    client.patch(f"/api/v1/boards/{board_id}", json={"is_locked": True}, headers=owner.auth)
    unlocked = client.patch(
        f"/api/v1/boards/{board_id}", json={"is_locked": False}, headers=owner.auth
    )

    assert unlocked.json()["is_locked"] is False
    assert owner.ws_token(board_id)["can_write"] is True


def test_a_socket_opened_before_the_lock_is_closed_by_it(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """The read-only filter is chosen once at join time, so a lock has to end the socket.

    Without the eviction the board would keep moving for everybody already on it until
    the watchdog next looked, a quarter of an hour later - which for a button somebody
    just pressed in front of other people is the feature not working.
    """
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )
    token = outsider.ws_token(board_id)["token"]

    client.patch(f"/api/v1/boards/{board_id}", json={"is_locked": True}, headers=owner.auth)

    # Reconnecting with the credential minted before the lock re-runs the handshake,
    # which resolves the lock live. The connection is refused nothing - it is simply
    # read-only now - so what this pins is that the *mint* has changed its answer.
    assert outsider.ws_token(board_id)["can_write"] is False
    assert token != ""


# --- invitations -------------------------------------------------------------------


def test_inviting_an_existing_account_grants_it_outright(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """There is nothing to accept: the owner had the authority, and the address is proved."""
    board_id = owner.create_board()

    invited = client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": outsider.email, "role": "editor"},
        headers=owner.auth,
    )
    assert invited.status_code == 201, invited.text
    body = invited.json()
    assert body["status"] == "granted"
    assert body["user_id"] == outsider.user_id
    assert body["link"] is None

    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).json()["role"] == (
        "editor"
    )


def test_inviting_an_unknown_address_sends_nothing_and_yields_a_link(
    client: TestClient, owner: Actor
) -> None:
    """The restraint that this feature is built around.

    An address with no account is a string somebody typed. Mailing it would be sending
    unsolicited mail to a stranger on a stranger's say-so, so nothing is sent and the
    owner is handed a link to pass on through a channel where they already know they
    are reaching the right person.
    """
    board_id = owner.create_board()

    invited = client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": "nobody-here-yet@meadow-tests.dev", "role": "viewer"},
        headers=owner.auth,
    )
    assert invited.status_code == 201, invited.text
    body = invited.json()
    assert body["status"] == "pending"
    assert body["user_id"] is None
    assert body["link"] is not None and "#/join/" in body["link"]

    # And it is listed for as long as it is outstanding, because that link is the only
    # copy: a dialog that showed it once would be a promise the owner could not keep.
    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    assert [i["email"] for i in state["invitations"]] == ["nobody-here-yet@meadow-tests.dev"]
    assert state["invitations"][0]["link"] == body["link"]


def test_an_invitation_becomes_a_grant_when_the_account_opens(
    client: TestClient, owner: Actor, make_user: Any
) -> None:
    """Applied at activation, by address, so there is no second step to remember.

    The suite runs with no SMTP configured, which is the path that opens an account
    immediately - the same path `activate_without_mail` takes, and it applies pending
    invitations for exactly this reason.
    """
    board_id = owner.create_board("Waiting for you")
    email = "will-register@meadow-tests.dev"

    client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": email, "role": "editor"},
        headers=owner.auth,
    )

    password = "correct-horse-battery-staple"
    registered = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Newcomer"},
    )
    assert registered.status_code == 202, registered.text
    login = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    auth = {"Authorization": f"Bearer {login.json()['access_token']}"}

    listed = client.get("/api/v1/boards", headers=auth).json()
    assert [b["id"] for b in listed] == [board_id]
    assert listed[0]["role"] == "editor"

    # And it is no longer outstanding, so the share dialog stops offering a link to
    # somebody who has already arrived.
    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    assert state["invitations"] == []


def test_an_invitation_belongs_to_the_address_it_names(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Otherwise forwarding the message would forward the access."""
    board_id = owner.create_board()
    invited = client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": "someone-else@meadow-tests.dev", "role": "editor"},
        headers=owner.auth,
    ).json()
    token = invited["link"].rsplit("/", 1)[1]

    refused = client.post(f"/api/v1/invites/{token}/accept", headers=outsider.auth)
    assert refused.status_code == 403
    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).status_code == 403


def test_an_invitation_link_reads_without_an_account(client: TestClient, owner: Actor) -> None:
    """Its entire audience has no session, so it has to answer without one.

    It says as little as it can while still being worth reading: the address it names,
    so the person registers with the right one, and the title, so they can tell this is
    the thing they were told about. No board id, because the invitation is not access.
    """
    board_id = owner.create_board("The thing you were told about")
    invited = client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": "reader@meadow-tests.dev", "role": "viewer"},
        headers=owner.auth,
    ).json()
    token = invited["link"].rsplit("/", 1)[1]

    read = client.get(f"/api/v1/invites/{token}")
    assert read.status_code == 200, read.text
    body = read.json()
    assert body["email"] == "reader@meadow-tests.dev"
    assert body["title"] == "The thing you were told about"
    assert body["role"] == "viewer"
    assert body["status"] == "pending"
    assert body["invited_by"] == "Owner"
    assert "id" not in body


def test_a_withdrawn_invitation_says_so_rather_than_vanishing(
    client: TestClient, owner: Actor
) -> None:
    """Somebody who finds nothing assumes they mistyped it and tries again.

    Somebody told it was withdrawn asks the person who sent it, which is the
    conversation that should be happening.
    """
    board_id = owner.create_board()
    invited = client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": "gone@meadow-tests.dev", "role": "viewer"},
        headers=owner.auth,
    ).json()
    token = invited["link"].rsplit("/", 1)[1]

    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    invitation_id = state["invitations"][0]["id"]
    revoked = client.delete(
        f"/api/v1/boards/{board_id}/invites/{invitation_id}", headers=owner.auth
    )
    assert revoked.status_code == 204

    assert client.get(f"/api/v1/invites/{token}").json()["status"] == "revoked"


def test_inviting_the_same_address_twice_changes_one_invitation(
    client: TestClient, owner: Actor
) -> None:
    """Two live links promising different things is a question nobody can answer."""
    board_id = owner.create_board()
    for role in ("viewer", "editor"):
        client.post(
            f"/api/v1/boards/{board_id}/invites",
            json={"email": "twice@meadow-tests.dev", "role": role},
            headers=owner.auth,
        )

    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    assert len(state["invitations"]) == 1
    assert state["invitations"][0]["role"] == "editor"


def test_inviting_never_lowers_an_existing_member(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """Inviting is an offer; demoting is the dropdown beside a name already on the list.

    They are different controls because they are different intentions, and folding them
    together would make "share this with Priya as a viewer" quietly take Priya's edit
    access away.
    """
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    client.post(
        f"/api/v1/boards/{board_id}/invites",
        json={"email": outsider.email, "role": "viewer"},
        headers=owner.auth,
    )
    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).json()["role"] == (
        "editor"
    )

    # The dropdown does lower them, because that is what it says it does.
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "viewer"},
        headers=owner.auth,
    )
    assert client.get(f"/api/v1/boards/{board_id}", headers=outsider.auth).json()["role"] == (
        "viewer"
    )


def test_only_an_owner_may_invite(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )

    assert (
        client.post(
            f"/api/v1/boards/{board_id}/invites",
            json={"email": "friend@meadow-tests.dev", "role": "editor"},
            headers=outsider.auth,
        ).status_code
        == 403
    )


def test_an_invitation_cannot_be_revoked_from_another_board(
    client: TestClient, owner: Actor, make_user: Any
) -> None:
    """The invitation id alone finds the row, so the board id has to be checked too."""
    stranger = make_user("Stranger")
    mine = owner.create_board()
    theirs = stranger.create_board()

    client.post(
        f"/api/v1/boards/{mine}/invites",
        json={"email": "target@meadow-tests.dev", "role": "viewer"},
        headers=owner.auth,
    )
    state = client.get(f"/api/v1/boards/{mine}/share", headers=owner.auth).json()
    invitation_id = state["invitations"][0]["id"]

    # Owner of a different board, using their own perfectly valid owner credentials.
    client.delete(f"/api/v1/boards/{theirs}/invites/{invitation_id}", headers=stranger.auth)

    still_there = client.get(f"/api/v1/boards/{mine}/share", headers=owner.auth).json()
    assert len(still_there["invitations"]) == 1


# --- the doors agreeing -------------------------------------------------------------


@pytest.mark.parametrize("mode", ["restricted", "public"])
def test_a_deleted_board_opens_for_nobody(
    client: TestClient, owner: Actor, mode: str
) -> None:
    board_id = owner.create_board()
    _share(client, owner, board_id, mode, "editor")
    link = _link_token(client, owner, board_id) if mode == "public" else None
    token = owner.ws_token(board_id)["token"]

    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    assert expect_close(client, board_id, token) == WS_FORBIDDEN
    if link is not None:
        assert client.get(f"/api/v1/share/{link}").status_code == 404
