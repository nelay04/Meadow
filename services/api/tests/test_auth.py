"""Registration, login, and refresh rotation. ARCHITECTURE 7."""

import uuid

import pytest
from starlette.testclient import TestClient

from tests.conftest import Actor

REFRESH_COOKIE = "meadow_refresh"


def _register(client: TestClient, email: str, password: str = "correct-horse-battery") -> dict:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Someone"},
    )
    return {"status": response.status_code, "body": response.json(), "cookies": response.cookies}


def _sign_up(client: TestClient, email: str, password: str = "correct-horse-battery") -> None:
    """Register and then log in, which is now two steps rather than one.

    The suite runs with no SMTP configured, and that path opens the account immediately
    rather than leaving it waiting on a mail nobody can read. `test_activation.py` is
    where the mail itself is exercised.
    """
    assert _register(client, email, password)["status"] == 202
    response = client.post("/api/v1/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200, response.text


def _hold(client: TestClient, token: str) -> None:
    """Make `token` the browser's only refresh cookie.

    Set where the server sets it. A bare `cookies.set` lands beside the server's copy
    rather than over it, and reading the jar back then fails on two cookies of one name.
    """
    client.cookies.clear()
    client.cookies.set(REFRESH_COOKIE, token, domain="testserver.local", path="/api/v1/auth")


def test_register_answers_with_a_pending_account_and_no_session(client: TestClient) -> None:
    """202, not 201: the row exists, the registration does not finish until the mail does.

    A session here would be a session for an account every other endpoint refuses, so
    there is none, and the tokens are gone from this response entirely.
    """
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    result = _register(client, email)

    assert result["status"] == 202
    assert result["body"] == {
        "email": email,
        # No SMTP in the tests, so the account is opened without the round trip.
        "activation_required": False,
        "activation_sent": False,
    }
    assert "access_token" not in result["body"]
    assert REFRESH_COOKIE not in result["cookies"]
    client.cookies.clear()


def test_a_new_account_has_a_personal_workspace(client: TestClient) -> None:
    """A new user must be able to create a board without first inventing a workspace."""
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _register(client, email)

    response = client.post(
        "/api/v1/auth/login", json={"email": email, "password": "correct-horse-battery"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["user"]["default_workspace_id"]
    client.cookies.clear()


def test_refresh_token_never_appears_in_the_response_body(client: TestClient) -> None:
    """It is httpOnly-cookie only, so page JavaScript cannot read it (ARCHITECTURE 7)."""
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _register(client, email)
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "correct-horse-battery"},
    )
    assert "refresh_token" not in response.json()
    assert REFRESH_COOKIE in response.cookies

    set_cookie = response.headers["set-cookie"]
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
    client.cookies.clear()


def test_email_is_case_insensitive(client: TestClient) -> None:
    """citext, so Alice@ and alice@ cannot become two accounts."""
    local = uuid.uuid4().hex[:12]
    assert _register(client, f"{local}@meadow-tests.dev")["status"] == 202
    client.cookies.clear()

    duplicate = _register(client, f"{local.upper()}@MEADOW-TESTS.DEV")
    assert duplicate["status"] == 409
    client.cookies.clear()


def test_login_rejects_a_wrong_password(client: TestClient) -> None:
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _register(client, email)
    client.cookies.clear()

    response = client.post("/api/v1/auth/login", json={"email": email, "password": "wrong-one-x"})
    assert response.status_code == 401


def test_an_unregistered_email_is_told_so_rather_than_refused_generically(
    client: TestClient,
) -> None:
    """A reversal, and a deliberate one.

    Login and registration used to answer every failure identically so neither could be
    used to enumerate accounts. That cost the two cases a real person actually hits - an
    address that never registered, and one that registered through another door - and
    both were told only "no". The trade is that account existence is now probeable, held
    down by the rate limits and nothing else, and no other fact about the account is
    revealed.
    """
    registered = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _register(client, registered)
    client.cookies.clear()

    wrong_password = client.post(
        "/api/v1/auth/login", json={"email": registered, "password": "wrong-one-x"}
    )
    no_such_user = client.post(
        "/api/v1/auth/login",
        json={"email": f"{uuid.uuid4().hex[:12]}@meadow-tests.dev", "password": "wrong-one-x"},
    )

    assert wrong_password.status_code == no_such_user.status_code == 401
    assert wrong_password.json()["detail"] == "invalid email or password"
    assert no_such_user.json()["detail"] == "email is not registered"


def test_registering_a_taken_email_says_it_is_taken(client: TestClient) -> None:
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _register(client, email)
    client.cookies.clear()

    again = _register(client, email)

    assert again["status"] == 409
    assert again["body"]["detail"] == "email is already registered"


def test_refresh_rotates_the_token(client: TestClient) -> None:
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    first = client.cookies[REFRESH_COOKIE]

    response = client.post("/api/v1/auth/refresh")
    assert response.status_code == 200
    assert response.json()["access_token"]

    second = client.cookies[REFRESH_COOKIE]
    assert second != first, "refresh must rotate, not re-issue the same token"
    client.cookies.clear()


def test_reusing_a_rotated_refresh_token_revokes_the_whole_family(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Theft detection, per ARCHITECTURE 7.

    Whoever presents an already-rotated token proves a copy of the lineage exists.
    The correct response is to kill the family, which logs the real user out too -
    strictly better than leaving an attacker with an indefinitely renewing session.

    The grace window is closed here on purpose. A replay that arrives within it is a
    browser asking twice at once rather than an attacker, and is covered by
    `test_a_refresh_racing_its_own_rotation_is_not_theft` below. This test is about
    the replay that arrives later, which is the one the defence exists for.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_rotation_grace_seconds", 0)
    # Recovery too: the replay below is the live token's own parent, which is the one
    # shape recovery is allowed to accept. The tests after this one cover it.
    monkeypatch.setattr(settings, "refresh_rotation_recovery_seconds", 0)

    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    stolen = client.cookies[REFRESH_COOKIE]

    assert client.post("/api/v1/auth/refresh").status_code == 200
    current = client.cookies[REFRESH_COOKIE]

    # The attacker redeems their stale copy.
    client.cookies.set(REFRESH_COOKIE, stolen)
    replay = client.post("/api/v1/auth/refresh")
    assert replay.status_code == 401
    assert "reuse" in replay.json()["detail"]

    # And the legitimate holder's token is dead too - that is the point.
    client.cookies.set(REFRESH_COOKIE, current)
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()


def test_a_refresh_racing_its_own_rotation_is_not_theft(client: TestClient) -> None:
    """One browser, two refreshes, same cookie. The session has to survive it.

    A reload has two page contexts alive at once - the old one tearing down and the
    new one booting - and the client's single-flight guard is a module variable, so it
    cannot see across them. Two tabs cannot see each other either. Both send the cookie
    they have, one rotation wins, and the loser arrives holding a token that is by then
    already spent.

    Read strictly that is indistinguishable from a replay, and the strict reading logged
    people out of working sessions on every reload once there was real latency in front
    of the API. The grace window says a token rotated a moment ago, in a family that is
    still healthy, is the same browser asking twice. A stolen token replayed later still
    kills the family: see the test above.
    """
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    original = client.cookies[REFRESH_COOKIE]

    winner = client.post("/api/v1/auth/refresh")
    assert winner.status_code == 200
    rotated = client.cookies[REFRESH_COOKIE]
    assert rotated != original

    # The loser, still holding the pre-rotation cookie.
    client.cookies.set(REFRESH_COOKIE, original)
    loser = client.post("/api/v1/auth/refresh")
    assert loser.status_code == 200, "a refresh racing its own rotation must not be theft"
    assert loser.json()["access_token"]

    # The grace path mints an access token and leaves the cookie alone, so the winner's
    # token is still the live one and the family was never revoked.
    client.cookies.set(REFRESH_COOKIE, rotated)
    assert client.post("/api/v1/auth/refresh").status_code == 200
    client.cookies.clear()


def test_a_rotation_the_browser_never_received_is_recovered(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The refresh happened here and the response never arrived there.

    A tab closing or reloading with the request in flight, or a dropped connection,
    leaves the browser holding the spent token while the server has moved on. Its next
    refresh comes up to fifteen minutes later, well past the grace window, and used to
    read as theft - which is the "logged out after a few minutes" this guards.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_rotation_grace_seconds", 0)

    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    kept = client.cookies[REFRESH_COOKIE]

    # The lost rotation: the server mints a new token nobody ever receives.
    assert client.post("/api/v1/auth/refresh").status_code == 200
    lost = client.cookies[REFRESH_COOKIE]
    _hold(client, kept)

    recovered = client.post("/api/v1/auth/refresh")
    assert recovered.status_code == 200, recovered.text
    fresh = client.cookies[REFRESH_COOKIE]
    assert fresh not in (kept, lost), "recovery must rotate and hand back a working cookie"

    # And the session carries on from the new cookie as normal.
    assert client.post("/api/v1/auth/refresh").status_code == 200

    # The token that went astray is now the one out of place, and presenting it is reuse.
    _hold(client, lost)
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()


def test_recovery_is_not_a_way_round_theft_detection(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Both holders of a lineage cannot keep taking turns.

    An attacker who presents the live token's parent is recovered once, exactly as the
    real browser would be. But the token that mints names the attacker's copy as its
    parent, so when the real user comes back with theirs it is plain reuse and the
    family dies - the same outcome as without recovery, one step later.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_rotation_grace_seconds", 0)

    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    stolen = client.cookies[REFRESH_COOKIE]

    assert client.post("/api/v1/auth/refresh").status_code == 200
    legitimate = client.cookies[REFRESH_COOKIE]

    _hold(client, stolen)
    assert client.post("/api/v1/auth/refresh").status_code == 200
    attacker = client.cookies[REFRESH_COOKIE]

    _hold(client, legitimate)
    replay = client.post("/api/v1/auth/refresh")
    assert replay.status_code == 401
    assert "reuse" in replay.json()["detail"]

    _hold(client, attacker)
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()


def test_an_old_ancestor_is_still_reuse(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Only the live token's direct parent is recoverable, never anything further back."""
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_rotation_grace_seconds", 0)

    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    ancestor = client.cookies[REFRESH_COOKIE]

    assert client.post("/api/v1/auth/refresh").status_code == 200
    assert client.post("/api/v1/auth/refresh").status_code == 200
    current = client.cookies[REFRESH_COOKIE]

    _hold(client, ancestor)
    assert client.post("/api/v1/auth/refresh").status_code == 401

    _hold(client, current)
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()


def test_logout_revokes_the_session(client: TestClient) -> None:
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    _sign_up(client, email)
    token = client.cookies[REFRESH_COOKIE]

    assert client.post("/api/v1/auth/logout").status_code == 204

    client.cookies.set(REFRESH_COOKIE, token)
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()


def test_protected_routes_require_a_bearer_token(client: TestClient) -> None:
    assert client.get("/api/v1/auth/me").status_code == 401
    assert client.get("/api/v1/boards").status_code == 401
    bad = client.get("/api/v1/auth/me", headers={"Authorization": "Bearer nonsense"})
    assert bad.status_code == 401


def test_a_ws_token_is_not_accepted_as_a_bearer_token(client: TestClient, owner: Actor) -> None:
    """Both are signed with the same key, so `typ` has to be checked on decode."""
    board_id = owner.create_board()
    ws_token = owner.ws_token(board_id)["token"]

    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {ws_token}"})
    assert response.status_code == 401


def test_short_passwords_are_rejected(client: TestClient) -> None:
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"{uuid.uuid4().hex[:12]}@meadow-tests.dev",
            "password": "short",
            "display_name": "S",
        },
    )
    assert response.status_code == 422


@pytest.mark.usefixtures("client")
def test_login_is_rate_limited(client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
    """5/min/IP, per ARCHITECTURE 7. The suite runs with limits off, so turn them on."""
    from app.config import settings

    monkeypatch.setattr(settings, "rate_limit_enabled", True)
    monkeypatch.setattr(settings, "rate_limit_login", "3/60")

    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    codes = [
        client.post(
            "/api/v1/auth/login", json={"email": email, "password": "wrong-one-x"}
        ).status_code
        for _ in range(5)
    ]
    assert codes[:3] == [401, 401, 401]
    assert 429 in codes[3:]
