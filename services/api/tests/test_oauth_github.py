"""GitHub sign-in: state, account matching, and what a profile edit may touch.

The flow harness lives in `tests/oauth_flow.py` and is shared with the Google file,
because the two flows are the same flow with a different provider module bolted in.
What is here is either GitHub-specific (its payloads, its scopes) or a rule that has to
hold for every provider and is easiest to read written out once.
"""

import uuid
from typing import Any

import pytest
from starlette.testclient import TestClient

from app.config import settings
from app.services.oauth import github
from tests.conftest import Actor
from tests.oauth_flow import (
    REFRESH_COOKIE,
    STATE_COOKIE,
    WEB,
    configure,
    me,
    state_cookie_path,
)
from tests.oauth_flow import complete_flow as complete
from tests.oauth_flow import sign_in as sign_in_with
from tests.oauth_flow import start_flow as start
from tests.oauth_flow import stub_profile as stub


@pytest.fixture(autouse=True)
def github_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    configure(monkeypatch, github.PROVIDER)


def profile(
    *,
    provider_user_id: str = "1234567",
    username: str = "octocat",
    name: str | None = "The Octocat",
    email: str | None = None,
    avatar_url: str | None = "https://avatars.githubusercontent.com/u/1234567?v=4",
) -> github.GitHubProfile:
    return github.GitHubProfile(
        provider_user_id=provider_user_id,
        username=username,
        name=name,
        email=email or f"{uuid.uuid4().hex[:12]}@meadow-tests.dev",
        avatar_url=avatar_url,
        profile_url=f"https://github.com/{username}",
    )


def stub_profile(monkeypatch: pytest.MonkeyPatch, result: github.GitHubProfile | Exception) -> None:
    stub(monkeypatch, github, result)


def start_flow(client: TestClient, next_path: str | None = None) -> str:
    return start(client, github.PROVIDER, next_path)


def complete_flow(client: TestClient, state: str, code: str = "auth-code") -> Any:
    return complete(client, github.PROVIDER, state, code)


def sign_in(client: TestClient, monkeypatch: pytest.MonkeyPatch, who: github.GitHubProfile) -> str:
    return sign_in_with(client, monkeypatch, github, who)


# --- configuration -------------------------------------------------------------


def test_providers_advertises_github_only_when_it_is_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    assert client.get("/api/v1/auth/providers").json()["github"] is True

    monkeypatch.setattr(settings, "github_client_id", "")
    assert client.get("/api/v1/auth/providers").json()["github"] is False
    # And the endpoint behind the button is gone too, not just the button.
    assert client.get("/api/v1/auth/github/start", follow_redirects=False).status_code == 404


# --- state ---------------------------------------------------------------------


def test_start_sends_the_browser_to_github_with_a_state_it_also_holds(
    client: TestClient,
) -> None:
    client.cookies.clear()
    response = client.get("/api/v1/auth/github/start", follow_redirects=False)

    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://github.com/login/oauth/authorize?")
    assert "client_id=test-client-id" in location
    assert "scope=read%3Auser+user%3Aemail" in location

    state = client.cookies.get(STATE_COOKIE)
    assert state is not None and len(state) > 20
    assert f"state={state}" in location
    # The browser must hold it, and page scripts must not.
    assert "HttpOnly" in response.headers["set-cookie"]


def test_callback_refuses_a_state_the_browser_never_received(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The login-CSRF case: a callback URL minted elsewhere, replayed into this browser."""
    stub_profile(monkeypatch, profile())
    start_flow(client)
    client.cookies.delete(STATE_COOKIE, path=state_cookie_path(github.PROVIDER))

    response = complete_flow(client, "some-state-from-another-browser")

    assert response.status_code == 303
    assert response.headers["location"] == f"{WEB}/?auth_error=state&provider=github#/"
    assert REFRESH_COOKIE not in response.cookies


def test_callback_refuses_a_state_that_does_not_match_the_cookie(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_profile(monkeypatch, profile())
    start_flow(client)

    response = complete_flow(client, "not-the-state-in-the-cookie")

    assert "auth_error=state" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_a_state_works_exactly_once(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Redemption is GETDEL, so a replayed callback URL finds nothing."""
    stub_profile(monkeypatch, profile())
    state = start_flow(client)
    assert complete_flow(client, state).status_code == 303

    # Put the browser back exactly as it was and try the same URL again.
    client.cookies.set(STATE_COOKIE, state, path=state_cookie_path(github.PROVIDER))
    replay = complete_flow(client, state)

    assert "auth_error=state" in replay.headers["location"]


def test_a_refusal_on_githubs_consent_screen_is_not_an_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_profile(monkeypatch, profile())
    start_flow(client)
    response = client.get(
        "/api/v1/auth/github/callback?error=access_denied", follow_redirects=False
    )

    assert "auth_error=denied" in response.headers["location"]


# --- account matching ----------------------------------------------------------


def test_first_sign_in_creates_an_account_with_a_personal_workspace(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile(name="The Octocat", username="octocat")
    body = me(client, sign_in(client, monkeypatch, who))

    assert body["email"] == who.email
    # GitHub's name by default, and the login only when there is no name.
    assert body["display_name"] == "The Octocat"
    assert body["avatar_url"] == who.avatar_url
    assert body["avatar_source"] == "github"
    assert body["has_password"] is False
    assert body["default_workspace_id"]
    assert body["identities"]["github"]["username"] == "octocat"
    assert body["identities"]["github"]["profile_url"] == "https://github.com/octocat"


def test_an_account_with_no_github_name_falls_back_to_the_login(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    body = me(client, sign_in(client, monkeypatch, profile(name=None, username="ghost")))
    assert body["display_name"] == "ghost"


def test_the_same_email_is_the_same_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, make_user: Any
) -> None:
    """Email is the account identity: signing in with GitHub must not fork the account."""
    actor: Actor = make_user("Password Person")
    before = me(client, actor.access_token)

    after = me(client, sign_in(client, monkeypatch, profile(email=actor.email)))

    assert after["id"] == before["id"]
    assert after["default_workspace_id"] == before["default_workspace_id"]
    # Linking is not a request to be renamed by GitHub.
    assert after["display_name"] == "Password Person"
    assert after["has_password"] is True
    assert after["identities"]["github"]["username"] == "octocat"


def test_signing_in_again_after_a_github_rename_is_the_same_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The match is on GitHub's numeric id, so a rename over there changes nothing here."""
    first = profile(provider_user_id="42", username="octocat")
    created = me(client, sign_in(client, monkeypatch, first))

    renamed = profile(
        provider_user_id="42", username="mona", name="Mona Lisa", email=first.email
    )
    again = me(client, sign_in(client, monkeypatch, renamed))

    assert again["id"] == created["id"]
    assert again["identities"]["github"]["username"] == "mona"
    # The stored identity follows GitHub; the account's own fields do not.
    assert again["identities"]["github"]["name"] == "Mona Lisa"
    assert again["display_name"] == "The Octocat"


def test_a_second_github_account_cannot_claim_a_linked_one(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Otherwise whoever adds a shared email to a GitHub account displaces the first."""
    first = profile(provider_user_id="1", username="first")
    me(client, sign_in(client, monkeypatch, first))

    intruder = profile(provider_user_id="2", username="second", email=first.email)
    stub_profile(monkeypatch, intruder)
    state = start_flow(client)
    response = complete_flow(client, state)

    assert "auth_error=conflict" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_an_unverified_github_email_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unverified address is a claim, and matching on a claim is account takeover."""
    stub_profile(monkeypatch, github.EmailUnverified("no verified email"))
    state = start_flow(client)
    response = complete_flow(client, state)

    assert "auth_error=unverified_email" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_password_login_is_refused_for_a_github_only_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile()
    sign_in(client, monkeypatch, who)
    client.cookies.clear()

    response = client.post(
        "/api/v1/auth/login", json={"email": who.email, "password": "correct-horse-battery"}
    )

    assert response.status_code == 401
    # The same message a wrong password gets: which accounts use GitHub is not
    # something an anonymous caller may enumerate.
    assert response.json()["detail"] == "invalid email or password"


def test_registering_over_a_github_account_does_not_leak_that_it_exists(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile()
    sign_in(client, monkeypatch, who)
    client.cookies.clear()

    response = client.post(
        "/api/v1/auth/register",
        json={"email": who.email, "password": "correct-horse-battery", "display_name": "X"},
    )
    assert response.status_code == 409
    assert response.json()["detail"] == "could not create account"


# --- what the redirect may carry ------------------------------------------------


def test_the_session_never_travels_in_the_url(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A token in a redirect lands in history, the referrer, and every proxy log."""
    stub_profile(monkeypatch, profile())
    state = start_flow(client)
    response = complete_flow(client, state)

    location = response.headers["location"]
    assert location == f"{WEB}/?auth=github#/"
    assert "token" not in location.lower()
    assert "HttpOnly" in response.headers["set-cookie"]


def test_a_requested_destination_survives_the_round_trip(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    board = uuid.uuid4()
    stub_profile(monkeypatch, profile())
    state = start_flow(client, next_path=f"%23/glade/{board}")
    response = complete_flow(client, state)

    assert response.headers["location"] == f"{WEB}/?auth=github#/glade/{board}"


@pytest.mark.parametrize(
    "hostile",
    ["https://evil.example/", "//evil.example/", "/api/v1/auth", "%23//evil.example"],
)
def test_the_callback_cannot_be_pointed_off_site(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, hostile: str
) -> None:
    """The classic OAuth open redirect, made worse by arriving with a fresh session."""
    stub_profile(monkeypatch, profile())
    state = start_flow(client, next_path=hostile)
    response = complete_flow(client, state)

    assert response.headers["location"].startswith(f"{WEB}/?auth=github#/")
    assert "evil.example" not in response.headers["location"]


# --- the profile page's half ----------------------------------------------------


def test_a_profile_edit_never_touches_the_github_identity(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile()
    token = sign_in(client, monkeypatch, who)
    auth = {"Authorization": f"Bearer {token}"}

    response = client.patch(
        "/api/v1/auth/me",
        json={"display_name": "  Renamed By Hand  ", "avatar_source": "none"},
        headers=auth,
    )
    assert response.status_code == 200, response.text
    body = response.json()

    assert body["display_name"] == "Renamed By Hand"
    assert body["avatar_url"] is None
    assert body["avatar_source"] == "none"
    # GitHub's copy is untouched, which is what makes the change reversible.
    assert body["identities"]["github"]["username"] == who.username
    assert body["identities"]["github"]["name"] == who.name
    assert body["identities"]["github"]["email"] == who.email
    assert body["identities"]["github"]["avatar_url"] == who.avatar_url

    restored = client.patch("/api/v1/auth/me", json={"avatar_source": "github"}, headers=auth)
    assert restored.json()["avatar_url"] == who.avatar_url


def test_a_dropped_avatar_stays_dropped_across_the_next_sign_in(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile(provider_user_id="77")
    token = sign_in(client, monkeypatch, who)
    client.patch(
        "/api/v1/auth/me",
        json={"avatar_source": "none"},
        headers={"Authorization": f"Bearer {token}"},
    )

    again = me(client, sign_in(client, monkeypatch, who))

    assert again["avatar_url"] is None
    assert again["avatar_source"] == "none"


def test_a_github_avatar_follows_the_github_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile(provider_user_id="88", avatar_url="https://avatars.example/one.png")
    sign_in(client, monkeypatch, who)

    moved = profile(
        provider_user_id="88",
        email=who.email,
        avatar_url="https://avatars.example/two.png",
    )
    body = me(client, sign_in(client, monkeypatch, moved))

    assert body["avatar_url"] == "https://avatars.example/two.png"


def test_choosing_a_github_avatar_without_a_linked_account_is_refused(
    client: TestClient, make_user: Any
) -> None:
    actor: Actor = make_user("No GitHub")
    response = client.patch(
        "/api/v1/auth/me", json={"avatar_source": "github"}, headers=actor.auth
    )
    assert response.status_code == 409


def test_the_profile_endpoint_needs_a_session(client: TestClient) -> None:
    client.cookies.clear()
    assert client.patch("/api/v1/auth/me", json={"display_name": "Nobody"}).status_code == 401


# --- the two payload decisions --------------------------------------------------


def test_a_verified_primary_email_wins() -> None:
    chosen = github.select_email(
        [
            {"email": "secondary@example.com", "primary": False, "verified": True},
            {"email": "Primary@Example.com", "primary": True, "verified": True},
        ]
    )
    assert chosen == "primary@example.com"


def test_an_unverified_primary_is_skipped_for_a_verified_one() -> None:
    chosen = github.select_email(
        [
            {"email": "unverified@example.com", "primary": True, "verified": False},
            {"email": "verified@example.com", "primary": False, "verified": True},
        ]
    )
    assert chosen == "verified@example.com"


def test_no_verified_email_at_all_is_a_refusal() -> None:
    with pytest.raises(github.EmailUnverified):
        github.select_email([{"email": "nobody@example.com", "primary": True, "verified": False}])


def test_a_payload_without_an_id_is_refused() -> None:
    with pytest.raises(github.OAuthError):
        github.profile_from_payloads(
            {"login": "octocat"},
            [{"email": "a@example.com", "primary": True, "verified": True}],
        )
