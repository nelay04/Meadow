"""Liveness and readiness.

The split is the point of these tests. `/healthz` must keep answering `ok` whatever
happens to Redis or Postgres, because it is the container's HEALTHCHECK and what
`compose up -d --wait` blocks on. `/readyz` must do the opposite. Until 1.27.4 there
was only the first kind, so every gate the deployment has called a Redis-less stack
healthy while nobody could sign in or open a glade.
"""

from typing import Any

import pytest
from fastapi.testclient import TestClient

from app.main import app


class _Dead:
    """A Redis that is there and does not answer."""

    async def ping(self) -> bool:
        raise ConnectionError("no route to redis")


@pytest.fixture
def dead_redis() -> Any:
    original = app.state.redis
    app.state.redis = _Dead()
    yield
    app.state.redis = original


def test_healthz_needs_no_credentials(client: TestClient) -> None:
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


def test_readyz_needs_no_credentials(client: TestClient) -> None:
    # Unauthenticated on purpose: the deploy and an external monitor both call it
    # before anybody is signed in.
    response = client.get("/readyz")
    assert response.status_code == 200
    assert response.json() == {"status": "ready", "checks": {"postgres": True, "redis": True}}


def test_readyz_refuses_when_redis_is_unreachable(
    client: TestClient, dead_redis: None
) -> None:
    response = client.get("/readyz")
    # 503 rather than a 200 carrying bad news, so `curl -f` and a load balancer agree
    # with a reader without anybody parsing the body.
    assert response.status_code == 503
    body = response.json()
    assert body["status"] == "not ready"
    assert body["checks"] == {"postgres": True, "redis": False}


def test_readyz_says_which_dependency_and_nothing_more(
    client: TestClient, dead_redis: None
) -> None:
    """The body is booleans. The exception detail belongs in the log, not the response.

    Which dependency is down is operationally necessary; the host, driver and
    traceback behind it are worth nothing to a stranger calling an open endpoint.
    """
    body = client.get("/readyz").text
    assert "no route to redis" not in body
    assert "ConnectionError" not in body
    assert "Traceback" not in body


def test_healthz_still_ok_when_redis_is_unreachable(
    client: TestClient, dead_redis: None
) -> None:
    """Liveness must not follow readiness down.

    If it did, a Redis outage would mark the API container unhealthy and a deploy that
    would have recovered on its own would be held up by `--wait` instead.
    """
    response = client.get("/healthz")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
