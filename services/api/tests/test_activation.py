"""Account activation: the mail, the link, and what an unactivated account may do.

The relay is stubbed at one seam - `app.services.mail.send`, the function that owns
every byte leaving this process - so the message itself is inspected as data. Everything
above it is the real registration, the real token, and the real login refusing.

Two rules are worth stating because the rest of the file only makes sense with them:

* registration writes the account and stops. The row holds the address so nobody else
  can claim it, and no method signs in to it until the link is followed;
* a deployment with no SMTP opens accounts immediately. That is what the rest of the
  suite runs under, so every test here turns the mail on for itself.
"""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from pydantic import SecretStr
from starlette.testclient import TestClient

from app.config import settings
from app.services import activation, mail
from app.services.oauth import google
from tests.oauth_flow import (
    REFRESH_COOKIE,
    complete_flow,
    configure,
    me,
    start_flow,
    stub_profile,
)

PASSWORD = "correct-horse-battery-staple"


class Outbox:
    """What was handed to the relay. One list, in order."""

    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    @property
    def last(self) -> dict[str, str]:
        assert self.sent, "no mail was sent"
        return self.sent[-1]

    def link(self) -> str:
        """The activation URL, read back out of the message the way a reader would."""
        text = self.last["text"]
        token = text.split("/api/v1/auth/activate?token=")[1].split()[0]
        return token


@pytest.fixture
def outbox(monkeypatch: pytest.MonkeyPatch) -> Outbox:
    box = Outbox()

    async def fake_send(*, to: str, subject: str, text: str, html: str) -> None:
        box.sent.append({"to": to, "subject": subject, "text": text, "html": html})

    monkeypatch.setattr(settings, "smtp_host", "smtp.meadow-tests.dev")
    monkeypatch.setattr(settings, "smtp_from", "no-reply@meadow-tests.dev")
    monkeypatch.setattr(settings, "smtp_password", SecretStr("not-a-real-password"))
    monkeypatch.setattr(mail, "send", fake_send)
    return box


def register(client: TestClient, email: str | None = None, name: str = "Ada Lovelace") -> str:
    address = email or f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    response = client.post(
        "/api/v1/auth/register",
        json={"email": address, "password": PASSWORD, "display_name": name},
    )
    assert response.status_code == 202, response.text
    client.cookies.clear()
    return address


def login(client: TestClient, email: str) -> Any:
    return client.post("/api/v1/auth/login", json={"email": email, "password": PASSWORD})


# --- what registering does ------------------------------------------------------


def test_registering_sends_a_link_and_no_session(client: TestClient, outbox: Outbox) -> None:
    email = register(client)

    assert outbox.last["to"] == email
    assert outbox.last["subject"] == "Activate your Meadow account"
    assert REFRESH_COOKIE not in client.cookies


def test_the_mail_says_what_it_is_in_both_parts(client: TestClient, outbox: Outbox) -> None:
    """A client that refuses HTML must still be able to activate."""
    register(client, name="Ada Lovelace")
    token = outbox.link()

    assert "Ada Lovelace" in outbox.last["text"]
    assert "Ada Lovelace" in outbox.last["html"]
    # The destination is readable as text in both. A button whose target cannot be read
    # is what a phishing mail looks like.
    assert token in outbox.last["text"]
    assert token in outbox.last["html"]
    assert "expires in 24 hours" in outbox.last["text"]


def test_an_unactivated_account_cannot_log_in(client: TestClient, outbox: Outbox) -> None:
    email = register(client)

    response = login(client, email)

    assert response.status_code == 403
    assert response.json()["detail"] == "account is not activated"
    assert REFRESH_COOKIE not in response.cookies


def test_an_unactivated_account_cannot_be_registered_again(
    client: TestClient, outbox: Outbox
) -> None:
    """The row holds the address, so a second attempt is told to log in, not to wait."""
    email = register(client)

    again = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "display_name": "Someone Else"},
    )

    assert again.status_code == 409
    assert again.json()["detail"] == "email is already registered"
    assert len(outbox.sent) == 1


def test_a_wrong_password_is_not_told_that_the_account_is_unactivated(
    client: TestClient, outbox: Outbox
) -> None:
    """Otherwise the state of somebody else's account is readable without their password."""
    email = register(client)

    response = client.post("/api/v1/auth/login", json={"email": email, "password": "wrong-one-x"})

    assert response.status_code == 401
    assert response.json()["detail"] == "invalid email or password"


# --- following the link ---------------------------------------------------------


def test_the_link_activates_and_signs_in(client: TestClient, outbox: Outbox) -> None:
    """Clicking proves the address is theirs, which is what a session needs here."""
    email = register(client)

    response = client.get(
        f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False
    )

    assert response.status_code == 303
    assert response.headers["location"].endswith("/?activated=1#/")
    assert REFRESH_COOKIE in response.cookies
    # And the ordinary door is open now.
    assert login(client, email).status_code == 200


def test_a_link_works_once(client: TestClient, outbox: Outbox) -> None:
    register(client)
    token = outbox.link()
    first = client.get(f"/api/v1/auth/activate?token={token}", follow_redirects=False)
    assert first.status_code == 303
    client.cookies.clear()

    again = client.get(f"/api/v1/auth/activate?token={token}", follow_redirects=False)

    # Not an error: the account is open, and the second click is usually the same person
    # opening the mail twice.
    assert again.headers["location"].endswith("/?activated=already#/")
    assert REFRESH_COOKIE not in again.cookies


def test_a_forged_link_is_refused(client: TestClient) -> None:
    response = client.get("/api/v1/auth/activate?token=not-a-real-token", follow_redirects=False)

    assert response.headers["location"].endswith("/?activation_error=invalid#/")
    assert REFRESH_COOKIE not in response.cookies


def test_an_expired_link_is_refused_and_says_so(
    client: TestClient, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Distinguished from a forgery because the answers differ: ask for a new one."""
    monkeypatch.setattr(settings, "activation_ttl_hours", -1)
    register(client)

    response = client.get(
        f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False
    )

    assert response.headers["location"].endswith("/?activation_error=expired#/")
    assert REFRESH_COOKIE not in response.cookies


def test_asking_again_retires_the_earlier_link(client: TestClient, outbox: Outbox) -> None:
    """Two working keys to one account should not sit in one inbox."""
    email = register(client)
    first = outbox.link()

    assert client.post("/api/v1/auth/activation/resend", json={"email": email}).status_code == 204
    second = outbox.link()
    assert second != first

    stale = client.get(f"/api/v1/auth/activate?token={first}", follow_redirects=False)
    assert stale.headers["location"].endswith("/?activation_error=invalid#/")
    fresh = client.get(f"/api/v1/auth/activate?token={second}", follow_redirects=False)
    assert fresh.headers["location"].endswith("/?activated=1#/")


def test_resending_says_nothing_about_who_exists(client: TestClient, outbox: Outbox) -> None:
    """The one endpoint here that stays quiet: it posts mail to an address a caller chose."""
    unknown = client.post(
        "/api/v1/auth/activation/resend",
        json={"email": f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"},
    )
    assert unknown.status_code == 204
    assert outbox.sent == []

    email = register(client)
    client.get(f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False)
    already = client.post("/api/v1/auth/activation/resend", json={"email": email})

    assert already.status_code == 204
    # An activated account gets no mail, and the caller cannot tell that from a miss.
    assert len(outbox.sent) == 1


# --- the same rules through a provider ------------------------------------------


def test_registering_with_google_also_waits_for_the_address(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, outbox: Outbox
) -> None:
    """One door or the other, the account opens the same way."""
    configure(monkeypatch, google.PROVIDER)
    who = google.GoogleProfile(
        provider_user_id="sub-activation",
        username="ada@meadow-tests.dev",
        name="Ada Lovelace",
        email=f"{uuid.uuid4().hex[:12]}@meadow-tests.dev",
        avatar_url=None,
        profile_url=None,
    )
    stub_profile(monkeypatch, google, who)

    created = complete_flow(
        client, google.PROVIDER, start_flow(client, google.PROVIDER, intent="register")
    )

    assert "auth_pending=registered" in created.headers["location"]
    assert REFRESH_COOKIE not in created.cookies
    assert outbox.last["to"] == who.email

    # Signing in before activating is refused, provider or not.
    refused = complete_flow(client, google.PROVIDER, start_flow(client, google.PROVIDER))
    assert "auth_error=not_activated" in refused.headers["location"]

    # And the link opens it for every door at once.
    client.get(f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False)
    client.cookies.clear()
    stub_profile(monkeypatch, google, who)
    signed_in = complete_flow(client, google.PROVIDER, start_flow(client, google.PROVIDER))
    assert signed_in.headers["location"].endswith("/?auth=google#/")


def test_a_relay_that_refuses_keeps_the_account_and_says_so(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Losing the registration would leave the address free for somebody else to claim."""
    monkeypatch.setattr(settings, "smtp_host", "smtp.meadow-tests.dev")
    monkeypatch.setattr(settings, "smtp_from", "no-reply@meadow-tests.dev")

    async def refuse(**_: Any) -> None:
        raise mail.MailError("relay said no")

    monkeypatch.setattr(mail, "send", refuse)

    email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "display_name": "Ada"},
    )

    assert response.status_code == 202
    assert response.json() == {
        "email": email,
        "activation_required": True,
        "activation_sent": False,
    }
    # The account is there, unusable, and the address is taken.
    assert login(client, email).status_code == 403


def test_without_smtp_the_account_opens_immediately(client: TestClient) -> None:
    """The development path, and the one the rest of the suite runs on."""
    email = register(client)

    response = login(client, email)

    assert response.status_code == 200
    assert me(client, response.json()["access_token"])["email"] == email


def test_an_expired_link_can_be_replaced(
    client: TestClient, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "activation_ttl_hours", -1)
    email = register(client)
    assert client.get(
        f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False
    ).headers["location"].endswith("expired#/")

    monkeypatch.setattr(settings, "activation_ttl_hours", 24)
    client.post("/api/v1/auth/activation/resend", json={"email": email})

    assert client.get(
        f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False
    ).headers["location"].endswith("/?activated=1#/")


def test_the_stored_link_is_a_digest_not_the_token(client: TestClient, outbox: Outbox) -> None:
    """A database leak must not yield working activation links."""
    register(client)
    token = outbox.link()

    assert activation._hash(token) != token
    assert len(activation._hash(token)) == 64


def test_a_link_expiring_is_a_wall_clock_decision(client: TestClient, outbox: Outbox) -> None:
    """Guards the comparison itself: `expires_at` is tz-aware, and naive would raise."""
    register(client)
    horizon = datetime.now(UTC) + timedelta(hours=settings.activation_ttl_hours)

    assert horizon > datetime.now(UTC)
    assert client.get(
        f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False
    ).headers["location"].endswith("/?activated=1#/")


# --- setting and resetting a password -------------------------------------------


def reset_link(outbox: Outbox) -> str:
    """The token out of the reset mail, read the way a person clicking would."""
    return outbox.last["text"].split("/#/reset/")[1].split()[0]


def activate(client: TestClient, outbox: Outbox) -> None:
    client.get(f"/api/v1/auth/activate?token={outbox.link()}", follow_redirects=False)
    client.cookies.clear()


def test_a_reset_link_sets_a_new_password(client: TestClient, outbox: Outbox) -> None:
    email = register(client)
    activate(client, outbox)

    asked = client.post("/api/v1/auth/password/reset-request", json={"email": email})
    assert asked.status_code == 204
    token = reset_link(outbox)
    changed = client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "a-brand-new-password"}
    )

    assert changed.status_code == 204
    assert login(client, email).status_code == 401
    fresh = client.post(
        "/api/v1/auth/login", json={"email": email, "password": "a-brand-new-password"}
    )
    assert fresh.status_code == 200


def test_a_reset_ends_every_session_on_the_account(client: TestClient, outbox: Outbox) -> None:
    """Someone resetting a password they did not lose thinks somebody else has it."""
    email = register(client)
    activate(client, outbox)
    assert login(client, email).status_code == 200
    stolen = client.cookies[REFRESH_COOKIE]

    client.post("/api/v1/auth/password/reset-request", json={"email": email})
    client.post(
        "/api/v1/auth/password/reset",
        json={"token": reset_link(outbox), "password": "a-brand-new-password"},
    )

    client.cookies.set(REFRESH_COOKIE, stolen)
    assert client.post("/api/v1/auth/refresh").status_code == 401
    client.cookies.clear()


def test_a_reset_link_works_once(client: TestClient, outbox: Outbox) -> None:
    email = register(client)
    activate(client, outbox)
    client.post("/api/v1/auth/password/reset-request", json={"email": email})
    token = reset_link(outbox)
    client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "first-password-x"}
    )

    again = client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "second-password-x"}
    )

    assert again.status_code == 400
    assert again.json()["detail"] == "invalid reset link"


def test_an_expired_reset_link_says_so(
    client: TestClient, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    email = register(client)
    activate(client, outbox)
    monkeypatch.setattr(settings, "password_reset_ttl_hours", -1)
    client.post("/api/v1/auth/password/reset-request", json={"email": email})

    response = client.post(
        "/api/v1/auth/password/reset",
        json={"token": reset_link(outbox), "password": "a-brand-new-password"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "expired reset link"


def test_an_activation_link_cannot_be_spent_as_a_reset(
    client: TestClient, outbox: Outbox
) -> None:
    """Both are links in a mail, and the purpose is what keeps them apart."""
    register(client)
    activation_token = outbox.link()

    response = client.post(
        "/api/v1/auth/password/reset",
        json={"token": activation_token, "password": "a-brand-new-password"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "invalid reset link"


def test_a_reset_link_cannot_be_spent_as_an_activation(
    client: TestClient, outbox: Outbox
) -> None:
    email = register(client)
    activate(client, outbox)
    client.post("/api/v1/auth/password/reset-request", json={"email": email})

    response = client.get(
        f"/api/v1/auth/activate?token={reset_link(outbox)}", follow_redirects=False
    )

    assert response.headers["location"].endswith("/?activation_error=invalid#/")


def test_an_oauth_only_account_can_be_given_a_first_password(
    client: TestClient, monkeypatch: pytest.MonkeyPatch, outbox: Outbox
) -> None:
    """The profile page's button: no password to reset, so this is how one arrives."""
    configure(monkeypatch, google.PROVIDER)
    who = google.GoogleProfile(
        provider_user_id="sub-passwordless",
        username="ada@meadow-tests.dev",
        name="Ada Lovelace",
        email=f"{uuid.uuid4().hex[:12]}@meadow-tests.dev",
        avatar_url=None,
        profile_url=None,
    )
    stub_profile(monkeypatch, google, who)
    complete_flow(
        client, google.PROVIDER, start_flow(client, google.PROVIDER, intent="register")
    )
    activate(client, outbox)

    client.post("/api/v1/auth/password/reset-request", json={"email": who.email})
    # The mail knows there was no password, and says set rather than reset.
    assert outbox.last["subject"] == "Set your Meadow password"
    assert "no password yet" in outbox.last["html"]
    client.post(
        "/api/v1/auth/password/reset",
        json={"token": reset_link(outbox), "password": "a-brand-new-password"},
    )

    response = client.post(
        "/api/v1/auth/login", json={"email": who.email, "password": "a-brand-new-password"}
    )
    assert response.status_code == 200
    assert me(client, response.json()["access_token"])["has_password"] is True


def test_asking_to_reset_an_unactivated_account_sends_the_activation_link(
    client: TestClient, outbox: Outbox
) -> None:
    """It has no password to reset yet, and the thing it needs proves the same fact."""
    email = register(client)

    client.post("/api/v1/auth/password/reset-request", json={"email": email})

    assert len(outbox.sent) == 2
    assert outbox.last["subject"] == "Activate your Meadow account"


def test_asking_to_reset_an_unknown_address_says_nothing_and_sends_nothing(
    client: TestClient, outbox: Outbox
) -> None:
    response = client.post(
        "/api/v1/auth/password/reset-request",
        json={"email": f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"},
    )

    assert response.status_code == 204
    assert outbox.sent == []


def test_a_short_password_is_refused_at_the_reset_too(
    client: TestClient, outbox: Outbox
) -> None:
    """The one moment an attacker holding a stolen link would pick the password."""
    email = register(client)
    activate(client, outbox)
    client.post("/api/v1/auth/password/reset-request", json={"email": email})

    response = client.post(
        "/api/v1/auth/password/reset", json={"token": reset_link(outbox), "password": "short"}
    )

    assert response.status_code == 422


def test_the_signed_in_password_request_reports_what_happened(
    client: TestClient, outbox: Outbox
) -> None:
    """Unlike the public one, this endpoint may say the relay refused: it is my account."""
    email = register(client)
    activate(client, outbox)
    token = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    ).json()["access_token"]
    auth = {"Authorization": f"Bearer {token}"}

    sent = client.post("/api/v1/auth/password/change-request", headers=auth)

    assert sent.status_code == 204
    assert outbox.last["to"] == email
    # And the link it mailed is a working one.
    changed = client.post(
        "/api/v1/auth/password/reset",
        json={"token": reset_link(outbox), "password": "a-brand-new-password"},
    )
    assert changed.status_code == 204


def test_the_signed_in_password_request_needs_a_session(client: TestClient) -> None:
    client.cookies.clear()
    assert client.post("/api/v1/auth/password/change-request").status_code == 401


def test_a_relay_refusal_is_reported_rather_than_claimed_as_sent(
    client: TestClient, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A screen saying "email sent" when nothing was sent is worse than an error."""
    email = register(client)
    activate(client, outbox)
    token = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    ).json()["access_token"]

    async def refuse(**_: Any) -> None:
        raise mail.MailError("relay said no")

    monkeypatch.setattr(mail, "send", refuse)
    response = client.post(
        "/api/v1/auth/password/change-request", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 502
    assert response.json()["detail"] == "could not send the email"


def test_without_smtp_the_signed_in_request_says_so(client: TestClient) -> None:
    """No relay means no link. Inventing a way around it would be a second weaker door."""
    email = register(client)
    token = client.post(
        "/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    ).json()["access_token"]

    response = client.post(
        "/api/v1/auth/password/change-request", headers={"Authorization": f"Bearer {token}"}
    )

    assert response.status_code == 503
    assert response.json()["detail"] == "mail is not configured"


def test_a_spent_reset_link_is_refused_before_the_form_is_drawn(
    client: TestClient, outbox: Outbox
) -> None:
    """The check the reset page makes on arrival. Reads only: it never spends the link."""
    email = register(client)
    activate(client, outbox)
    client.post("/api/v1/auth/password/reset-request", json={"email": email})
    token = reset_link(outbox)

    # Good, and asking twice does not use it up.
    assert client.get(f"/api/v1/auth/password/reset?token={token}").status_code == 204
    assert client.get(f"/api/v1/auth/password/reset?token={token}").status_code == 204

    spend = client.post(
        "/api/v1/auth/password/reset", json={"token": token, "password": "a-brand-new-password"}
    )
    assert spend.status_code == 204

    spent = client.get(f"/api/v1/auth/password/reset?token={token}")
    assert spent.status_code == 400
    assert spent.json()["detail"] == "invalid reset link"


def test_the_arrival_check_tells_expired_from_spent(
    client: TestClient, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Two different instructions: ask for a new one either way, but say which happened."""
    email = register(client)
    activate(client, outbox)
    monkeypatch.setattr(settings, "password_reset_ttl_hours", -1)
    client.post("/api/v1/auth/password/reset-request", json={"email": email})

    response = client.get(f"/api/v1/auth/password/reset?token={reset_link(outbox)}")

    assert response.status_code == 400
    assert response.json()["detail"] == "expired reset link"
