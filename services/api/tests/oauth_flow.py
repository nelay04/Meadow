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

from types import ModuleType
from typing import Any

import pytest
from pydantic import SecretStr
from starlette.testclient import TestClient

from app.config import settings
from app.services.oauth.base import OAuthProfile

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


def start_flow(client: TestClient, provider: str, next_path: str | None = None) -> str:
    """Begin the dance and return the state the browser is now holding."""
    client.cookies.clear()
    query = "" if next_path is None else f"?next={next_path}"
    response = client.get(f"/api/v1/auth/{provider}/start{query}", follow_redirects=False)
    assert response.status_code == 302, response.text
    state = client.cookies.get(STATE_COOKIE)
    assert state is not None
    return state


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
) -> str:
    """A whole successful sign-in. Returns an access token for the resulting session."""
    stub_profile(monkeypatch, module, who)
    state = start_flow(client, module.PROVIDER)
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
