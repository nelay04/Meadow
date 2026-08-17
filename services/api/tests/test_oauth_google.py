"""Google sign-in: its payload rules, and what two providers on one account means.

The flow itself - state, single use, open redirect, the shape of the redirect - is the
shared code tested in `test_oauth_github.py`, and a handful of cases here re-run the
ones that would be worth catching if the router factory ever grew a provider-specific
branch. The rest is what only Google has: `sub` as the account id, `email_verified` in
the profile payload rather than a second request, and the cross-provider matching that
only exists once there is more than one provider.
"""

import uuid
from typing import Any

import pytest
from starlette.testclient import TestClient

from app.config import settings
from app.services.oauth import github, google
from tests.conftest import Actor
from tests.oauth_flow import (
    REFRESH_COOKIE,
    WEB,
    complete_flow,
    configure,
    me,
    sign_in,
    start_flow,
    stub_profile,
)


@pytest.fixture(autouse=True)
def providers_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """Both, because the interesting cases here involve one account holding two."""
    configure(monkeypatch, google.PROVIDER)
    configure(monkeypatch, github.PROVIDER)


def profile(
    *,
    provider_user_id: str = "115_googley_sub",
    name: str | None = "Ada Lovelace",
    email: str | None = None,
    avatar_url: str | None = "https://lh3.googleusercontent.com/a/one",
) -> google.GoogleProfile:
    address = email or f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    return google.GoogleProfile(
        provider_user_id=provider_user_id,
        # No handle exists at Google, so the email is what the profile page shows.
        username=address,
        name=name,
        email=address,
        avatar_url=avatar_url,
        profile_url=None,
    )


def github_profile(*, email: str, provider_user_id: str = "9001") -> github.GitHubProfile:
    return github.GitHubProfile(
        provider_user_id=provider_user_id,
        username="octocat",
        name="The Octocat",
        email=email,
        avatar_url="https://avatars.githubusercontent.com/u/9001?v=4",
        profile_url="https://github.com/octocat",
    )


# --- configuration -------------------------------------------------------------


def test_each_provider_is_advertised_and_routed_independently(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Either, both or neither. One provider being unconfigured must not affect the other."""
    body = client.get("/api/v1/auth/providers").json()
    assert body == {"github": True, "google": True}

    monkeypatch.setattr(settings, "google_client_id", "")
    assert client.get("/api/v1/auth/providers").json() == {"github": True, "google": False}
    assert client.get("/api/v1/auth/google/start", follow_redirects=False).status_code == 404
    # And the other one still works.
    assert client.get("/api/v1/auth/github/start", follow_redirects=False).status_code == 302


def test_start_sends_the_browser_to_google_with_the_openid_scopes(
    client: TestClient,
) -> None:
    client.cookies.clear()
    response = client.get("/api/v1/auth/google/start", follow_redirects=False)

    assert response.status_code == 302
    location = response.headers["location"]
    assert location.startswith("https://accounts.google.com/o/oauth2/v2/auth?")
    assert "response_type=code" in location
    assert "scope=openid+email+profile" in location
    # An offline grant would hand back a refresh token for calling Google later, and
    # there is no later.
    assert "access_type=online" in location
    assert "HttpOnly" in response.headers["set-cookie"]


# --- state, on this provider too ------------------------------------------------


def test_a_google_state_cannot_be_spent_on_the_github_callback(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The state carries which provider it was minted for, and redemption checks it."""
    stub_profile(monkeypatch, github, github_profile(email="crossed@meadow-tests.dev"))
    state = start_flow(client, google.PROVIDER)
    # Present the cookie the way a browser following a crafted URL would.
    client.cookies.set("meadow_oauth_state", state, path="/api/v1/auth/github")

    response = complete_flow(client, github.PROVIDER, state)

    assert "auth_error=state" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_a_google_state_works_exactly_once(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_profile(monkeypatch, google, profile())
    state = start_flow(client, google.PROVIDER)
    assert complete_flow(client, google.PROVIDER, state).status_code == 303

    client.cookies.set("meadow_oauth_state", state, path="/api/v1/auth/google")
    replay = complete_flow(client, google.PROVIDER, state)

    assert "auth_error=state" in replay.headers["location"]


def test_a_failure_names_the_provider_it_came_from(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """So the login screen can say which button did not work, without guessing."""
    stub_profile(monkeypatch, google, profile())
    start_flow(client, google.PROVIDER)
    response = client.get(
        "/api/v1/auth/google/callback?error=access_denied", follow_redirects=False
    )

    assert response.headers["location"] == f"{WEB}/?auth_error=denied&provider=google#/"


# --- account matching -----------------------------------------------------------


def test_first_sign_in_creates_an_account_with_a_personal_workspace(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile()
    body = me(client, sign_in(client, monkeypatch, google, who))

    assert body["email"] == who.email
    assert body["display_name"] == "Ada Lovelace"
    assert body["avatar_url"] == who.avatar_url
    assert body["avatar_source"] == "google"
    assert body["has_password"] is False
    assert body["default_workspace_id"]
    assert body["identities"]["google"]["username"] == who.email
    # Google publishes no profile page, and a guessed URL is worse than none.
    assert body["identities"]["google"]["profile_url"] is None


def test_google_and_github_on_one_email_are_one_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of matching on email: two doors, one account behind them."""
    first = me(client, sign_in(client, monkeypatch, google, profile()))

    second = me(
        client, sign_in(client, monkeypatch, github, github_profile(email=first["email"]))
    )

    assert second["id"] == first["id"]
    assert second["default_workspace_id"] == first["default_workspace_id"]
    assert set(second["identities"]) == {"github", "google"}
    # Linking a second provider is not a request to be renamed by it.
    assert second["display_name"] == "Ada Lovelace"


def test_a_second_provider_does_not_take_over_the_chosen_avatar(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`avatar_source` names one provider, and only that one's picture follows."""
    who = profile()
    first = me(client, sign_in(client, monkeypatch, google, who))
    assert first["avatar_source"] == "google"

    second = me(client, sign_in(client, monkeypatch, github, github_profile(email=who.email)))

    assert second["avatar_source"] == "google"
    assert second["avatar_url"] == who.avatar_url


def test_switching_the_avatar_to_the_other_linked_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile()
    sign_in(client, monkeypatch, google, who)
    linked = github_profile(email=who.email)
    token = sign_in(client, monkeypatch, github, linked)
    auth = {"Authorization": f"Bearer {token}"}

    switched = client.patch("/api/v1/auth/me", json={"avatar_source": "github"}, headers=auth)

    assert switched.status_code == 200, switched.text
    assert switched.json()["avatar_url"] == linked.avatar_url
    # And the Google identity is still there, untouched, to switch back to.
    assert switched.json()["identities"]["google"]["avatar_url"] == who.avatar_url


def test_choosing_a_google_avatar_without_a_linked_account_is_refused(
    client: TestClient, make_user: Any
) -> None:
    actor: Actor = make_user("No Google")
    response = client.patch(
        "/api/v1/auth/me", json={"avatar_source": "google"}, headers=actor.auth
    )
    assert response.status_code == 409


def test_a_second_google_account_cannot_claim_a_linked_one(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Otherwise whoever can put a shared address on a Google account displaces the first."""
    first = profile(provider_user_id="sub-1")
    me(client, sign_in(client, monkeypatch, google, first))

    intruder = profile(provider_user_id="sub-2", email=first.email)
    stub_profile(monkeypatch, google, intruder)
    state = start_flow(client, google.PROVIDER)
    response = complete_flow(client, google.PROVIDER, state)

    assert "auth_error=conflict" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_a_google_email_change_is_still_the_same_link(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """`sub` is the only stable field Google publishes, and it is what the link is on."""
    first = profile(provider_user_id="sub-stable")
    created = me(client, sign_in(client, monkeypatch, google, first))

    renamed = profile(
        provider_user_id="sub-stable",
        name="Ada B Lovelace",
        email=f"new-{uuid.uuid4().hex[:8]}@meadow-tests.dev",
    )
    again = me(client, sign_in(client, monkeypatch, google, renamed))

    assert again["id"] == created["id"]
    assert again["identities"]["google"]["email"] == renamed.email
    # The account keeps the email it was created with: that is the account key, and
    # changing it is an account-merge question rather than a sign-in one.
    assert again["email"] == created["email"]
    assert again["display_name"] == "Ada Lovelace"


def test_password_login_is_refused_for_a_google_only_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = profile()
    sign_in(client, monkeypatch, google, who)
    client.cookies.clear()

    response = client.post(
        "/api/v1/auth/login", json={"email": who.email, "password": "correct-horse-battery"}
    )

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid email or password"


# --- the payload decisions ------------------------------------------------------


def test_userinfo_becomes_a_profile() -> None:
    built = google.profile_from_userinfo(
        {
            "sub": "10769150350006150715113082367",
            "name": "Ada Lovelace",
            "email": "Ada@Example.com",
            "email_verified": True,
            "picture": "https://lh3.googleusercontent.com/a/ada",
        }
    )

    assert built.provider == "google"
    assert built.provider_user_id == "10769150350006150715113082367"
    assert built.email == "ada@example.com"
    assert built.username == "ada@example.com"
    assert built.name == "Ada Lovelace"


def test_an_unverified_google_email_is_a_refusal() -> None:
    """An unverified address is a claim, and matching on a claim is account takeover."""
    with pytest.raises(google.EmailUnverified):
        google.profile_from_userinfo(
            {"sub": "1", "email": "nobody@example.com", "email_verified": False}
        )


def test_the_string_form_of_email_verified_is_read_as_a_boolean() -> None:
    """It is a string in id_token claims, and "false" is truthy if read carelessly."""
    with pytest.raises(google.EmailUnverified):
        google.profile_from_userinfo(
            {"sub": "1", "email": "nobody@example.com", "email_verified": "false"}
        )

    accepted = google.profile_from_userinfo(
        {"sub": "1", "email": "somebody@example.com", "email_verified": "true"}
    )
    assert accepted.email == "somebody@example.com"


def test_a_payload_without_a_sub_is_refused() -> None:
    with pytest.raises(google.OAuthError):
        google.profile_from_userinfo({"email": "a@example.com", "email_verified": True})


def test_an_unverified_email_beats_a_missing_sub_to_the_refusal() -> None:
    """Both are refusals, and neither may fall through to a profile."""
    with pytest.raises(google.OAuthError):
        google.profile_from_userinfo({"sub": "1", "email_verified": True})
