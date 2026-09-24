"""Searching what is written on glades and leas.

The list page already matches titles in the browser. Contents live in the CRDT log,
which the browser cannot read without joining every board, so the worker keeps a plain
text copy of each one in `board_texts` and `GET /boards/search` matches against it.

What matters here is what the search must *not* do. It must not find a board the
caller cannot open, and it must never read a board with a password: that board keeps
its contents behind the password, and a search that quoted them in a snippet would be
the password skipped.
"""

import asyncio
import uuid
from typing import Any

import asyncpg
import pytest
from pycrdt import Doc, Map, XmlElement, XmlFragment, XmlText
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient

from tests.conftest import TEST_DATABASE_URL, Actor, _asyncpg_dsn


def _doc_with(*labels: str, kind: str = "rect", ids: list[str] | None = None) -> bytes:
    """A Yjs update holding one shape per label, with the label as its text."""
    doc = Doc()
    doc["objects"] = objects = Map()
    for index, label in enumerate(labels):
        # A fresh id unless one is asked for: two updates from different clients writing
        # the same key would be a conflict, and only one would survive the merge.
        key = ids[index] if ids is not None else uuid.uuid4().hex[:12]
        fragment = XmlFragment([XmlElement("paragraph", {}, [XmlText(label)])])
        objects[key] = Map({"id": key, "type": kind, "text": fragment})
    return bytes(doc.get_update())


def _store(board_id: str, update: bytes) -> None:
    """Append an update to the log, as the room would after an edit."""

    async def run() -> None:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            await conn.execute(
                "insert into board_updates (board_id, update) values ($1, $2)",
                uuid.UUID(board_id),
                update,
            )
        finally:
            await conn.close()

    asyncio.run(run())


def _index() -> int:
    """Run the worker's indexing pass on its own loop and engine, as arq does."""
    from app.workers.search_index import index_stale_boards

    async def run() -> int:
        engine = create_async_engine(TEST_DATABASE_URL)
        try:
            return await index_stale_boards(async_sessionmaker(engine))
        finally:
            await engine.dispose()

    return asyncio.run(run())


def _indexed(board_id: str) -> int:
    """Rows of this board's text held for search."""

    async def run() -> int:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            value: int = await conn.fetchval(
                "select count(*) from board_texts where board_id = $1", uuid.UUID(board_id)
            )
            return value
        finally:
            await conn.close()

    return asyncio.run(run())


def _search(client: TestClient, actor: Actor, q: str, **params: str) -> list[dict[str, Any]]:
    response = client.get(
        "/api/v1/boards/search", params={"q": q, **params}, headers=actor.auth
    )
    assert response.status_code == 200, response.text
    body: list[dict[str, Any]] = response.json()
    return body


def test_finds_a_board_by_what_is_written_on_it(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board("Hospital")
    other = owner.create_board("Kitchen")
    _store(board_id, _doc_with("Pharmacy Service", "medication dispensing"))
    _store(other, _doc_with("Oven", "Fridge"))
    _index()

    hits = _search(client, owner, "dispens")
    assert [hit["id"] for hit in hits] == [board_id]
    # The snippet is the text around the match, so the card can say why it matched.
    assert "dispensing" in hits[0]["snippet"]


def test_names_the_objects_the_words_were_found_in(client: TestClient, owner: Actor) -> None:
    """Which sticky or shape it was, so the board can be opened on it."""
    board_id = owner.create_board()
    _store(board_id, _doc_with("Pharmacy", "Pharmacy Service with a long note", ids=["aaa", "bbb"]))
    _store(board_id, _doc_with("pharmacy hours", kind="sticky", ids=["ccc"]))
    _store(board_id, _doc_with("Kitchen", ids=["ddd"]))
    _index()

    [hit] = _search(client, owner, "pharmacy")
    assert hit["match_count"] == 3
    # Where the word comes first and the text is shortest leads: the shape labelled just
    # "Pharmacy" is the answer, the longer note mentioning it is not.
    assert [match["object_id"] for match in hit["matches"]] == ["aaa", "ccc", "bbb"]
    assert hit["matches"][1]["object_type"] == "sticky"
    assert hit["matches"][1]["snippet"] == "pharmacy hours"


def test_names_at_most_three_objects_and_counts_the_rest(
    client: TestClient, owner: Actor
) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with(*[f"invoice {n}" for n in range(7)]))
    _index()

    [hit] = _search(client, owner, "invoice")
    assert hit["match_count"] == 7
    assert len(hit["matches"]) == 3


def test_matching_ignores_case(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with("Electronic Medical Records"))
    _index()

    assert [hit["id"] for hit in _search(client, owner, "MEDICAL rec")] == [board_id]


def test_a_new_edit_is_picked_up_by_the_next_pass(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with("first draft"))
    _index()
    assert _search(client, owner, "second") == []

    _store(board_id, _doc_with("second thoughts"))
    _index()
    assert [hit["id"] for hit in _search(client, owner, "second")] == [board_id]


def test_an_unchanged_board_is_not_read_again(
    client: TestClient, owner: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """With the stamp margin out of the way: inside it, a fresh edit is read once more."""
    from datetime import timedelta

    from app.workers import search_index

    monkeypatch.setattr(search_index, "STAMP_MARGIN", timedelta(0))
    board_id = owner.create_board()
    _store(board_id, _doc_with("once"))
    assert _index() == 1
    assert _index() == 0


def test_never_finds_a_board_the_caller_cannot_open(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with("quarterly salaries"))
    _index()

    assert _search(client, outsider, "salaries") == []


def test_a_board_with_a_password_is_never_searched(client: TestClient, owner: Actor) -> None:
    """Not even by its owner, and not even from a copy indexed before the password."""
    board_id = owner.create_board()
    _store(board_id, _doc_with("merger codename bluebird"))
    _index()
    assert [hit["id"] for hit in _search(client, owner, "bluebird")] == [board_id]

    response = client.put(
        f"/api/v1/boards/{board_id}/password",
        json={"password": "hollow-elm-42"},
        headers=owner.auth,
    )
    assert response.status_code == 200, response.text

    # Gone from the results at once, and the copy is gone from the database rather than
    # merely filtered out: a password is a promise about where the words are kept.
    assert _search(client, owner, "bluebird") == []
    assert _indexed(board_id) == 0

    # And an edit made later does not put it back.
    _store(board_id, _doc_with("merger codename bluebird, signed"))
    _index()
    assert _indexed(board_id) == 0
    assert _search(client, owner, "bluebird") == []


def test_removing_the_password_makes_it_searchable_again(
    client: TestClient, owner: Actor
) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with("garden plan"))
    client.put(
        f"/api/v1/boards/{board_id}/password",
        json={"password": "hollow-elm-42"},
        headers=owner.auth,
    )
    _index()
    assert _search(client, owner, "garden") == []

    response = client.delete(f"/api/v1/boards/{board_id}/password", headers=owner.auth)
    assert response.status_code == 200, response.text
    _index()
    assert [hit["id"] for hit in _search(client, owner, "garden")] == [board_id]


def test_a_board_in_the_trash_is_not_found(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with("old notes"))
    _index()
    client.delete(f"/api/v1/boards/{board_id}", headers=owner.auth)

    assert _search(client, owner, "old notes") == []


def test_kind_narrows_the_results(client: TestClient, owner: Actor) -> None:
    glade = owner.create_board()
    response = client.post(
        "/api/v1/boards",
        json={"workspace_id": owner.workspace_id, "title": "Diary", "kind": "lea"},
        headers=owner.auth,
    )
    assert response.status_code == 201, response.text
    lea = response.json()["id"]
    _store(glade, _doc_with("tuesday"))
    _store(lea, _doc_with("tuesday"))
    _index()

    assert {hit["id"] for hit in _search(client, owner, "tuesday")} == {glade, lea}
    assert [hit["id"] for hit in _search(client, owner, "tuesday", kind="glade")] == [glade]
    assert [hit["id"] for hit in _search(client, owner, "tuesday", kind="lea")] == [lea]


def test_wildcards_in_the_query_are_literal(client: TestClient, owner: Actor) -> None:
    board_id = owner.create_board()
    _store(board_id, _doc_with("plain words"))
    _index()

    assert _search(client, owner, "%") == []
    assert _search(client, owner, "_la") == []


def test_a_one_letter_query_searches_nothing(client: TestClient, owner: Actor) -> None:
    """One letter matches nearly every board, which is noise rather than an answer."""
    board_id = owner.create_board()
    _store(board_id, _doc_with("a"))
    _index()

    assert _search(client, owner, "a") == []
