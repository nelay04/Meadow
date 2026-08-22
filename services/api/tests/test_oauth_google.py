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
    PASSWORD,
    REFRESH_COOKIE,
    WEB,
    complete_flow,
    configure,
    drop_password,
    me,
    register,
    sign_in,
    sign_in_with_password,
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


def known(client: TestClient, name: str = "Ada Lovelace", **kwargs: Any) -> google.GoogleProfile:
    """A Google profile whose email has an account here, which is what lets it sign in."""
    who: google.GoogleProfile = profile(**kwargs)
    register(client, email=who.email, name=name)
    return who


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
    email = register(client)
    stub_profile(monkeypatch, github, github_profile(email=email))
    state = start_flow(client, google.PROVIDER)
    # Present the cookie the way a browser following a crafted URL would.
    client.cookies.set("meadow_oauth_state", state, path="/api/v1/auth/github")

    response = complete_flow(client, github.PROVIDER, state)

    assert "auth_error=state" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_a_google_state_works_exactly_once(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    stub_profile(monkeypatch, google, known(client))
    state = start_flow(client, google.PROVIDER)
    assert complete_flow(client, google.PROVIDER, state).status_code == 303

    client.cookies.set("meadow_oauth_state", state, path="/api/v1/auth/google")
    replay = complete_flow(client, google.PROVIDER, state)

    assert "auth_error=state" in replay.headers["location"]


def test_a_failure_names_the_provider_it_came_from(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """So the login screen can say which button did not work, without guessing."""
    stub_profile(monkeypatch, google, known(client))
    start_flow(client, google.PROVIDER)
    response = client.get(
        "/api/v1/auth/google/callback?error=access_denied", follow_redirects=False
    )

    assert response.headers["location"] == f"{WEB}/?auth_error=denied&provider=google#/"


# --- account matching -----------------------------------------------------------


def test_signing_in_links_google_to_the_account_that_holds_the_email(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = known(client)
    body = me(client, sign_in(client, monkeypatch, google, who))

    assert body["email"] == who.email
    # The account's own name, not Google's: it existed before the link did.
    assert body["display_name"] == "Ada Lovelace"
    assert body["has_password"] is True
    assert body["default_workspace_id"]
    assert body["identities"]["google"]["username"] == who.email
    assert body["identities"]["google"]["name"] == "Ada Lovelace"
    # Google publishes no profile page, and a guessed URL is worse than none.
    assert body["identities"]["google"]["profile_url"] is None


def test_an_unregistered_email_is_sent_to_register_rather_than_signed_up(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A provider sign-in is a way into an account, never a way to make one."""
    stub_profile(monkeypatch, google, profile())
    state = start_flow(client, google.PROVIDER)

    response = complete_flow(client, google.PROVIDER, state)

    assert response.headers["location"] == f"{WEB}/?auth_error=no_account&provider=google#/"
    assert REFRESH_COOKIE not in response.cookies


def test_google_and_github_on_one_email_are_one_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The whole point of matching on email: two doors, one account behind them."""
    first = me(client, sign_in(client, monkeypatch, google, known(client)))

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
    who = known(client)
    token = sign_in(client, monkeypatch, google, who)
    chosen = client.patch(
        "/api/v1/auth/me",
        json={"avatar_source": "google"},
        headers={"Authorization": f"Bearer {token}"},
    )
    assert chosen.json()["avatar_source"] == "google"

    second = me(client, sign_in(client, monkeypatch, github, github_profile(email=who.email)))

    assert second["avatar_source"] == "google"
    assert second["avatar_url"] == who.avatar_url


def test_switching_the_avatar_to_the_other_linked_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = known(client)
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
    first = known(client, provider_user_id="sub-1")
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
    first = known(client, provider_user_id="sub-stable")
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


def test_an_account_with_no_password_is_told_to_use_its_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Accounts predating "registration is the password form" still exist and still work."""
    who = known(client)
    sign_in(client, monkeypatch, google, who)
    drop_password(who.email)
    client.cookies.clear()

    response = client.post("/api/v1/auth/login", json={"email": who.email, "password": PASSWORD})

    assert response.status_code == 401
    assert response.json()["detail"] == "account has no password"
    # And the provider still opens it, which is the whole reason this branch says
    # something different from a wrong password.
    assert me(client, sign_in(client, monkeypatch, google, who))["has_password"] is False


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


def test_a_sign_in_never_marks_itself_as_a_registration(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The splash video greets a new account, and a provider no longer makes one."""
    stub_profile(monkeypatch, google, known(client))

    response = complete_flow(client, google.PROVIDER, start_flow(client, google.PROVIDER))

    assert response.headers["location"] == f"{WEB}/?auth=google#/"
    assert "created" not in response.headers["location"]


# --- register or log in, and the difference between them ------------------------


def test_registering_with_google_creates_the_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The intent is what permits this. The same round trip under Log in is refused."""
    who = profile()
    stub_profile(monkeypatch, google, who)

    response = complete_flow(
        client, google.PROVIDER, start_flow(client, google.PROVIDER, intent="register")
    )

    assert "auth_pending=registered" in response.headers["location"]
    assert "provider=google" in response.headers["location"]
    # No session: the account waits on its address like every other registration.
    assert REFRESH_COOKIE not in response.cookies
    # And it is now a real account, which the register form agrees about.
    taken = client.post(
        "/api/v1/auth/register",
        json={"email": who.email, "password": PASSWORD, "display_name": "Someone"},
    )
    assert taken.status_code == 409


def test_registering_with_google_on_a_taken_address_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """They said they were new. Signing them in instead answers a question they did not ask."""
    who = known(client)
    stub_profile(monkeypatch, google, who)

    response = complete_flow(
        client, google.PROVIDER, start_flow(client, google.PROVIDER, intent="register")
    )

    assert "auth_error=already_registered" in response.headers["location"]
    assert REFRESH_COOKIE not in response.cookies


def test_registering_again_with_a_linked_google_account_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = known(client)
    sign_in(client, monkeypatch, google, who)
    stub_profile(monkeypatch, google, who)

    response = complete_flow(
        client, google.PROVIDER, start_flow(client, google.PROVIDER, intent="register")
    )

    assert "auth_error=already_registered" in response.headers["location"]


def test_an_unrecognised_intent_cannot_create_an_account(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Fails closed: anything that is not exactly "register" is read as a sign-in."""
    stub_profile(monkeypatch, google, profile())

    response = complete_flow(
        client, google.PROVIDER, start_flow(client, google.PROVIDER, intent="REGISTER")
    )

    assert "auth_error=no_account" in response.headers["location"]


# --- connecting a provider from the profile page ---------------------------------


def test_connecting_attaches_the_provider_to_the_account_that_asked(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = known(client)
    sign_in_with_password(client, who.email)
    stub_profile(monkeypatch, google, who)

    response = complete_flow(
        client,
        google.PROVIDER,
        start_flow(client, google.PROVIDER, intent="link", keep_cookies=True),
    )

    assert "auth_linked=google" in response.headers["location"]
    token = client.post("/api/v1/auth/refresh").json()["access_token"]
    assert me(client, token)["identities"]["google"]["email"] == who.email


def test_connecting_a_provider_on_another_address_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The bug this exists for: pressing Connect used to sign you into the other account.

    Signed in as one address, the provider answers with another that has its own account
    here, and the email match further down would have found it. From a button labelled
    Connect, being silently swapped to somebody else's account is the wrong end.
    """
    mine = register(client, name="Mine")
    theirs = known(client, name="Theirs")
    sign_in_with_password(client, mine)
    stub_profile(monkeypatch, google, theirs)

    response = complete_flow(
        client,
        google.PROVIDER,
        start_flow(client, google.PROVIDER, "%23/profile", intent="link", keep_cookies=True),
    )

    assert "auth_error=email_mismatch" in response.headers["location"]
    # Back to the page it started on, still signed in as the same person.
    assert response.headers["location"].endswith("#/profile")
    assert REFRESH_COOKIE not in response.cookies
    still_me = me(client, client.post("/api/v1/auth/refresh").json()["access_token"])
    assert still_me["email"] == mine
    assert still_me["identities"] == {}


def test_connecting_a_provider_account_already_linked_elsewhere_is_refused(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One provider account signs in to exactly one Meadow account."""
    first = known(client)
    sign_in(client, monkeypatch, google, first)

    # A second account, whose address happens to match what the provider will report.
    twin = profile(provider_user_id=first.provider_user_id, email=register(client))
    sign_in_with_password(client, twin.email)
    stub_profile(monkeypatch, google, twin)

    response = complete_flow(
        client,
        google.PROVIDER,
        start_flow(client, google.PROVIDER, intent="link", keep_cookies=True),
    )

    assert "auth_error=conflict" in response.headers["location"]


def test_connecting_without_a_session_is_refused_before_leaving_the_site(
    client: TestClient,
) -> None:
    """No session means no account to connect to, and nothing to ask the provider."""
    client.cookies.clear()

    response = client.get(
        "/api/v1/auth/google/start?intent=link", follow_redirects=False
    )

    assert response.status_code == 303
    assert "auth_error=session" in response.headers["location"]
    assert "accounts.google.com" not in response.headers["location"]


def test_connecting_the_same_account_twice_is_not_an_error(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    who = known(client)
    sign_in_with_password(client, who.email)
    stub_profile(monkeypatch, google, who)
    complete_flow(
        client,
        google.PROVIDER,
        start_flow(client, google.PROVIDER, intent="link", keep_cookies=True),
    )

    stub_profile(monkeypatch, google, who)
    again = complete_flow(
        client,
        google.PROVIDER,
        start_flow(client, google.PROVIDER, intent="link", keep_cookies=True),
    )

    assert "auth_linked=google" in again.headers["location"]
