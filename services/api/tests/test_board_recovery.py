"""Forgetting a board's password, and the two hours that gets you back in.

The feature exists because the documented escape hatch was unreachable: setting and
clearing a board password never ask for the current one, and both controls live inside
the board that the forgotten password is holding shut. So the tests below are mostly
about the shape of the way round - who may ask, what arrives, what the code buys - and
one of them is about the property the whole thing turns on:
`test_the_board_is_shut_when_the_temporary_password_runs_out`. A lock whose key expires
into an open door is the one outcome this must not have, and it is the outcome a later
"tidy up expired passwords" job would produce by accident.

The relay is stubbed at `app.services.mail.send`, the same seam `test_activation.py`
uses, and the suite runs with no SMTP host so every test here turns mail on for itself.
"""

import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import asyncpg
import pytest
from pydantic import SecretStr
from starlette.testclient import TestClient

from app.config import settings
from app.services import mail
from tests.conftest import TEST_DATABASE_URL, Actor, _asyncpg_dsn

PASSWORD = "hollow-elm-42"


class Outbox:
    """What was handed to the relay. One list, in order."""

    def __init__(self) -> None:
        self.sent: list[dict[str, str]] = []

    @property
    def last(self) -> dict[str, str]:
        assert self.sent, "no mail was sent"
        return self.sent[-1]

    def code(self) -> str:
        """The six digits, read back out of the message the way a reader would."""
        for line in self.last["text"].splitlines():
            stripped = line.strip()
            if stripped.isdigit() and len(stripped) == 6:
                return stripped
        raise AssertionError(f"no code in the mail: {self.last['text']}")


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


def _locked_board(client: TestClient, owner: Actor, title: str = "Test board") -> str:
    board_id = owner.create_board(title)
    response = client.put(
        f"/api/v1/boards/{board_id}/password",
        json={"password": PASSWORD},
        headers=owner.auth,
    )
    assert response.status_code == 200, response.text
    return board_id


def _forgot(client: TestClient, actor: Actor, board_id: str) -> Any:
    return client.post(f"/api/v1/boards/{board_id}/password/forgot", headers=actor.auth)


def _recover(client: TestClient, actor: Actor, board_id: str, code: str) -> Any:
    return client.post(
        f"/api/v1/boards/{board_id}/password/recover",
        json={"code": code},
        headers=actor.auth,
    )


def _verify(client: TestClient, actor: Actor, board_id: str, password: str) -> Any:
    return client.post(
        f"/api/v1/boards/{board_id}/password/verify",
        json={"password": password},
        headers=actor.auth,
    )


def _expire_password(board_id: str) -> None:
    """Move the temporary password's deadline into the past.

    Reaching into the row rather than waiting two hours, and rather than monkeypatching
    a clock: the deadline is a column, expiry is a comparison against it, and this is the
    same thing the passage of time would do.

    Through asyncpg rather than the app's session, like `conftest._truncate`: the app's
    engine belongs to the loop the TestClient runs on, and borrowing it from a second
    one hands back a connection that is already in use.
    """

    async def run() -> None:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            await conn.execute(
                "update boards set password_expires_at = $1 where id = $2",
                datetime.now(UTC) - timedelta(minutes=1),
                uuid.UUID(board_id),
            )
        finally:
            await conn.close()

    asyncio.run(run())


# --- asking ------------------------------------------------------------------------


def test_the_owner_gets_a_code_in_the_mail(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    board_id = _locked_board(client, owner, "Marsh notes")
    response = _forgot(client, owner, board_id)

    assert response.status_code == 200, response.text
    assert outbox.last["to"] == owner.email
    # Which board, because an owner with several may be reading about the wrong one.
    assert "Marsh notes" in outbox.last["subject"]
    assert len(outbox.code()) == 6
    # The address comes back masked: the owner knows it, and what they need is which of
    # their inboxes to look in.
    assert response.json()["sent_to"].endswith("@meadow-tests.dev")
    assert owner.email not in response.json()["sent_to"]


def test_the_code_is_not_the_old_password(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """Nothing in the mail is the forgotten password. There is nowhere to read it from.

    Worth asserting rather than assuming: the row holds argon2id, so a mail containing
    the old password could only come from somebody having stored it in a second place.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    assert PASSWORD not in outbox.last["text"]
    assert PASSWORD not in outbox.last["html"]


def test_only_the_owner_may_ask(
    client: TestClient, owner: Actor, outsider: Actor, outbox: Outbox
) -> None:
    """An editor cannot start a recovery, and cannot make one land in the owner's inbox.

    Both halves matter. The first is the ordinary owner-only rule; the second is that
    this route sends mail, so a non-owner who could call it would have a way to post
    messages to somebody else's address on demand.
    """
    board_id = _locked_board(client, owner)
    client.post(
        f"/api/v1/boards/{board_id}/members",
        json={"user_id": outsider.user_id, "role": "editor"},
        headers=owner.auth,
    )
    assert _forgot(client, outsider, board_id).status_code == 403
    assert outbox.sent == []


def test_a_board_with_no_password_has_nothing_to_reset(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    board_id = owner.create_board()
    assert _forgot(client, owner, board_id).status_code == 404
    assert outbox.sent == []


def test_asking_twice_retires_the_first_code(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """Two codes in one inbox is how somebody types the older one and is told they lied.

    So the second ask overwrites the first, exactly like an access request being made
    again, and only the newest one works.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    first = outbox.code()
    _forgot(client, owner, board_id)
    second = outbox.code()
    assert first != second

    assert _recover(client, owner, board_id, first).status_code == 400
    assert _recover(client, owner, board_id, second).status_code == 200


# --- spending it -------------------------------------------------------------------


def test_the_code_buys_a_temporary_password_that_opens_the_board(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    response = _recover(client, owner, board_id, outbox.code())

    assert response.status_code == 200, response.text
    temporary = response.json()["password"]
    assert response.json()["mailed"] is True
    assert temporary in outbox.last["text"]

    assert _verify(client, owner, board_id, temporary).status_code == 200
    # And the old one is gone, which is the point of a reset rather than a reminder.
    assert _verify(client, owner, board_id, PASSWORD).status_code == 403


def test_the_temporary_password_is_returned_once_and_never_again(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """It is on the screen and in the inbox, and nowhere else - including the board row.

    `has_password` is the only thing the board ever reports about it, plus a deadline.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    temporary = _recover(client, owner, board_id, outbox.code()).json()["password"]

    board = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()
    assert board["has_password"] is True
    assert board["password_expires_at"] is not None
    assert temporary not in str(board)


def test_a_code_works_once(client: TestClient, owner: Actor, outbox: Outbox) -> None:
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    code = outbox.code()
    assert _recover(client, owner, board_id, code).status_code == 200
    assert _recover(client, owner, board_id, code).status_code == 400


def test_a_wrong_code_dies_after_five_guesses(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """Six digits is only safe because guessing stops. This is where it stops.

    The fifth refusal says to ask for another one rather than inviting a sixth attempt
    that cannot succeed, and the real code is dead afterwards - so a guesser who ran the
    counter down has to go through a mailbox they do not have to try again.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    real = outbox.code()
    wrong = "000000" if real != "000000" else "111111"

    for _ in range(5):
        assert _recover(client, owner, board_id, wrong).status_code == 400

    spent = _recover(client, owner, board_id, real)
    assert spent.status_code == 400
    assert "ask for another" in spent.json()["detail"]


def test_an_expired_code_is_refused(
    client: TestClient, owner: Actor, outbox: Outbox, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "board_recovery_code_ttl_minutes", 0)
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    response = _recover(client, owner, board_id, outbox.code())
    assert response.status_code == 400
    assert "expired" in response.json()["detail"]


def test_one_owners_code_is_not_another_boards_key(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """A code names one board, like every other secret in this app."""
    first = _locked_board(client, owner, "One")
    second = _locked_board(client, owner, "Two")
    _forgot(client, owner, first)
    code = outbox.code()
    assert _recover(client, owner, second, code).status_code == 400
    assert _recover(client, owner, first, code).status_code == 200


# --- the two hours -----------------------------------------------------------------


def test_the_board_is_shut_when_the_temporary_password_runs_out(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """The property the whole feature turns on, and the one easiest to break later.

    When the two hours pass the password stops working - and the board keeps its lock.
    It does not quietly become an open board, which is what any "clean up expired
    passwords" job would make it. The way forward is another code, and that still works.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    temporary = _recover(client, owner, board_id, outbox.code()).json()["password"]
    assert _verify(client, owner, board_id, temporary).status_code == 200

    _expire_password(board_id)

    assert _verify(client, owner, board_id, temporary).status_code == 403
    board = client.get(f"/api/v1/boards/{board_id}", headers=owner.auth).json()
    assert board["has_password"] is True

    # And the owner is not stranded: asking again is still there.
    assert _forgot(client, owner, board_id).status_code == 200


def test_a_pass_does_not_outlive_the_password_that_minted_it(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """Twelve hours of pass on two hours of password would make the deadline a fiction.

    Everybody who had already typed it would keep the board for the rest of the day, and
    the two hours would only apply to people who had not opened it yet.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    temporary = _recover(client, owner, board_id, outbox.code()).json()["password"]

    granted = _verify(client, owner, board_id, temporary).json()
    assert granted["expires_in"] <= settings.board_temp_password_ttl_hours * 3600


def test_choosing_a_real_password_ends_the_temporary_state(
    client: TestClient, owner: Actor, outbox: Outbox
) -> None:
    """Which is what the temporary one is for: getting back to this control.

    The deadline goes with it. A password an owner chose has no expiry, and one call
    does both rather than leaving a second one to be remembered.
    """
    board_id = _locked_board(client, owner)
    _forgot(client, owner, board_id)
    _recover(client, owner, board_id, outbox.code())

    chosen = client.put(
        f"/api/v1/boards/{board_id}/password",
        json={"password": "new-hollow-elm"},
        headers=owner.auth,
    )
    assert chosen.status_code == 200, chosen.text
    assert chosen.json()["password_expires_at"] is None
    assert _verify(client, owner, board_id, "new-hollow-elm").status_code == 200
