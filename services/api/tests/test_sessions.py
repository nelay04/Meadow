"""The sessions log: which browsers are signed in, and ending one of them.

A session is a refresh-token family, so these tests drive two "browsers" over the one
TestClient by clearing its cookie jar between sign-ins and putting back the raw refresh
cookie belonging to whichever browser is meant to be speaking.
"""

import uuid
from typing import Any

import pytest
from starlette.testclient import TestClient

REFRESH_COOKIE = "meadow_refresh"

CHROME_ON_WINDOWS = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/128.0.0.0 Safari/537.36"
)
SAFARI_ON_IPHONE = (
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
)


def _register(client: TestClient, email: str, password: str) -> None:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": password, "display_name": "Someone"},
    )
    assert response.status_code == 202, response.text


class Browser:
    """One signed-in browser: its access token and its own refresh cookie."""

    def __init__(self, client: TestClient, access_token: str, refresh: str) -> None:
        self.client = client
        self.access_token = access_token
        self.refresh = refresh

    def speak(self) -> None:
        """Make this browser the one the shared client is pretending to be."""
        self.client.cookies.clear()
        self.client.cookies.set(REFRESH_COOKIE, self.refresh)

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def sessions(self) -> list[dict[str, Any]]:
        self.speak()
        response = self.client.get("/api/v1/auth/sessions", headers=self.auth)
        assert response.status_code == 200, response.text
        body: list[dict[str, Any]] = response.json()
        return body


def _sign_in(client: TestClient, email: str, password: str, user_agent: str) -> Browser:
    client.cookies.clear()
    response = client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
        headers={"user-agent": user_agent},
    )
    assert response.status_code == 200, response.text
    refresh = response.cookies[REFRESH_COOKIE]
    client.cookies.clear()
    return Browser(client, response.json()["access_token"], refresh)


@pytest.fixture
def account(client: TestClient) -> tuple[str, str]:
    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    password = "correct-horse-battery-staple"
    _register(client, email, password)
    return email, password


def test_each_login_is_its_own_session(client: TestClient, account: tuple[str, str]) -> None:
    """Two browsers, two families, two rows - and each sees itself marked as current."""
    email, password = account
    laptop = _sign_in(client, email, password, CHROME_ON_WINDOWS)
    phone = _sign_in(client, email, password, SAFARI_ON_IPHONE)

    from_laptop = laptop.sessions()
    assert len(from_laptop) == 2
    assert {row["label"] for row in from_laptop} == {"Chrome on Windows", "Safari on iOS"}
    assert [row["current"] for row in from_laptop].count(True) == 1
    current = next(row for row in from_laptop if row["current"])
    assert current["label"] == "Chrome on Windows"
    assert current["device"] == "desktop"

    # The same two sessions, and the mark moves to whoever is asking.
    from_phone = phone.sessions()
    assert {row["id"] for row in from_phone} == {row["id"] for row in from_laptop}
    assert next(row for row in from_phone if row["current"])["label"] == "Safari on iOS"
    assert next(row for row in from_phone if row["current"])["device"] == "mobile"


def test_a_refresh_keeps_the_sign_in_time_and_moves_the_activity(
    client: TestClient, account: tuple[str, str]
) -> None:
    """Rotation is the same session continuing: one row, same id, same start.

    The regression this guards is the obvious way to build the list - reading the login
    time off the live token - which would make every session claim to have begun at its
    last renewal.
    """
    email, password = account
    laptop = _sign_in(client, email, password, CHROME_ON_WINDOWS)
    before = laptop.sessions()
    assert len(before) == 1

    laptop.speak()
    refreshed = client.post("/api/v1/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    laptop = Browser(
        client, refreshed.json()["access_token"], refreshed.cookies[REFRESH_COOKIE]
    )

    after = laptop.sessions()
    assert len(after) == 1, "a rotation must not look like a second browser"
    assert after[0]["id"] == before[0]["id"]
    assert after[0]["signed_in_at"] == before[0]["signed_in_at"]
    assert after[0]["last_active_at"] >= before[0]["last_active_at"]
    assert after[0]["current"] is True


def test_a_fresh_session_did_not_sign_in_after_it_was_last_active(
    client: TestClient, account: tuple[str, str]
) -> None:
    """Both timestamps have to come off one clock.

    They did not: the login time was taken in Python and the activity time by Postgres,
    so a session a second old reported having signed in *after* it was last seen. Small,
    but this is a security screen, and a row that contradicts itself is a row nobody
    trusts the rest of.
    """
    email, password = account
    row = _sign_in(client, email, password, CHROME_ON_WINDOWS).sessions()[0]
    assert row["signed_in_at"] <= row["last_active_at"]


def test_revoking_a_session_signs_that_browser_out(
    client: TestClient, account: tuple[str, str]
) -> None:
    """The point of the screen: end a session you do not recognise, from the one you do."""
    email, password = account
    laptop = _sign_in(client, email, password, CHROME_ON_WINDOWS)
    phone = _sign_in(client, email, password, SAFARI_ON_IPHONE)

    stranger = next(row for row in laptop.sessions() if not row["current"])
    laptop.speak()
    killed = client.delete(f"/api/v1/auth/sessions/{stranger['id']}", headers=laptop.auth)
    assert killed.status_code == 204, killed.text

    left = laptop.sessions()
    assert len(left) == 1
    assert left[0]["current"] is True

    # And the revoked browser cannot trade its cookie for a new access token.
    phone.speak()
    assert client.post("/api/v1/auth/refresh").status_code == 401


def test_a_session_cannot_end_itself(client: TestClient, account: tuple[str, str]) -> None:
    """409, not 204: it would revoke the cookie without clearing it. Logout does that."""
    email, password = account
    laptop = _sign_in(client, email, password, CHROME_ON_WINDOWS)
    mine = laptop.sessions()[0]

    laptop.speak()
    response = client.delete(f"/api/v1/auth/sessions/{mine['id']}", headers=laptop.auth)
    assert response.status_code == 409
    assert len(laptop.sessions()) == 1


def test_another_account_cannot_end_your_session(client: TestClient) -> None:
    """The one place a user names an id they did not get from their own list."""
    victim_email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    attacker_email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    password = "correct-horse-battery-staple"
    _register(client, victim_email, password)
    _register(client, attacker_email, password)

    victim = _sign_in(client, victim_email, password, CHROME_ON_WINDOWS)
    target = victim.sessions()[0]["id"]
    attacker = _sign_in(client, attacker_email, password, SAFARI_ON_IPHONE)

    attacker.speak()
    response = client.delete(f"/api/v1/auth/sessions/{target}", headers=attacker.auth)
    assert response.status_code == 404
    assert len(victim.sessions()) == 1


def test_sign_out_everywhere_else_keeps_this_browser(
    client: TestClient, account: tuple[str, str]
) -> None:
    email, password = account
    laptop = _sign_in(client, email, password, CHROME_ON_WINDOWS)
    phone = _sign_in(client, email, password, SAFARI_ON_IPHONE)
    tablet = _sign_in(client, email, password, "Mozilla/5.0 (Linux; Android 14) Chrome/128")

    laptop.speak()
    response = client.delete("/api/v1/auth/sessions", headers=laptop.auth)
    assert response.status_code == 200, response.text
    assert response.json() == {"revoked": 2}

    remaining = laptop.sessions()
    assert len(remaining) == 1
    assert remaining[0]["current"] is True

    for gone in (phone, tablet):
        gone.speak()
        assert client.post("/api/v1/auth/refresh").status_code == 401

    # Nothing left to revoke, and saying so is a fine answer rather than an error.
    laptop.speak()
    assert client.delete("/api/v1/auth/sessions", headers=laptop.auth).json() == {"revoked": 0}


def test_logging_out_takes_the_session_off_the_list(
    client: TestClient, account: tuple[str, str]
) -> None:
    """Logout already revoked the family. This is the assertion that the list agrees."""
    email, password = account
    laptop = _sign_in(client, email, password, CHROME_ON_WINDOWS)
    phone = _sign_in(client, email, password, SAFARI_ON_IPHONE)

    phone.speak()
    assert client.post("/api/v1/auth/logout").status_code == 204

    remaining = laptop.sessions()
    assert len(remaining) == 1
    assert remaining[0]["label"] == "Chrome on Windows"


def test_an_unknown_user_agent_is_still_a_session(
    client: TestClient, account: tuple[str, str]
) -> None:
    """A scripted client is signed in too, and the row says what little is known."""
    email, password = account
    scripted = _sign_in(client, email, password, "curl/8.5.0")
    row = scripted.sessions()[0]
    assert row["browser"] is None
    assert row["os"] is None
    assert row["label"] == "Unknown browser"
    assert row["user_agent"] == "curl/8.5.0"


def test_the_user_agent_parse_prefers_the_specific_name() -> None:
    """Every Chromium browser says "Chrome", and Chrome says "Safari"."""
    from app.services.useragent import parse

    edge = parse(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0"
    )
    assert edge.browser == "Edge"
    assert edge.os == "Windows"

    # An iPad claims to be a Macintosh, so the tablet has to be recognised first.
    ipad = parse(
        "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 "
        "(KHTML, like Gecko) Version/17.5 Safari/604.1"
    )
    assert ipad.os == "iPadOS"
    assert ipad.device == "tablet"

    assert parse(None).label() == "Unknown browser"
