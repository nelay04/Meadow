"""Connecting an assistant with OAuth: discovery, registration, consent, codes, refresh.

What an assistant ends up holding is an ordinary fine-grained access token, so what it
may do is still decided by `resolve_access` and the token's grants. These tests are about
the ways of getting one that must fail: a missing or wrong PKCE verifier, a code used
twice, a redirect that does not match, an approval made by anything but a signed-in
person, and a refresh token presented after it was rotated.
"""

import asyncio
import base64
import hashlib
import json
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from urllib.parse import parse_qs, urlsplit

import asyncpg
import pytest
from starlette.testclient import TestClient

from app.config import settings
from tests.conftest import TEST_DATABASE_URL, Actor, _asyncpg_dsn

REDIRECT = "https://assistant.example/callback"
BASE = settings.web_base_url.rstrip("/")


def _pkce() -> tuple[str, str]:
    verifier = secrets.token_urlsafe(48)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    return verifier, challenge.decode().rstrip("=")


def _register(client: TestClient, **extra: Any) -> dict[str, Any]:
    body = {"client_name": "Assistant", "redirect_uris": [REDIRECT], **extra}
    response = client.post("/api/v1/connect/register", json=body)
    assert response.status_code == 201, response.text
    registered: dict[str, Any] = response.json()
    return registered


def _authorize(client: TestClient, client_id: str, challenge: str, **overrides: str) -> Any:
    params = {
        "response_type": "code",
        "client_id": client_id,
        "redirect_uri": REDIRECT,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": "state-123",
        **overrides,
    }
    return client.get("/api/v1/connect/authorize", params=params, follow_redirects=False)


def _request_id(response: Any) -> str:
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith(f"{BASE}/#/connect/"), location
    request_id: str = location.rsplit("/", 1)[1]
    return request_id


def _query(url: str) -> dict[str, str]:
    return {key: values[0] for key, values in parse_qs(urlsplit(url).query).items()}


def _approve(client: TestClient, person: Actor, request_id: str, **body: Any) -> Any:
    return client.post(
        f"/api/v1/connect/requests/{request_id}/approve",
        json={"grants": [], "can_create": True, **body},
        headers=person.auth,
    )


def _exchange(client: TestClient, client_id: str, code: str, verifier: str, **extra: str) -> Any:
    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT,
        "client_id": client_id,
        "code_verifier": verifier,
        **extra,
    }
    return client.post("/api/v1/connect/token", data=data)


def _connect(client: TestClient, person: Actor, **approval: Any) -> tuple[str, dict[str, Any]]:
    """The whole flow, as an assistant runs it. Returns the client id and the tokens."""
    client_id = _register(client)["client_id"]
    verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))
    approved = _approve(client, person, request_id, **approval)
    assert approved.status_code == 200, approved.text
    code = _query(approved.json()["redirect_url"])["code"]
    tokens = _exchange(client, client_id, code, verifier)
    assert tokens.status_code == 200, tokens.text
    body: dict[str, Any] = tokens.json()
    return client_id, body


def _sql(statement: str, *args: Any) -> None:
    async def run() -> None:
        conn = await asyncpg.connect(_asyncpg_dsn(TEST_DATABASE_URL))
        try:
            await conn.execute(statement, *args)
        finally:
            await conn.close()

    asyncio.run(run())


def _bearer(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


# --- discovery ---------------------------------------------------------------------


def test_the_server_describes_itself(client: TestClient) -> None:
    server = client.get("/.well-known/oauth-authorization-server")
    assert server.status_code == 200, server.text
    meta = server.json()
    assert meta["issuer"] == BASE
    assert meta["authorization_endpoint"] == f"{BASE}/api/v1/connect/authorize"
    assert meta["token_endpoint"] == f"{BASE}/api/v1/connect/token"
    assert meta["registration_endpoint"] == f"{BASE}/api/v1/connect/register"
    assert meta["code_challenge_methods_supported"] == ["S256"]
    assert "refresh_token" in meta["grant_types_supported"]

    for path in (
        "/.well-known/oauth-protected-resource/mcp",
        "/.well-known/oauth-protected-resource",
    ):
        resource = client.get(path)
        assert resource.status_code == 200, resource.text
        assert resource.json()["resource"] == f"{BASE}/mcp"
        assert resource.json()["authorization_servers"] == [BASE]


# --- registration ------------------------------------------------------------------


def test_registration_needs_https_or_a_loopback_redirect(client: TestClient) -> None:
    refused = client.post(
        "/api/v1/connect/register",
        json={"client_name": "Sneaky", "redirect_uris": ["http://evil.example/cb"]},
    )
    assert refused.status_code == 400
    assert refused.json()["error"] == "invalid_redirect_uri"

    assert client.post("/api/v1/connect/register", json={"client_name": "None"}).status_code == 400

    loopback = client.post(
        "/api/v1/connect/register",
        json={"client_name": "Local", "redirect_uris": ["http://127.0.0.1:33418/callback"]},
    )
    assert loopback.status_code == 201, loopback.text


# --- authorize ---------------------------------------------------------------------


def test_an_unknown_client_or_redirect_is_refused_without_redirecting(
    client: TestClient,
) -> None:
    """Redirecting an error to an unverified address is the open redirect OAuth warns of."""
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()

    unknown = _authorize(client, "no-such-client", challenge)
    assert unknown.status_code == 400
    assert "location" not in unknown.headers

    elsewhere = _authorize(client, client_id, challenge, redirect_uri="https://evil.example/cb")
    assert elsewhere.status_code == 400
    assert "location" not in elsewhere.headers


def test_pkce_is_required_and_only_s256(client: TestClient) -> None:
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()

    for overrides in ({"code_challenge": ""}, {"code_challenge_method": "plain"}):
        response = _authorize(client, client_id, challenge, **overrides)
        assert response.status_code == 302
        sent_back = _query(response.headers["location"])
        assert response.headers["location"].startswith(REDIRECT)
        assert sent_back["error"] == "invalid_request"
        assert sent_back["state"] == "state-123"


# --- consent -----------------------------------------------------------------------


def test_the_consent_page_reads_the_request(client: TestClient, owner: Actor) -> None:
    client_id = _register(client, client_name="Helpful Assistant")["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    assert client.get(f"/api/v1/connect/requests/{request_id}").status_code == 401
    details = client.get(f"/api/v1/connect/requests/{request_id}", headers=owner.auth)
    assert details.status_code == 200, details.text
    assert details.json()["client_name"] == "Helpful Assistant"
    assert details.json()["redirect_host"] == "assistant.example"

    missing = client.get("/api/v1/connect/requests/not-a-request", headers=owner.auth)
    assert missing.status_code == 404


def test_only_a_signed_in_person_can_approve(client: TestClient, owner: Actor) -> None:
    """An access token must not be a way to mint more access tokens."""
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    minted = client.post(
        "/api/v1/tokens", json={"name": "cli", "kind": "classic"}, headers=owner.auth
    )
    assert minted.status_code == 201, minted.text
    refused = client.post(
        f"/api/v1/connect/requests/{request_id}/approve",
        json={"grants": [], "can_create": True},
        headers=_bearer(minted.json()["token"]),
    )
    assert refused.status_code == 401

    assert (
        client.post(
            f"/api/v1/connect/requests/{request_id}/approve",
            json={"grants": [], "can_create": True},
        ).status_code
        == 401
    )


def test_approving_needs_something_to_grant(client: TestClient, owner: Actor) -> None:
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    assert _approve(client, owner, request_id, can_create=False).status_code == 422


def test_a_grant_on_a_glade_you_cannot_open_is_refused(
    client: TestClient, owner: Actor, outsider: Actor
) -> None:
    theirs = outsider.create_board()
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    refused = _approve(client, owner, request_id, grants=[{"board_id": theirs, "edit": True}])
    assert refused.status_code == 403


def test_deny_sends_the_assistant_away_empty_handed(client: TestClient, owner: Actor) -> None:
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    denied = client.post(f"/api/v1/connect/requests/{request_id}/deny", headers=owner.auth)
    assert denied.status_code == 200, denied.text
    sent_back = _query(denied.json()["redirect_url"])
    assert sent_back["error"] == "access_denied"
    assert sent_back["state"] == "state-123"

    assert _approve(client, owner, request_id).status_code == 404


# --- the token ---------------------------------------------------------------------


def test_the_issued_token_holds_exactly_what_was_picked(client: TestClient, owner: Actor) -> None:
    glade = owner.create_board("Picked")
    owner.create_board("Not picked")

    _client_id, tokens = _connect(
        client, owner, grants=[{"board_id": glade, "edit": True}], can_create=False
    )
    assert tokens["token_type"] == "Bearer"
    assert tokens["expires_in"] == 3600
    assert tokens["access_token"].startswith("mdw_")
    assert tokens["refresh_token"]

    current = client.get("/api/v1/tokens/current", headers=_bearer(tokens["access_token"]))
    assert current.status_code == 200, current.text
    described = current.json()
    assert described["kind"] == "fine_grained"
    assert described["can_create_glades"] is False
    assert [(g["board_id"], g["edit"], g["delete"]) for g in described["grants"]] == [
        (glade, True, False)
    ]

    listed = client.get("/api/v1/tokens", headers=owner.auth).json()
    assert [row["client_name"] for row in listed] == ["Assistant"]


def test_a_code_is_single_use_and_bound_to_its_verifier(client: TestClient, owner: Actor) -> None:
    client_id = _register(client)["client_id"]
    verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))
    code = _query(_approve(client, owner, request_id).json()["redirect_url"])["code"]

    wrong = _exchange(client, client_id, code, _pkce()[0])
    assert wrong.status_code == 400
    assert wrong.json()["error"] == "invalid_grant"

    # A failed attempt spends the code too, so it cannot be guessed at.
    assert _exchange(client, client_id, code, verifier).json()["error"] == "invalid_grant"


@pytest.mark.parametrize(
    "tamper", [{"redirect_uri": "https://assistant.example/other"}, {"client_id": "someone-else"}]
)
def test_a_code_is_bound_to_its_client_and_redirect(
    client: TestClient, owner: Actor, tamper: dict[str, str]
) -> None:
    client_id = _register(client)["client_id"]
    verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))
    code = _query(_approve(client, owner, request_id).json()["redirect_url"])["code"]

    data = {
        "grant_type": "authorization_code",
        "code": code,
        "redirect_uri": REDIRECT,
        "client_id": client_id,
        "code_verifier": verifier,
        **tamper,
    }
    response = client.post("/api/v1/connect/token", data=data)
    assert response.status_code in (400, 401)
    assert response.json()["error"] in ("invalid_grant", "invalid_client")


def test_an_approval_is_single_use(client: TestClient, owner: Actor) -> None:
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    assert _approve(client, owner, request_id).status_code == 200
    assert _approve(client, owner, request_id).status_code == 404


# --- refresh -----------------------------------------------------------------------


def _refresh(client: TestClient, client_id: str, refresh_token: str) -> Any:
    return client.post(
        "/api/v1/connect/token",
        data={
            "grant_type": "refresh_token",
            "refresh_token": refresh_token,
            "client_id": client_id,
        },
    )


def test_refresh_rotates_both_secrets(client: TestClient, owner: Actor) -> None:
    client_id, first = _connect(client, owner)

    refreshed = _refresh(client, client_id, first["refresh_token"])
    assert refreshed.status_code == 200, refreshed.text
    second = refreshed.json()
    assert second["access_token"] != first["access_token"]
    assert second["refresh_token"] != first["refresh_token"]

    assert (
        client.get("/api/v1/tokens/current", headers=_bearer(second["access_token"])).status_code
        == 200
    )
    assert (
        client.get("/api/v1/tokens/current", headers=_bearer(first["access_token"])).status_code
        == 401
    )

    # Still one token on the profile page, not one per refresh.
    assert len(client.get("/api/v1/tokens", headers=owner.auth).json()) == 1


def test_a_chosen_lifetime_caps_the_connection_and_its_refreshes(
    client: TestClient, owner: Actor
) -> None:
    before = datetime.now(UTC)
    client_id, first = _connect(client, owner, expires_in_days=7)
    after = datetime.now(UTC)

    [listed] = client.get("/api/v1/tokens", headers=owner.auth).json()
    ends_at = datetime.fromisoformat(listed["ends_at"])
    assert before + timedelta(days=7) <= ends_at <= after + timedelta(days=7)
    # Not the thirty days a renewal would otherwise give.
    assert datetime.fromisoformat(listed["expires_at"]) == ends_at

    refreshed = _refresh(client, client_id, first["refresh_token"])
    assert refreshed.status_code == 200, refreshed.text
    [listed] = client.get("/api/v1/tokens", headers=owner.auth).json()
    assert datetime.fromisoformat(listed["ends_at"]) == ends_at
    assert datetime.fromisoformat(listed["expires_at"]) == ends_at

    # Past the end, neither the secret nor a refresh gets back in.
    _sql(
        "update api_tokens set ends_at = now() - interval '1 second', "
        "expires_at = now() - interval '1 second' where id = $1",
        uuid.UUID(listed["id"]),
    )
    second = refreshed.json()
    assert (
        client.get("/api/v1/tokens/current", headers=_bearer(second["access_token"])).status_code
        == 401
    )
    assert _refresh(client, client_id, second["refresh_token"]).status_code == 400


def test_without_a_lifetime_a_connection_renews_while_used(
    client: TestClient, owner: Actor
) -> None:
    before = datetime.now(UTC)
    _connect(client, owner)
    [listed] = client.get("/api/v1/tokens", headers=owner.auth).json()
    assert listed["ends_at"] is None
    assert datetime.fromisoformat(listed["expires_at"]) >= before + timedelta(days=30)


@pytest.mark.parametrize("days", [0, 367])
def test_a_lifetime_outside_a_day_to_a_year_is_refused_on_approval(
    client: TestClient, owner: Actor, days: int
) -> None:
    client_id = _register(client)["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))
    assert _approve(client, owner, request_id, expires_in_days=days).status_code == 422


def test_a_reused_refresh_token_revokes_the_connection(client: TestClient, owner: Actor) -> None:
    """Somebody holds a copy. Which of the two is the thief cannot be told, so both stop."""
    client_id, first = _connect(client, owner)
    second = _refresh(client, client_id, first["refresh_token"]).json()

    reused = _refresh(client, client_id, first["refresh_token"])
    assert reused.status_code == 400
    assert reused.json()["error"] == "invalid_grant"

    assert (
        client.get("/api/v1/tokens/current", headers=_bearer(second["access_token"])).status_code
        == 401
    )
    assert _refresh(client, client_id, second["refresh_token"]).json()["error"] == "invalid_grant"


def test_revoking_on_the_profile_page_ends_the_refresh_too(
    client: TestClient, owner: Actor
) -> None:
    client_id, tokens = _connect(client, owner)
    token_id = client.get("/api/v1/tokens", headers=owner.auth).json()[0]["id"]

    assert client.delete(f"/api/v1/tokens/{token_id}", headers=owner.auth).status_code == 204
    assert _refresh(client, client_id, tokens["refresh_token"]).json()["error"] == "invalid_grant"


def test_a_refresh_token_belongs_to_its_client(client: TestClient, owner: Actor) -> None:
    _client_id, tokens = _connect(client, owner)
    other = _register(client)["client_id"]

    response = _refresh(client, other, tokens["refresh_token"])
    assert response.json()["error"] == "invalid_grant"


# --- confidential clients ------------------------------------------------------------


def test_a_client_registered_with_a_secret_must_send_it(client: TestClient, owner: Actor) -> None:
    registered = _register(client, token_endpoint_auth_method="client_secret_post")
    client_id, secret = registered["client_id"], registered["client_secret"]
    assert secret

    verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))
    code = _query(_approve(client, owner, request_id).json()["redirect_url"])["code"]

    without = _exchange(client, client_id, code, verifier)
    assert without.status_code == 401
    assert without.json()["error"] == "invalid_client"

    request_id = _request_id(_authorize(client, client_id, challenge))
    code = _query(_approve(client, owner, request_id).json()["redirect_url"])["code"]
    basic = base64.b64encode(f"{client_id}:{secret}".encode()).decode()
    with_basic = client.post(
        "/api/v1/connect/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
        },
        headers={"Authorization": f"Basic {basic}"},
    )
    assert with_basic.status_code == 200, with_basic.text


# --- client ID metadata documents -----------------------------------------------------

DOC_URL = "https://assistant.example/oauth/client.json"


def _document(**overrides: Any) -> dict[str, Any]:
    return {
        "client_id": DOC_URL,
        "client_name": "Published Assistant",
        "redirect_uris": [REDIRECT],
        "token_endpoint_auth_method": "none",
        **overrides,
    }


@pytest.fixture
def published(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Serve metadata documents from a dict instead of the network, counting fetches."""
    from app.services import client_metadata

    served: dict[str, Any] = {"documents": {DOC_URL: _document()}, "fetches": 0}

    async def download(url: str) -> bytes:
        served["fetches"] += 1
        document = served["documents"].get(url)
        if document is None:
            raise client_metadata.MetadataError("not found")
        return json.dumps(document).encode()

    monkeypatch.setattr(client_metadata, "download", download)
    return served


def test_the_server_says_it_reads_metadata_documents(client: TestClient) -> None:
    meta = client.get("/.well-known/oauth-authorization-server").json()
    assert meta["client_id_metadata_document_supported"] is True


@pytest.mark.parametrize(
    ("url", "ok"),
    [
        (DOC_URL, True),
        ("https://assistant.example/", False),
        ("https://assistant.example", False),
        ("http://assistant.example/client.json", False),
        ("https://user:pass@assistant.example/client.json", False),
        ("https://assistant.example/client.json#frag", False),
        ("https://assistant.example/a/../client.json", False),
        ("https://assistant.example/" + "a" * 600, False),
    ],
)
def test_which_urls_can_be_client_ids(url: str, ok: bool) -> None:
    from app.services import client_metadata

    assert client_metadata.valid_client_id(url) is ok


@pytest.mark.parametrize(
    ("address", "public"),
    [
        ("8.8.8.8", True),
        ("2606:4700:4700::1111", True),
        ("127.0.0.1", False),
        ("10.0.0.5", False),
        ("192.168.1.1", False),
        ("169.254.169.254", False),
        ("100.64.0.1", False),
        ("::1", False),
        ("fd00::1", False),
        ("::ffff:127.0.0.1", False),
        ("0.0.0.0", False),
    ],
)
def test_only_public_addresses_are_fetched_from(address: str, public: bool) -> None:
    from app.services import client_metadata

    assert client_metadata.is_public_address(address) is public


def test_a_fetch_to_a_private_address_is_refused_before_connecting() -> None:
    """The guard is at connect time, on the address DNS actually returned."""
    from app.services import client_metadata

    for url in ("https://localhost/client.json", "https://127.0.0.1/client.json"):
        with pytest.raises(client_metadata.MetadataError, match="not a public address"):
            asyncio.run(client_metadata.download(url))


def test_a_published_client_connects_without_registering(
    client: TestClient, owner: Actor, published: dict[str, Any]
) -> None:
    glade = owner.create_board()
    verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, DOC_URL, challenge))

    details = client.get(f"/api/v1/connect/requests/{request_id}", headers=owner.auth).json()
    assert details["client_name"] == "Published Assistant"
    assert details["client_host"] == "assistant.example"

    approved = _approve(client, owner, request_id, grants=[{"board_id": glade}], can_create=False)
    code = _query(approved.json()["redirect_url"])["code"]
    tokens = _exchange(client, DOC_URL, code, verifier)
    assert tokens.status_code == 200, tokens.text

    listed = client.get("/api/v1/tokens", headers=owner.auth).json()
    assert [row["client_name"] for row in listed] == ["Published Assistant"]

    refreshed = _refresh(client, DOC_URL, tokens.json()["refresh_token"])
    assert refreshed.status_code == 200, refreshed.text
    # Fetched once and then read from the cache, not once per request.
    assert published["fetches"] == 1


def test_a_client_preferring_a_jwt_but_supporting_none_connects(
    client: TestClient, owner: Actor, published: dict[str, Any]
) -> None:
    """ChatGPT's document, in the shape it publishes: private_key_jwt first, none allowed."""
    published["documents"][DOC_URL] = _document(
        client_name="ChatGPT",
        token_endpoint_auth_method="private_key_jwt",
        token_endpoint_auth_methods_supported=["none", "private_key_jwt"],
        token_endpoint_auth_signing_alg="RS256",
        jwks_uri="https://assistant.example/oauth/jwks.json",
        grant_types=["authorization_code", "refresh_token"],
        response_types=["code"],
    )
    glade = owner.create_board()
    verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, DOC_URL, challenge))

    details = client.get(f"/api/v1/connect/requests/{request_id}", headers=owner.auth).json()
    assert details["client_name"] == "ChatGPT"

    approved = _approve(client, owner, request_id, grants=[{"board_id": glade}], can_create=False)
    code = _query(approved.json()["redirect_url"])["code"]
    tokens = _exchange(client, DOC_URL, code, verifier)
    assert tokens.status_code == 200, tokens.text


def test_a_registered_client_is_not_verified(client: TestClient, owner: Actor) -> None:
    client_id = _register(client, client_name="Published Assistant")["client_id"]
    _verifier, challenge = _pkce()
    request_id = _request_id(_authorize(client, client_id, challenge))

    details = client.get(f"/api/v1/connect/requests/{request_id}", headers=owner.auth).json()
    assert details["client_host"] is None


@pytest.mark.parametrize(
    "document",
    [
        _document(client_id="https://assistant.example/someone-else.json"),
        _document(redirect_uris=["https://assistant.example/elsewhere"]),
        _document(token_endpoint_auth_method="client_secret_basic"),
        _document(
            token_endpoint_auth_method="private_key_jwt",
            token_endpoint_auth_methods_supported=["private_key_jwt", "client_secret_basic"],
        ),
        _document(redirect_uris=["http://evil.example/cb"]),
        None,
    ],
)
def test_a_document_that_does_not_hold_up_is_refused(
    client: TestClient, published: dict[str, Any], document: dict[str, Any] | None
) -> None:
    if document is None:
        published["documents"].clear()
    else:
        published["documents"][DOC_URL] = document
    _verifier, challenge = _pkce()

    response = _authorize(client, DOC_URL, challenge)
    assert response.status_code == 400
    assert "location" not in response.headers


def test_a_published_client_cannot_be_impersonated_by_a_registration(
    client: TestClient, published: dict[str, Any]
) -> None:
    """The stored row for a published client is never what decides where codes go."""
    refused = client.post(
        "/api/v1/connect/register",
        json={"client_id": DOC_URL, "client_name": "Imposter", "redirect_uris": [REDIRECT]},
    )
    assert refused.status_code == 201
    assert refused.json()["client_id"] != DOC_URL
