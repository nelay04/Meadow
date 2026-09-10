"""Talking to a running Meadow API over a real socket.

Everything here goes through the network to a uvicorn process, not through Starlette's
in-process `TestClient`. That is the whole point of a separate harness: `TestClient`
runs the app on a portal thread inside the test process, so it measures neither the
event loop under concurrent sockets nor the serialisation the real server does.
"""

from __future__ import annotations

import asyncio
import json
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

import httpx
import websockets
from pycrdt import Array, Doc, Map

from tests import ywire

PASSWORD = "correct-horse-battery-staple"


@dataclass
class Target:
    """Where the load goes."""

    base_url: str = "http://127.0.0.1:8099"

    @property
    def ws_base(self) -> str:
        return self.base_url.replace("http://", "ws://").replace("https://", "wss://")

    def ws_url(self, board_id: str, token: str) -> str:
        return f"{self.ws_base}/ws/board/{board_id}?token={token}"


@dataclass
class User:
    """A registered account and the tokens that follow from it."""

    email: str
    user_id: str
    workspace_id: str
    access_token: str
    target: Target
    http: httpx.AsyncClient

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    async def create_board(self, title: str = "Load board") -> str:
        response = await self.http.post(
            f"{self.target.base_url}/api/v1/boards",
            json={"workspace_id": self.workspace_id, "title": title},
            headers=self.auth,
        )
        response.raise_for_status()
        return str(response.json()["id"])

    async def ws_token(self, board_id: str) -> str:
        response = await self.http.post(
            f"{self.target.base_url}/api/v1/ws-token",
            json={"board_id": board_id},
            headers=self.auth,
        )
        response.raise_for_status()
        return str(response.json()["token"])


async def register(target: Target, http: httpx.AsyncClient, label: str = "Load") -> User:
    """One fresh account, opened and signed in.

    A random address per user rather than a pool of reused ones: two load workers
    logging in as the same account would contend on that account's refresh-token
    family, which is a serialisation point this harness is not trying to measure.
    """
    email = f"{uuid.uuid4().hex[:16]}@meadow-load.dev"
    response = await http.post(
        f"{target.base_url}/api/v1/auth/register",
        json={"email": email, "password": PASSWORD, "display_name": label},
    )
    response.raise_for_status()
    if response.json().get("activation_required"):
        raise RuntimeError(
            "the target has mail configured, so accounts wait on activation. "
            "Run the load target with MEADOW_SMTP_HOST empty."
        )

    login = await http.post(
        f"{target.base_url}/api/v1/auth/login", json={"email": email, "password": PASSWORD}
    )
    login.raise_for_status()
    body = login.json()
    return User(
        email=email,
        user_id=body["user"]["id"],
        workspace_id=body["user"]["default_workspace_id"],
        access_token=body["access_token"],
        target=target,
        http=http,
    )


async def register_many(
    target: Target, http: httpx.AsyncClient, count: int, concurrency: int = 8
) -> list[User]:
    """`count` accounts, opened a few at a time.

    Bounded rather than all at once because registration and login are both argon2id
    hashes, and firing fifty of those simultaneously at a single-core-bound event loop
    measures the setup rather than the thing under test.
    """
    semaphore = asyncio.Semaphore(concurrency)

    async def one() -> User:
        async with semaphore:
            return await register(target, http)

    return list(await asyncio.gather(*(one() for _ in range(count))))


def peer_doc() -> Doc:
    """A client-shaped document: the two roots the schema locks down."""
    doc = Doc()
    doc["objects"] = Map()
    doc["order"] = Array()
    return doc


def shape(index: int, author: str) -> dict[str, Any]:
    """One object, shaped like something the canvas would actually write."""
    return {
        "type": "rect",
        "x": float(index % 2000),
        "y": float((index * 7) % 2000),
        "w": 120.0,
        "h": 80.0,
        "fill": "#8ab4f8",
        "author": author,
    }


@dataclass
class Peer:
    """One editor: a socket, a document, and the state vector already sent.

    Held open across many writes, which is what a real editor does. Reconnecting per
    edit would measure the handshake instead of the fan-out.
    """

    user: User
    board_id: str
    doc: Doc = field(default_factory=peer_doc)
    socket: Any = None
    sent_state: bytes = b""
    # Whether to fold what the server sends back into the local document.
    #
    # Off for the large runs. Fifty peers each holding a full copy of a growing
    # document is fifty copies in one process, and this harness shares a machine with
    # the server it is measuring - the 50-editor run OOM-killed the generator before
    # this existed. With it off a peer still *reads* every frame, so flow control and
    # the server's fan-out cost are unchanged; it just drops the bytes instead of
    # merging them. Convergence is checked against the server via `read_board`, which
    # builds a fresh document anyway, so nothing is lost by not keeping fifty of them.
    apply_remote: bool = True
    client_id: int = field(default_factory=lambda: uuid.uuid4().int % (2**31))

    async def connect(self) -> None:
        token = await self.user.ws_token(self.board_id)
        self.socket = await websockets.connect(
            self.user.target.ws_url(self.board_id, token),
            max_size=None,
            open_timeout=20,
            ping_interval=None,
        )
        self.sent_state = self.doc.get_state()
        # Step 1 announces what we have; the server answers with everything we lack.
        await self.socket.send(ywire.sync_step1(self.sent_state))

    async def close(self) -> None:
        if self.socket is not None:
            await self.socket.close()
            self.socket = None

    async def write(self, key: str, value: dict[str, Any]) -> int:
        """Mutate locally and push only the diff. Returns the bytes sent."""
        before = self.doc.get_state()
        objects: Map = self.doc["objects"]
        objects[key] = value
        update = bytes(self.doc.get_update(before))
        await self.socket.send(ywire.sync_update(update))
        return len(update)

    async def publish_cursor(self, payload: dict[str, Any], clock: int) -> None:
        """An awareness entry, which is how a cursor moves between peers."""
        await self.socket.send(
            ywire.awareness(self.client_id, clock, json.dumps(payload))
        )

    async def drain(self, seconds: float) -> int:
        """Apply whatever the server sends for a while. Returns messages consumed."""
        deadline = time.perf_counter() + seconds
        seen = 0
        while True:
            remaining = deadline - time.perf_counter()
            if remaining <= 0:
                return seen
            try:
                raw = await asyncio.wait_for(self.socket.recv(), timeout=remaining)
            except TimeoutError:
                return seen
            seen += 1
            self.apply(raw)

    async def drain_ready(self, limit: int = 64) -> int:
        """Consume only what has already arrived, then return.

        The saturation run needs this. A peer writing flat out must still read, or the
        server's fan-out backs up in the socket buffer until flow control stalls the
        writer - at which point the number being measured is TCP's, not the room's. A
        `limit` caps the work per call so one peer buried in fan-out cannot starve the
        others of the event loop.
        """
        seen = 0
        while seen < limit:
            try:
                raw = await asyncio.wait_for(self.socket.recv(), timeout=0.0005)
            except TimeoutError:
                return seen
            seen += 1
            self.apply(raw)
        return seen

    def apply(self, raw: bytes) -> None:
        """Fold one server message into the local document, ignoring awareness."""
        if isinstance(raw, str):
            return
        message_type, sync_type, payload = ywire.parse(raw)
        if message_type != ywire.MESSAGE_SYNC:
            return
        if sync_type in (ywire.SYNC_STEP2, ywire.SYNC_UPDATE) and payload:
            if self.apply_remote:
                self.doc.apply_update(payload)
        elif sync_type == ywire.SYNC_STEP1:
            # The server asking what we have. Answering keeps it from waiting.
            pass

    @property
    def objects(self) -> dict[str, Any]:
        return dict(self.doc["objects"])


async def read_board(user: User, board_id: str) -> dict[str, Any]:
    """Open a fresh socket and read back the document the server actually holds.

    A new Doc every time, so this asserts what the *server* has rather than what a
    peer that has been connected all along happens to remember.
    """
    doc = peer_doc()
    token = await user.ws_token(board_id)
    async with websockets.connect(
        user.target.ws_url(board_id, token), max_size=None, open_timeout=20, ping_interval=None
    ) as socket:
        await socket.send(ywire.sync_step1(doc.get_state()))
        deadline = time.perf_counter() + 15
        while time.perf_counter() < deadline:
            try:
                raw = await asyncio.wait_for(socket.recv(), timeout=2.0)
            except TimeoutError:
                break
            if isinstance(raw, str):
                continue
            _, sync_type, payload = ywire.parse(raw)
            if sync_type in (ywire.SYNC_STEP2, ywire.SYNC_UPDATE) and payload:
                doc.apply_update(payload)
    return dict(doc["objects"])
