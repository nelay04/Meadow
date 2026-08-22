"""The harness both OAuth test files drive the real flow through.

The network is stubbed at exactly one seam - the provider module's `fetch_profile`,
which owns every call that leaves the process - so everything on top of it in a test is
the real router, the real state handling, the real database, and the real session
issuing. The payload parsing below that seam is pure and is tested directly in each
provider's own file.

Shared rather than copied because the two flows are the same flow: if a check ever
holds for GitHub and not for Google, that is the bug this arrangement is meant to make
impossible to write.
"""

import asyncio
import uuid
from types import ModuleType
from typing import Any

import asyncpg
import pytest
from pydantic import SecretStr
from starlette.testclient import TestClient

from app.config import settings
from app.services.oauth.base import OAuthProfile
from tests.conftest import TEST_DATABASE_URL, _asyncpg_dsn

STATE_COOKIE = "meadow_oauth_state"
REFRESH_COOKIE = "meadow_refresh"

WEB = "http://localhost:3012"


def configure(monkeypatch: pytest.MonkeyPatch, provider: str) -> None:
    """Turn one provider on. Without this its endpoints are a 404, on purpose."""
    monkeypatch.setattr(settings, f"{provider}_client_id", "test-client-id")
    monkeypatch.setattr(settings, f"{provider}_client_secret", SecretStr("test-client-secret"))
    monkeypatch.setattr(
        settings, f"{provider}_callback_url", f"{WEB}/api/v1/auth/{provider}/callback"
    )
    monkeypatch.setattr(settings, "web_base_url", WEB)


PASSWORD = "correct-horse-battery-staple"


def register(client: TestClient, email: str | None = None, name: str = "Test User") -> str:
    """An account that already exists, which is what a sign-in intent needs.

    With no SMTP configured the account is opened immediately, so this returns something
    usable. Returns the address.
    """
    address = email or f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    response = client.post(
        "/api/v1/auth/register",
        json={"email": address, "password": PASSWORD, "display_name": name},
    )
    assert response.status_code == 202, response.text
    client.cookies.clear()
    return address


def drop_password(email: str) -> None:
    """Turn an account into one that can only sign in through a provider.

    Reaching this state through the API is no longer possible - registration is the
    password form, and a provider sign-in refuses an address that has never registered -
    but accounts created before that rule still exist and `login` has a branch for them.
    A branch nothing exercises is a branch nobody knows is broken.

    Its own short-lived connection, for the reason `conftest` gives: `app.db.engine` is
    bound to the client's portal loop, and a second loop touching it deadlocks.
    """

    async def run() -> None:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            await conn.execute("update users set password_hash = null where email = $1", email)
        finally:
            await conn.close()

    asyncio.run(run())


def state_cookie_path(provider: str) -> str:
    return f"/api/v1/auth/{provider}"


def stub_profile(
    monkeypatch: pytest.MonkeyPatch, module: ModuleType, result: OAuthProfile | Exception
) -> None:
    async def fake_fetch_profile(code: str) -> OAuthProfile:
        assert code != ""
        if isinstance(result, Exception):
            raise result
        return result

    monkeypatch.setattr(module, "fetch_profile", fake_fetch_profile)


def start_flow(
    client: TestClient,
    provider: str,
    next_path: str | None = None,
    intent: str = "login",
    keep_cookies: bool = False,
) -> str:
    """Begin the dance and return the state the browser is now holding.

    Cookies are cleared first so a flow starts from a browser with no session, which is
    what signing in and registering look like. `keep_cookies` is for connecting a
    provider, where the session is the whole point: the refresh cookie is what tells the
    server which account is asking.
    """
    if not keep_cookies:
        client.cookies.clear()
    params = [f"intent={intent}"]
    if next_path is not None:
        params.append(f"next={next_path}")
    query = "?" + "&".join(params)
    response = client.get(f"/api/v1/auth/{provider}/start{query}", follow_redirects=False)
    if response.status_code != 302:
        # A refused start (no session behind a link attempt) redirects to the app rather
        # than to the provider. The caller asserts on it.
        assert response.status_code == 303, response.text
        return ""
    state = client.cookies.get(STATE_COOKIE)
    assert state is not None
    return state


def sign_in_with_password(client: TestClient, email: str) -> None:
    """Put a real session in the client's cookie jar, the ordinary way."""
    response = client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})
    assert response.status_code == 200, response.text


def complete_flow(
    client: TestClient, provider: str, state: str, code: str = "auth-code"
) -> Any:
    return client.get(
        f"/api/v1/auth/{provider}/callback?code={code}&state={state}", follow_redirects=False
    )


def sign_in(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    module: ModuleType,
    who: OAuthProfile,
    intent: str = "login",
) -> str:
    """A whole successful sign-in. Returns an access token for the resulting session."""
    stub_profile(monkeypatch, module, who)
    state = start_flow(client, module.PROVIDER, intent=intent)
    response = complete_flow(client, module.PROVIDER, state)
    assert response.status_code == 303, response.text
    assert REFRESH_COOKIE in response.cookies

    refreshed = client.post("/api/v1/auth/refresh")
    assert refreshed.status_code == 200, refreshed.text
    token: str = refreshed.json()["access_token"]
    return token


def me(client: TestClient, token: str) -> dict[str, Any]:
    response = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body
