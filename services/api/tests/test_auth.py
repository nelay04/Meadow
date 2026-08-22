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


def test_reusing_a_rotated_refresh_token_revokes_the_whole_family(client: TestClient) -> None:
    """Theft detection, per ARCHITECTURE 7.

    Whoever presents an already-rotated token proves a copy of the lineage exists.
    The correct response is to kill the family, which logs the real user out too -
    strictly better than leaving an attacker with an indefinitely renewing session.
    """
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
