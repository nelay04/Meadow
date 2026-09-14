"""Client ID metadata documents: an assistant identified by a URL it publishes.

Instead of registering, a client uses an https URL as its `client_id`, and the JSON at
that URL names it and lists its redirect addresses. Meadow fetches it when the client
first appears. That gives the consent screen something registration cannot: the domain
in the URL is proved by TLS, so "assistant.example" on the screen is not just a name the
client chose.

Fetching a URL a stranger supplied is the risky part, and every guard is here:

- **Only public addresses.** Checked in the network backend, on the address the socket
  is about to connect to, after DNS. Checking the name first and connecting second would
  let a record that changes between the two (DNS rebinding) reach an internal service.
- **https, no redirects, a short timeout, a small body.** A redirect would be a second,
  unchecked URL; the document is a few hundred bytes, so 5 KB is generous.
- **The document must name itself.** Its `client_id` must equal the URL it came from, or
  a document copied to another address could claim to be the original.
- **Public clients only.** A shared secret in a published document is not a secret.

Documents are cached in Redis for fifteen minutes, so a sign-in and the refreshes after it
do not fetch on every request.
"""

import hashlib
import ipaddress
import json
import socket
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlsplit

import anyio
import httpcore
from redis.asyncio import Redis

from app.services.connect_urls import MAX_CLIENT_NAME, MAX_REDIRECT_URIS, valid_redirect

MAX_URL = 512
MAX_BYTES = 5 * 1024
TIMEOUT_SECONDS = 5.0
CACHE_SECONDS = 15 * 60

_CACHE_KEY = "connect:cimd:{}"


class MetadataError(Exception):
    """The document could not be fetched, or does not hold up."""


@dataclass(frozen=True)
class ClientMetadata:
    client_id: str
    name: str
    redirect_uris: list[str]

    @property
    def host(self) -> str:
        return urlsplit(self.client_id).hostname or ""


def valid_client_id(url: str) -> bool:
    """An https URL with a path, and nothing that makes two spellings of one address."""
    if len(url) > MAX_URL:
        return False
    parts = urlsplit(url)
    if parts.scheme != "https" or not parts.hostname:
        return False
    if parts.username is not None or parts.password is not None or parts.fragment:
        return False
    if parts.path in ("", "/"):
        return False
    return not any(segment in (".", "..") for segment in parts.path.split("/"))


def is_public_address(address: str) -> bool:
    try:
        ip = ipaddress.ip_address(address)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return ip.is_global and not ip.is_multicast


class _PublicOnlyBackend(httpcore.AsyncNetworkBackend):
    """Resolves a host itself and connects only to a public address it resolved to.

    httpcore passes the URL's host to `connect_tcp` and uses it separately for TLS
    server name checks, so connecting to the checked IP still verifies the certificate
    against the name.
    """

    def __init__(self) -> None:
        self._inner = httpcore.AnyIOBackend()

    async def connect_tcp(
        self,
        host: str,
        port: int,
        timeout: float | None = None,
        local_address: str | None = None,
        socket_options: Any = None,
    ) -> httpcore.AsyncNetworkStream:
        try:
            infos = await anyio.getaddrinfo(host, port, type=socket.SOCK_STREAM)
        except OSError as exc:
            raise MetadataError("the address does not resolve") from exc
        addresses = [str(info[4][0]) for info in infos]
        if not addresses or not all(is_public_address(address) for address in addresses):
            raise MetadataError("not a public address")
        return await self._inner.connect_tcp(
            addresses[0], port, timeout=timeout, local_address=local_address
        )

    async def connect_unix_socket(
        self, path: str, timeout: float | None = None, socket_options: Any = None
    ) -> httpcore.AsyncNetworkStream:
        raise MetadataError("not a public address")

    async def sleep(self, seconds: float) -> None:
        await self._inner.sleep(seconds)


async def download(url: str) -> bytes:
    """The raw document at a client id URL, through every network guard above."""
    if not valid_client_id(url):
        raise MetadataError("not a usable client id")
    try:
        async with httpcore.AsyncConnectionPool(network_backend=_PublicOnlyBackend()) as pool:
            with anyio.fail_after(TIMEOUT_SECONDS):
                async with pool.stream(
                    "GET",
                    url,
                    headers={"Accept": "application/json", "User-Agent": "Meadow"},
                    extensions={
                        "timeout": {
                            "connect": TIMEOUT_SECONDS,
                            "read": TIMEOUT_SECONDS,
                            "write": TIMEOUT_SECONDS,
                            "pool": TIMEOUT_SECONDS,
                        }
                    },
                ) as response:
                    if response.status != 200:
                        raise MetadataError(f"the document answered {response.status}")
                    body = bytearray()
                    async for chunk in response.aiter_stream():
                        body.extend(chunk)
                        if len(body) > MAX_BYTES:
                            raise MetadataError("the document is too large")
                    return bytes(body)
    except MetadataError:
        raise
    except (httpcore.TimeoutException, TimeoutError) as exc:
        raise MetadataError("the document took too long") from exc
    except (httpcore.NetworkError, httpcore.ProtocolError, OSError) as exc:
        raise MetadataError("the document could not be fetched") from exc


def parse(url: str, raw: bytes) -> ClientMetadata:
    try:
        document: Any = json.loads(raw)
    except ValueError as exc:
        raise MetadataError("the document is not JSON") from exc
    if not isinstance(document, dict):
        raise MetadataError("the document is not a JSON object")
    if document.get("client_id") != url:
        raise MetadataError("the document names a different client id")
    if document.get("token_endpoint_auth_method", "none") != "none":
        raise MetadataError("only public clients may publish their metadata")
    uris = document.get("redirect_uris")
    if (
        not isinstance(uris, list)
        or not 0 < len(uris) <= MAX_REDIRECT_URIS
        or not all(isinstance(uri, str) and valid_redirect(uri) for uri in uris)
    ):
        raise MetadataError("the document's redirect_uris are not usable")
    name = document.get("client_name")
    host = urlsplit(url).hostname or "Assistant"
    return ClientMetadata(
        client_id=url,
        name=(name.strip()[:MAX_CLIENT_NAME] if isinstance(name, str) else "") or host,
        redirect_uris=list(uris),
    )


async def resolve(redis: Redis, url: str) -> ClientMetadata | None:
    """The client a URL describes, from the cache or the network. None if it does not hold up."""
    if not valid_client_id(url):
        return None
    key = _CACHE_KEY.format(hashlib.sha256(url.encode()).hexdigest())
    cached = await redis.get(key)
    if cached is not None:
        data: dict[str, Any] = json.loads(cached)
        return ClientMetadata(**data)
    try:
        metadata = parse(url, await download(url))
    except MetadataError:
        return None
    await redis.set(key, json.dumps(metadata.__dict__), ex=CACHE_SECONDS)
    return metadata
