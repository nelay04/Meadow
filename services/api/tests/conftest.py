"""Test harness.

Runs against a real PostgreSQL and a real Redis rather than fakes. The things M1 has
to get right - citext, native enums, advisory locks, `SET NX` replay protection - are
exactly the things an in-memory substitute would paper over.

Two constraints shape the fixtures:

* Settings are read from the environment before `app.config` is imported, so the env
  writes below have to happen at module top, above any `app.*` import.
* asyncpg pools bind to the event loop that first used them, and `app.db.engine` is a
  module-level singleton. So there is exactly one `TestClient` for the whole session
  and every test shares its portal loop. Per-test cleanup runs on its own short-lived
  connection instead, which is loop-independent.
"""

import os

TEST_DATABASE_URL = os.environ.get(
    "MEADOW_TEST_DATABASE_URL",
    "postgresql+asyncpg://meadow:meadow@localhost:5435/meadow_test",
)
# Redis db 1, so a test run cannot flush the dev instance's keys.
TEST_REDIS_URL = os.environ.get("MEADOW_TEST_REDIS_URL", "redis://localhost:6380/1")

os.environ["MEADOW_DATABASE_URL"] = TEST_DATABASE_URL
os.environ["MEADOW_REDIS_URL"] = TEST_REDIS_URL
# 32+ bytes, or PyJWT warns on every encode about the HMAC key being short for SHA256.
os.environ["MEADOW_JWT_SECRET"] = "test-secret-not-used-anywhere-real-0123456789"
# Brute-force limits are asserted by their own test, which turns them back on.
os.environ["MEADOW_RATE_LIMIT_ENABLED"] = "false"

import asyncio  # noqa: E402
import subprocess  # noqa: E402
import uuid  # noqa: E402
from collections.abc import Iterator  # noqa: E402
from pathlib import Path  # noqa: E402
from typing import Any  # noqa: E402

import asyncpg  # noqa: E402
import pytest  # noqa: E402
from redis.asyncio import Redis  # noqa: E402
from starlette.testclient import TestClient  # noqa: E402

API_ROOT = Path(__file__).resolve().parents[1]


def _asyncpg_dsn(url: str, database: str | None = None) -> str:
    """SQLAlchemy URL -> plain libpq DSN, optionally pointed at another database."""
    dsn = url.replace("postgresql+asyncpg://", "postgresql://")
    if database is not None:
        dsn = dsn.rsplit("/", 1)[0] + "/" + database
    return dsn


async def _recreate_database() -> None:
    admin = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL, "postgres"))
    try:
        name = TEST_DATABASE_URL.rsplit("/", 1)[1]
        await admin.execute(
            "select pg_terminate_backend(pid) from pg_stat_activity "
            "where datname = $1 and pid <> pg_backend_pid()",
            name,
        )
        await admin.execute(f'drop database if exists "{name}"')
        await admin.execute(f'create database "{name}"')
    finally:
        await admin.close()


@pytest.fixture(scope="session", autouse=True)
def database() -> None:
    """Recreate the test database and bring it up with the real migrations.

    Alembic rather than `metadata.create_all`: a migration that does not reproduce the
    models is a production-only failure, and running them here is the cheapest place
    to catch it.
    """
    asyncio.run(_recreate_database())
    env = {**os.environ, "MEADOW_DATABASE_URL": TEST_DATABASE_URL}
    subprocess.run(
        [str(API_ROOT / ".venv" / "bin" / "alembic"), "upgrade", "head"],
        cwd=API_ROOT,
        env=env,
        check=True,
        capture_output=True,
    )


@pytest.fixture(scope="session")
def client(database: None) -> Iterator[TestClient]:
    from app.main import app

    with TestClient(app) as test_client:
        yield test_client


async def _truncate() -> None:
    conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
    try:
        rows = await conn.fetch(
            "select tablename from pg_tables where schemaname = 'public' "
            "and tablename <> 'alembic_version'"
        )
        if rows:
            tables = ", ".join(f'"{r["tablename"]}"' for r in rows)
            await conn.execute(f"truncate {tables} restart identity cascade")
    finally:
        await conn.close()


@pytest.fixture(autouse=True)
def clean_state(client: TestClient) -> Iterator[None]:
    """Empty tables and Redis keys between tests.

    Each test also uses fresh board uuids, so the websocket server's room cache never
    hands one test a room built by another.
    """
    asyncio.run(_truncate())

    async def flush() -> None:
        redis = Redis.from_url(TEST_REDIS_URL)
        await redis.flushdb()
        await redis.aclose()

    asyncio.run(flush())
    yield


# --- helpers -------------------------------------------------------------------


class Actor:
    """A registered user plus the tokens and ids the tests need."""

    def __init__(self, client: TestClient, email: str, password: str) -> None:
        self.client = client
        self.email = email
        self.password = password
        self.access_token = ""
        self.user_id = ""
        self.workspace_id = ""

    @property
    def auth(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.access_token}"}

    def login(self) -> None:
        response = self.client.post(
            "/api/v1/auth/login", json={"email": self.email, "password": self.password}
        )
        assert response.status_code == 200, response.text
        self.access_token = response.json()["access_token"]

    def create_board(self, title: str = "Test board") -> str:
        response = self.client.post(
            "/api/v1/boards",
            json={"workspace_id": self.workspace_id, "title": title},
            headers=self.auth,
        )
        assert response.status_code == 201, response.text
        board_id: str = response.json()["id"]
        return board_id

    def ws_token(self, board_id: str) -> dict[str, Any]:
        response = self.client.post(
            "/api/v1/ws-token", json={"board_id": board_id}, headers=self.auth
        )
        assert response.status_code == 200, response.text
        body: dict[str, Any] = response.json()
        return body


@pytest.fixture
def make_user(client: TestClient) -> Any:
    def factory(display_name: str = "Test User") -> Actor:
        # Not a .test/.local/.example domain: those are IANA special-use names and
        # email-validator refuses them outright.
        email = f"{uuid.uuid4().hex[:12]}@meadow-tests.dev"
        password = "correct-horse-battery-staple"
        response = client.post(
            "/api/v1/auth/register",
            json={"email": email, "password": password, "display_name": display_name},
        )
        assert response.status_code == 201, response.text
        body = response.json()

        actor = Actor(client, email, password)
        actor.access_token = body["access_token"]
        actor.user_id = body["user"]["id"]
        actor.workspace_id = body["user"]["default_workspace_id"]
        return actor

    return factory


@pytest.fixture
def owner(make_user: Any) -> Actor:
    return make_user("Owner")


@pytest.fixture
def outsider(make_user: Any) -> Actor:
    """A perfectly valid user with no relationship to the fixture board."""
    return make_user("Outsider")
