"""The board password, which outranks every other answer about access.

The point of the feature is a single sentence - a board with a password does not open
until somebody types it, whoever they are - and the tests below are that sentence asked
once per way in. The owner is included on purpose and is the case most likely to be
"fixed" by somebody later: an exemption for the person who set it would make the
control weaker than its label, and it is exactly the kind of convenience that gets
added without anybody noticing it is a hole.

The other half is that the password is checked *live*. A pass proves a password at a
version, so changing the password has to stop the people already holding one - not at
the next reload, not in fifteen minutes. That is `password_version`, and it is asserted
here through the REST mint and through the socket.
"""

from typing import Any

from pycrdt import Doc
from starlette.testclient import TestClient

from tests import ywire
from tests.conftest import Actor
from tests.wsclient import (
    WS_FORBIDDEN,
    board_objects,
    drain_until_update,
    expect_close,
    make_update,
    ws_url,
)

PASSWORD = "hollow-elm-42"
OTHER = "hollow-elm-43"


def _set_password(
    client: TestClient, actor: Actor, board_id: str, password: str = PASSWORD
) -> Any:
    return client.put(
        f"/api/v1/boards/{board_id}/password",
        json={"password": password},
        headers=actor.auth,
    )


def _verify(
    client: TestClient,
    actor: Actor,
    board_id: str,
    password: str = PASSWORD,
    link_token: str | None = None,
) -> Any:
    body: dict[str, Any] = {"password": password}
    if link_token is not None:
        body["link_token"] = link_token
    return client.post(
        f"/api/v1/boards/{board_id}/password/verify", json=body, headers=actor.auth
    )


def _mint(
    client: TestClient, actor: Actor, board_id: str, pass_token: str | None = None
) -> Any:
    body: dict[str, Any] = {"board_id": board_id}
    if pass_token is not None:
        body["pass_token"] = pass_token
    return client.post("/api/v1/ws-token", json=body, headers=actor.auth)


def _share(client: TestClient, owner: Actor, board_id: str, role: str = "editor") -> str:
    client.put(
        f"/api/v1/boards/{board_id}/share",
        json={"mode": "public", "role": role},
        headers=owner.auth,
    )
    state = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).json()
    url = state["link_url"]
    assert url is not None
    token: str = url.split("?k=", 1)[1].split("#", 1)[0]
    return token


# --- setting it ------------------------------------------------------------------


def test_a_board_starts_with_no_password(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    board = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()
    assert board["has_password"] is False
    # And nothing is being asked for, so an ordinary mint still works.
    assert _mint(client, owner, board_id).status_code == 200


def test_only_the_owner_may_set_one(client: TestClient, owner: Actor, outsider: Actor) -> None:
    """An editor may not put a password on somebody else's board.

    It decides who may be here, so it belongs with the rest of sharing: an editor who
    could set one could shut the owner out of their own board until they cleared it.
    """
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )
    assert _set_password(client, outsider, board_id).status_code == 403
    assert _set_password(client, owner, board_id).status_code == 200


def test_the_password_is_never_sent_back(client: TestClient, owner: Actor) -> None:
    """Only the fact of one. The board response says `has_password` and nothing else.

    Worth its own test because the obvious way to build the menu - "show the owner what
    it is" - would put a board's password in every board list response the client makes.
    """
    board_id = owner.create_board()
    _set_password(client, owner, board_id)

    body = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).text
    assert PASSWORD not in body
    assert '"has_password":true' in body.replace(" ", "")

    share = client.get(f"/api/v1/boards/{board_id}/share", headers=owner.auth).text
    assert PASSWORD not in share


def test_a_short_password_is_refused(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    assert _set_password(client, owner, board_id, "abc").status_code == 422


# --- it applies to everybody -----------------------------------------------------


def test_the_owner_is_asked_too(client: TestClient, owner: Actor) -> None:
    """The whole feature, in one assertion.

    An owner who sets a password and is then waved through has not set a password; they
    have set one on other people. This is the test that says so, and the one to read
    before making the owner's life easier.
    """
    board_id = owner.create_board()
    _set_password(client, owner, board_id)

    refused = _mint(client, owner, board_id)
    assert refused.status_code == 403
    assert refused.json()["detail"] == "password required"

    pass_token = _verify(client, owner, board_id).json()["pass_token"]
    assert _mint(client, owner, board_id, pass_token).status_code == 200


def test_a_member_is_asked_too(client: TestClient, owner: Actor, outsider: Actor) -> None:
    board_id = owner.create_board()
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )
    _set_password(client, owner, board_id)

    assert _mint(client, outsider, board_id).json()["detail"] == "password required"
    pass_token = _verify(client, outsider, board_id).json()["pass_token"]
    assert _mint(client, outsider, board_id, pass_token).status_code == 200


def test_a_public_link_does_not_get_past_it(client: TestClient, owner: Actor) -> None:
    """"Anyone with the link" stops meaning anyone the moment a password is set.

    The link is a capability for a *role*, and the password is in front of the role. A
    visitor holding a perfectly good editor link is refused, and told which of the two
    problems they have so the client can show a prompt rather than a dead end.
    """
    board_id = owner.create_board()
    link = _share(client, owner, board_id)
    _set_password(client, owner, board_id)

    public = client.get(f"/api/v1/share/{link}").json()
    assert public["has_password"] is True
    # And no write is being promised to somebody who has not got in yet.
    assert public["can_write"] is False

    refused = client.post(f"/api/v1/share/{link}/ws-token")
    assert refused.status_code == 403
    assert refused.json()["detail"] == "password required"


def test_a_guest_gets_in_with_the_password(client: TestClient, owner: Actor) -> None:
    """No account at all, and the link is the standing to be asked."""
    board_id = owner.create_board()
    link = _share(client, owner, board_id)
    _set_password(client, owner, board_id)

    answered = client.post(
        f"/api/v1/share/{link}/password/verify", json={"password": PASSWORD}
    )
    assert answered.status_code == 200
    pass_token = answered.json()["pass_token"]

    minted = client.post(
        f"/api/v1/share/{link}/ws-token", json={"pass_token": pass_token}
    )
    assert minted.status_code == 200
    assert minted.json()["can_write"] is True


def test_a_wrong_guess_gets_nothing(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    link = _share(client, owner, board_id)
    _set_password(client, owner, board_id)

    assert _verify(client, owner, board_id, OTHER).status_code == 403
    assert (
        client.post(
            f"/api/v1/share/{link}/password/verify", json={"password": OTHER}
        ).status_code
        == 403
    )


def test_a_stranger_cannot_use_it_as_an_oracle(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    """No role and no link means no guess, and the refusal says nothing about the board.

    Without this the verify route would answer "wrong password" for any board id a
    signed-in stranger cared to type, which both confirms the id is real and hands them
    an unlimited guessing endpoint.
    """
    board_id = owner.create_board()
    _set_password(client, owner, board_id)

    refused = _verify(client, outsider, board_id)
    assert refused.status_code == 403
    assert refused.json()["detail"] == "no access"


# --- the pass -------------------------------------------------------------------


def test_a_pass_is_scoped_to_one_board(client: TestClient, owner: Actor) -> None:
    """An authentic pass for board A opens nothing on board B."""
    first = owner.create_board("First")
    second = owner.create_board("Second")
    _set_password(client, owner, first)
    _set_password(client, owner, second, OTHER)

    pass_token = _verify(client, owner, first).json()["pass_token"]
    assert _mint(client, owner, second, pass_token).json()["detail"] == "password required"


def test_a_forged_pass_proves_nothing(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _set_password(client, owner, board_id)

    pass_token = _verify(client, owner, board_id).json()["pass_token"]
    # Same shape, last character of the signature flipped.
    tampered = pass_token[:-1] + ("0" if pass_token[-1] != "0" else "1")
    assert _mint(client, owner, board_id, tampered).json()["detail"] == "password required"


def test_changing_the_password_retires_every_pass(client: TestClient, owner: Actor) -> None:
    """The reason to change one is that the old one travelled. So it has to bite.

    A pass carries the version it was minted at, and every set bumps it. Nothing has to
    be swept and nothing waits for an expiry.
    """
    board_id = owner.create_board()
    _set_password(client, owner, board_id)
    pass_token = _verify(client, owner, board_id).json()["pass_token"]
    assert _mint(client, owner, board_id, pass_token).status_code == 200

    _set_password(client, owner, board_id, OTHER)
    assert _mint(client, owner, board_id, pass_token).json()["detail"] == "password required"

    fresh = _verify(client, owner, board_id, OTHER).json()["pass_token"]
    assert _mint(client, owner, board_id, fresh).status_code == 200


def test_removing_the_password_opens_the_board_again(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _set_password(client, owner, board_id)
    assert _mint(client, owner, board_id).status_code == 403

    cleared = client.delete(f"/api/v1/boards/{board_id}/password", headers=owner.auth)
    assert cleared.status_code == 200
    assert cleared.json()["has_password"] is False
    assert _mint(client, owner, board_id).status_code == 200


def test_an_owner_who_forgot_it_can_still_take_it_off(client: TestClient, owner: Actor) -> None:
    """Neither setting nor clearing asks for the current password.

    The deliberate escape hatch, and the reason a forgotten password costs a click
    rather than a board. Asserted so nobody later "hardens" it into a way to lose one.
    """
    board_id = owner.create_board()
    _set_password(client, owner, board_id)
    cleared = client.delete(f"/api/v1/boards/{board_id}/password", headers=owner.auth)
    assert cleared.status_code == 200
    assert _set_password(client, owner, board_id, OTHER).status_code == 200


# --- the socket, which is the thing actually being protected ---------------------


def test_the_socket_refuses_a_token_minted_before_the_password(
    client: TestClient, owner: Actor
) -> None:
    """The handshake asks again, because the mint happened up to sixty seconds ago.

    This is the window an owner cares about: they set a password *because* somebody is
    on the board, and a connection that was authorised a moment earlier must not survive
    it. The eviction closes the live sockets; this is what stops the token reconnecting.
    """
    board_id = owner.create_board()
    minted = owner.ws_token(board_id)
    _set_password(client, owner, board_id)

    assert expect_close(client, board_id, minted["token"]) == WS_FORBIDDEN


def test_the_socket_opens_and_writes_with_a_pass(client: TestClient, owner: Actor) -> None:
    """The other side of it: having typed the password, everything works as before.

    Asserted through a real write rather than a successful connect, because a password
    that quietly left everybody on a read-only channel would pass a weaker test and be
    useless.
    """
    board_id = owner.create_board()
    _set_password(client, owner, board_id)
    pass_token = _verify(client, owner, board_id).json()["pass_token"]
    minted = _mint(client, owner, board_id, pass_token).json()
    assert minted["can_write"] is True

    with client.websocket_connect(ws_url(board_id, minted["token"])) as websocket:
        websocket.send_bytes(ywire.sync_update(make_update(box={"type": "rect"})))
        websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(websocket)

    # Read it back through a second connection, which needs its own pass and its own
    # mint - so this is the round trip a person actually makes.
    second = _verify(client, owner, board_id).json()["pass_token"]
    assert "box" in board_objects(client, owner, board_id, second)
