"""Default board titles: "Untitled <Adjective> <Noun> <HASH>", never a bare collision.

`create_board` treats a literal "Untitled" title as "none was supplied" and swaps in a
random one from `app.services.naming`. These pin the swap, that a real title is left
alone, and that the generator actually avoids a name already taken in the workspace.
"""

import re

import pytest
from starlette.testclient import TestClient

from app.services import naming
from tests.conftest import Actor

_PATTERN = re.compile(r"^Untitled [A-Z][a-z]+ [A-Z][a-z]+ [0-9A-F]{4,}$")


def test_default_title_is_randomized(client: TestClient, owner: Actor) -> None:
    response = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "Untitled"},
        headers=owner.auth,
    )
    assert response.status_code == 201, response.text
    title = response.json()["title"]
    assert title != "Untitled"
    assert _PATTERN.match(title), title


def test_omitted_title_is_also_randomized(client: TestClient, owner: Actor) -> None:
    """The schema default is the literal "Untitled", so leaving title off hits the same path."""
    response = client.post(
        "/api/v1/boards", json={"workspace_id": owner.workspace_id}, headers=owner.auth
    )
    assert response.status_code == 201, response.text
    assert _PATTERN.match(response.json()["title"])


def test_custom_title_is_kept_verbatim(client: TestClient, owner: Actor) -> None:
    response = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "Sprint planning"},
        headers=owner.auth,
    )
    assert response.status_code == 201, response.text
    assert response.json()["title"] == "Sprint planning"


def test_generator_retries_past_a_taken_name(
    client: TestClient, owner: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A name already used in the workspace is never handed out a second time.

    Runs through the create endpoint rather than calling `generate_unique_board_title`
    directly: the app's engine is bound to the TestClient's event loop
    (conftest.py's module docstring), so a session opened from a bare `asyncio.run`
    call would hit a different loop and fail to close.
    """
    taken = "Untitled Running Crab BB14"
    owner.create_board(title=taken)

    calls = iter([taken, "Untitled Quiet Otter 9F21"])
    monkeypatch.setattr(naming, "_random_title", lambda: next(calls))

    response = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "Untitled"},
        headers=owner.auth,
    )
    assert response.status_code == 201, response.text
    assert response.json()["title"] == "Untitled Quiet Otter 9F21"
