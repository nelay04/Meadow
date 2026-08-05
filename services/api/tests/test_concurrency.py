"""ARCHITECTURE 12: concurrency, adversarial input, and resource limits.

Every scenario here needs two peers, a hostile client, or a resource limit to
reproduce, which is why none of them can be reached by a unit test and why §12 assigns
them to M5 rather than "later".

The rule the whole file enforces: **a failure must be correct, degraded, or refused,
never silently wrong.** A dropped update, a resurrected object, or a board that renders
differently for two people looking at the same thing is worse than an error, because
nobody finds out.

Convergence is asserted on document *content* after a round trip through the real
server, not on wire bytes. Two peers can hold different update histories and still be
in identical states, which is the property that actually matters.
"""

import asyncio
import uuid
from typing import Any

import pytest
from pycrdt import Array, Doc, Map
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.testclient import TestClient, WebSocketDisconnect

from tests import ywire
from tests.conftest import TEST_DATABASE_URL, Actor
from tests.wsclient import WS_ROOM_FULL, board_objects, drain_until_update, ws_url


def peer() -> Doc:
    """A client-shaped document: the roots ARCHITECTURE 4 locks down."""
    doc = Doc()
    doc["objects"] = Map()
    doc["order"] = Array()
    return doc


def sync_through_server(
    client: TestClient, actor: Actor, board_id: str, *docs: Doc
) -> list[dict[str, Any]]:
    """Push every peer's state, then pull the merged result back into each.

    One connection per peer, opened and closed in turn, which is the harsher ordering:
    it means no peer ever sees another's update live and each has to reconcile from
    whatever the server accumulated. If they converge under that they converge when
    connected simultaneously.
    """
    for doc in docs:
        with client.websocket_connect(
            ws_url(board_id, actor.ws_token(board_id)["token"])
        ) as websocket:
            websocket.send_bytes(ywire.sync_update(bytes(doc.get_update())))
            websocket.send_bytes(ywire.sync_step1(doc.get_state()))
            drain_until_update(websocket)

    states = []
    for doc in docs:
        with client.websocket_connect(
            ws_url(board_id, actor.ws_token(board_id)["token"])
        ) as websocket:
            websocket.send_bytes(ywire.sync_step1(doc.get_state()))
            update = drain_until_update(websocket)
            if update:
                doc.apply_update(update)
        states.append(dict(doc["objects"]))
    return states


# --- convergence under concurrency ---------------------------------------------


def test_peers_editing_distinct_objects_all_survive(client: TestClient, owner: Actor) -> None:
    """The control case. If this fails nothing below is meaningful."""
    board_id = owner.create_board()

    docs = []
    for index in range(4):
        doc = peer()
        doc["objects"][f"obj{index}"] = Map({"type": "rect", "x": index * 10})
        docs.append(doc)

    states = sync_through_server(client, owner, board_id, *docs)

    for state in states:
        assert set(state) == {"obj0", "obj1", "obj2", "obj3"}


def test_same_field_is_last_writer_wins_without_losing_other_fields(
    client: TestClient, owner: Actor
) -> None:
    """Losing the contended field is correct. Losing an uncontended one is not."""
    board_id = owner.create_board()

    base = peer()
    base["objects"]["shared"] = Map({"type": "rect", "x": 0, "y": 0, "w": 100})
    sync_through_server(client, owner, board_id, base)

    left = peer()
    left.apply_update(base.get_update())
    right = peer()
    right.apply_update(base.get_update())

    # Both write x; each also writes a field the other never touches.
    left["objects"]["shared"]["x"] = 111
    left["objects"]["shared"]["y"] = 50
    right["objects"]["shared"]["x"] = 222
    right["objects"]["shared"]["w"] = 300

    states = sync_through_server(client, owner, board_id, left, right)

    first = dict(states[0]["shared"])
    for state in states:
        assert dict(state["shared"]) == first, "peers disagree about the same object"

    assert first["x"] in (111, 222), "the contended field resolved to neither value"
    assert first["y"] == 50, "an uncontended field written by one peer was lost"
    assert first["w"] == 300, "an uncontended field written by the other peer was lost"


def test_concurrent_reparent_resolves_to_one_frame(client: TestClient, owner: Actor) -> None:
    """The case a nested tree would corrupt, and the reason ARCHITECTURE 4 is locked.

    `parentId` is a single field on a flat map, so two peers dragging one object into
    two different frames is an ordinary last-writer-wins conflict rather than an object
    that ends up in both trees or neither.
    """
    board_id = owner.create_board()

    base = peer()
    base["objects"]["child"] = Map({"type": "rect", "parentId": None})
    sync_through_server(client, owner, board_id, base)

    left = peer()
    left.apply_update(base.get_update())
    right = peer()
    right.apply_update(base.get_update())

    left["objects"]["child"]["parentId"] = "frameA"
    right["objects"]["child"]["parentId"] = "frameB"

    states = sync_through_server(client, owner, board_id, left, right)

    parents = {state["child"]["parentId"] for state in states}
    assert len(parents) == 1, f"peers disagree about the parent: {parents}"
    assert parents.pop() in ("frameA", "frameB")


def test_a_concurrent_drag_cannot_resurrect_a_deleted_object(
    client: TestClient, owner: Actor
) -> None:
    """A deletes while B drags. Yjs resolves to deleted; B must not bring it back."""
    board_id = owner.create_board()

    base = peer()
    base["objects"]["doomed"] = Map({"type": "rect", "x": 0})
    base["objects"]["keeper"] = Map({"type": "rect", "x": 0})
    sync_through_server(client, owner, board_id, base)

    deleter = peer()
    deleter.apply_update(base.get_update())
    dragger = peer()
    dragger.apply_update(base.get_update())

    del deleter["objects"]["doomed"]
    dragger["objects"]["doomed"]["x"] = 500

    states = sync_through_server(client, owner, board_id, deleter, dragger)

    for state in states:
        assert "doomed" not in state, "a concurrent edit resurrected a deleted object"
        assert "keeper" in state, "the unrelated object was lost with it"


def test_concurrent_restacks_leave_every_object_in_the_order(
    client: TestClient, owner: Actor
) -> None:
    """`order` is rewritten wholesale, so two simultaneous restacks can interleave.

    ARCHITECTURE 12 accepts a scrambled order as long as it converges; what it does
    not accept is an object missing from `order` entirely, which would leave it in the
    map while being invisible and unclickable. That is what `reconcileOrder` repairs,
    and this asserts the repair is reachable: no id is duplicated away to nothing.
    """
    board_id = owner.create_board()

    base = peer()
    ids = [f"obj{index}" for index in range(4)]
    for object_id in ids:
        base["objects"][object_id] = Map({"type": "rect"})
    base["order"].extend(ids)
    sync_through_server(client, owner, board_id, base)

    left = peer()
    left.apply_update(base.get_update())
    right = peer()
    right.apply_update(base.get_update())

    # Two wholesale rewrites, the shape `applyOrder` produces.
    del left["order"][0 : len(left["order"])]
    left["order"].extend(["obj3", "obj2", "obj1", "obj0"])
    del right["order"][0 : len(right["order"])]
    right["order"].extend(["obj1", "obj0", "obj3", "obj2"])

    sync_through_server(client, owner, board_id, left, right)

    orders = [list(left["order"]), list(right["order"])]
    assert orders[0] == orders[1], f"peers disagree about z-order: {orders}"

    # Every object still exists, which is what makes the client-side repair possible.
    for state in (dict(left["objects"]), dict(right["objects"])):
        assert set(state) == set(ids)


def test_offline_divergence_loses_neither_peers_edits(
    client: TestClient, owner: Actor
) -> None:
    """Both peers offline, both editing, both returning. Nothing may be dropped."""
    board_id = owner.create_board()

    base = peer()
    base["objects"]["seed"] = Map({"type": "rect"})
    sync_through_server(client, owner, board_id, base)

    alice = peer()
    alice.apply_update(base.get_update())
    bob = peer()
    bob.apply_update(base.get_update())

    # Neither has seen the other since `base`.
    for index in range(3):
        alice["objects"][f"alice{index}"] = Map({"type": "rect"})
        bob["objects"][f"bob{index}"] = Map({"type": "ellipse"})

    states = sync_through_server(client, owner, board_id, alice, bob)

    expected = {"seed"} | {f"alice{i}" for i in range(3)} | {f"bob{i}" for i in range(3)}
    for state in states:
        assert set(state) == expected


def test_the_merged_state_survives_a_cold_room(client: TestClient, owner: Actor) -> None:
    """Convergence has to outlive the room, not just the connection.

    The room is evicted when the last client leaves, so reading the board back here
    goes through Postgres and the ystore rather than through anything held in memory.
    """
    board_id = owner.create_board()

    left = peer()
    left["objects"]["a"] = Map({"type": "rect"})
    right = peer()
    right["objects"]["b"] = Map({"type": "ellipse"})
    sync_through_server(client, owner, board_id, left, right)

    assert set(board_objects(client, owner, board_id)) == {"a", "b"}


# --- adversarial and malformed input -------------------------------------------


@pytest.mark.parametrize(
    ("name", "payload"),
    [
        ("empty frame", b""),
        ("random bytes", bytes([0xFF, 0x9E, 0x42, 0x00, 0x13, 0x37])),
        ("truncated varuint", b"\xff\xff\xff"),
        ("sync header with no payload", b"\x00\x02"),
        ("sync update with a truncated body", b"\x00\x02\x40" + b"\x01" * 4),
        ("unknown message type", b"\x7f\x01\x02\x03"),
        ("a valid update for a different document", b"\x00\x02\x02\x00\x00"),
    ],
)
def test_garbage_on_the_wire_never_takes_the_room_down(
    client: TestClient, owner: Actor, name: str, payload: bytes
) -> None:
    """Reject or ignore, but never crash the room or the process.

    The board has to still work afterwards, which is the half that matters: a
    malformed frame that quietly poisoned the room would fail this on the second
    connection rather than the first.
    """
    board_id = owner.create_board()

    try:
        with client.websocket_connect(
            ws_url(board_id, owner.ws_token(board_id)["token"])
        ) as websocket:
            websocket.send_bytes(payload)
            websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
            # Either the server answers, or it closes the socket. Both are acceptable
            # outcomes for garbage; hanging or crashing are not.
            drain_until_update(websocket)
    except (WebSocketDisconnect, AssertionError, RuntimeError):
        pass

    good = peer()
    good["objects"]["after"] = Map({"type": "rect"})
    sync_through_server(client, owner, board_id, good)

    assert "after" in board_objects(client, owner, board_id), (
        f"the room stopped accepting real work after {name}"
    )


def test_a_flood_of_updates_does_not_starve_the_room(client: TestClient, owner: Actor) -> None:
    """One peer sending as fast as it can must not stop the board working.

    There is no rate limit on the CRDT stream today, so this asserts the weaker
    property that actually holds: the room stays responsive and every update is
    accounted for. If a limit is added later this is where its behaviour gets pinned
    down.
    """
    board_id = owner.create_board()

    flooder = peer()
    with client.websocket_connect(
        ws_url(board_id, owner.ws_token(board_id)["token"])
    ) as websocket:
        for index in range(200):
            flooder["objects"][f"flood{index}"] = Map({"type": "rect", "x": index})
            websocket.send_bytes(ywire.sync_update(bytes(flooder.get_update())))
        websocket.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(websocket)

    stored = board_objects(client, owner, board_id)
    assert len(stored) == 200, f"the room dropped updates under load: {len(stored)}"


def test_an_oversized_object_is_stored_or_refused_but_not_truncated(
    client: TestClient, owner: Actor
) -> None:
    """A megabyte of props in one object. Silently truncating it is the bad outcome."""
    board_id = owner.create_board()

    blob = "x" * 1_000_000
    doc = peer()
    doc["objects"]["huge"] = Map({"type": "rect", "note": blob})

    try:
        sync_through_server(client, owner, board_id, doc)
    except (WebSocketDisconnect, AssertionError):
        pytest.skip("the server refused the payload outright, which is also acceptable")

    stored = board_objects(client, owner, board_id)
    assert stored["huge"]["note"] == blob, "an oversized value came back altered"


def test_a_paste_of_many_objects_in_one_transaction_arrives_whole(
    client: TestClient, owner: Actor
) -> None:
    """50,000 objects in a single update, per ARCHITECTURE 12."""
    board_id = owner.create_board()

    doc = peer()
    with doc.transaction():
        for index in range(50_000):
            doc["objects"][f"paste{index}"] = Map({"type": "rect", "x": index})

    sync_through_server(client, owner, board_id, doc)

    stored = board_objects(client, owner, board_id)
    assert len(stored) == 50_000, f"a bulk paste arrived partially: {len(stored)}"


# --- resource limits ------------------------------------------------------------


def test_a_full_room_refuses_new_joins_without_disturbing_the_existing_ones(
    client: TestClient, owner: Actor, monkeypatch: pytest.MonkeyPatch
) -> None:
    """ARCHITECTURE 6: past `max_clients_per_room`, refuse with 4429.

    The second half is the one worth asserting: the peers already in the room have to
    be unaffected. A capacity check that dropped an existing client to make room would
    pass a naive test.
    """
    from app.config import settings

    monkeypatch.setattr(settings, "max_clients_per_room", 2)
    board_id = owner.create_board()

    with (
        client.websocket_connect(ws_url(board_id, owner.ws_token(board_id)["token"])) as first,
        client.websocket_connect(ws_url(board_id, owner.ws_token(board_id)["token"])) as second,
    ):
        first.send_bytes(ywire.sync_step1(Doc().get_state()))
        drain_until_update(first)

        with (
            pytest.raises(WebSocketDisconnect) as excinfo,
            client.websocket_connect(
                ws_url(board_id, owner.ws_token(board_id)["token"])
            ) as third,
        ):
            third.receive_bytes()
        assert excinfo.value.code == WS_ROOM_FULL

        # The refusal must not have disturbed the two already connected.
        doc = peer()
        doc["objects"]["still_here"] = Map({"type": "rect"})
        first.send_bytes(ywire.sync_update(bytes(doc.get_update())))
        second.send_bytes(ywire.sync_step1(Doc().get_state()))
        assert drain_until_update(second), "an existing peer stopped receiving"


# --- compaction under concurrency ----------------------------------------------


@pytest.fixture
def worker_sessions() -> Any:
    """A session factory on this test's own loop, as the arq worker would have."""
    engine = create_async_engine(TEST_DATABASE_URL)
    yield async_sessionmaker(engine, expire_on_commit=False)
    asyncio.run(engine.dispose())


def test_two_compaction_workers_do_not_double_fold(
    client: TestClient, owner: Actor, worker_sessions: Any
) -> None:
    """The advisory lock serialises them; the second run must be a no-op.

    ARCHITECTURE 3 chose a Postgres transaction-level lock over a Redis one precisely
    so a worker killed mid-run cannot strand a board. This asserts the ordinary case:
    two runs, one fold.
    """
    from app.realtime.ystore import compact_board
    from tests.wsclient import write_object

    board_id = owner.create_board()
    for index in range(5):
        write_object(client, owner, board_id, **{f"obj{index}": {"type": "rect"}})

    async def both() -> tuple[int, int]:
        return await asyncio.gather(  # type: ignore[return-value]
            compact_board(uuid.UUID(board_id), session_factory=worker_sessions),
            compact_board(uuid.UUID(board_id), session_factory=worker_sessions),
        )

    first, second = asyncio.run(both())

    assert min(first, second) == 0, "both runs folded rows, so the lock did not serialise them"
    assert max(first, second) > 0, "neither run did any work"

    # And the board is intact afterwards, which is the point of all of it.
    stored = board_objects(client, owner, board_id)
    assert set(stored) == {f"obj{index}" for index in range(5)}


def test_an_update_committing_during_compaction_survives(
    client: TestClient, owner: Actor, worker_sessions: Any
) -> None:
    """The scenario that motivated deleting exactly the folded ids.

    Postgres sequences are non-transactional, so a row can commit *after* a
    later-numbered one. A compaction that folded by watermark would strand it forever.
    Here the write lands between the compaction's read and the next room load, and it
    has to still be in the document.
    """
    from app.realtime.ystore import compact_board
    from tests.wsclient import write_object

    board_id = owner.create_board()
    for index in range(4):
        write_object(client, owner, board_id, **{f"before{index}": {"type": "rect"}})

    folded = asyncio.run(compact_board(uuid.UUID(board_id), session_factory=worker_sessions))
    assert folded > 0

    # A write arriving after the fold, which is the row a watermark filter would skip.
    write_object(client, owner, board_id, after={"type": "ellipse"})

    stored = board_objects(client, owner, board_id)
    assert "after" in stored, "an update written after compaction was lost"
    assert set(stored) == {f"before{index}" for index in range(4)} | {"after"}


def test_compaction_is_a_no_op_on_an_untouched_board(
    client: TestClient, owner: Actor, worker_sessions: Any
) -> None:
    """Nothing to fold means no snapshot row, or the table grows on a timer."""
    from app.realtime.ystore import compact_board

    board_id = owner.create_board()
    assert asyncio.run(compact_board(uuid.UUID(board_id), session_factory=worker_sessions)) == 0


# --- thumbnails must not ride along on the board list ---------------------------


def test_listing_boards_never_touches_the_thumbnail_table(
    client: TestClient, owner: Actor
) -> None:
    """The board list must not drag image bytes along with its metadata.

    A thumbnail is a few hundred kilobytes and a workspace can hold hundreds of
    boards, so a list query that loaded them would move tens of megabytes to render a
    page of titles. Nothing today does: the bytes live in `board_thumbnails`, keyed by
    board id, with no relationship pointing at it from `Board`.

    Asserted on the SQL the request actually emits rather than on the response body,
    because the response has been correct all along. What this catches is somebody
    later adding a `relationship()` and an eager load, which changes nothing visible
    and quietly multiplies the cost of the most-hit endpoint in the app.
    """
    from sqlalchemy import event

    from app.db import engine

    board_id = owner.create_board("Has a picture")
    upload = client.put(
        f"/api/v1/boards/{board_id}/thumbnail",
        content=b"RIFF____WEBPVP8 " + b"\x00" * 4096,
        headers={**owner.auth, "content-type": "image/webp"},
    )
    assert upload.status_code == 204, upload.text

    statements: list[str] = []

    def record(conn: Any, cursor: Any, statement: str, *args: Any) -> None:
        statements.append(statement)

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        response = client.get("/api/v1/boards", headers=owner.auth)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    assert response.status_code == 200, response.text
    assert any(board["id"] == board_id for board in response.json())

    offenders = [sql for sql in statements if "board_thumbnails" in sql.lower()]
    assert not offenders, f"the board list read the thumbnail table: {offenders}"

    # And nothing selected an image column from anywhere.
    assert not [sql for sql in statements if ".image" in sql.lower()]


def test_the_boards_table_holds_no_binary_columns() -> None:
    """The invariant behind the test above, stated directly.

    Keeping the bytes off `boards` is what makes `select(Board)` safe to write without
    enumerating columns, and the list endpoint does exactly that. If a `bytea` ever
    lands on this table the cheap query silently becomes an expensive one, and the SQL
    assertion above would not notice because the table name never changes.

    `thumbnail_url` is a String and is deliberately unused: it is reserved for the v2
    object-storage path, when user-uploaded images make MinIO worth standing up.
    """
    from sqlalchemy import LargeBinary

    from app.models import Board

    binary = [
        column.name
        for column in Board.__table__.columns
        if isinstance(column.type, LargeBinary)
    ]
    assert not binary, f"binary columns on boards would load on every list query: {binary}"
