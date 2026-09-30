"""Address rules shared by registration and client metadata documents."""

from ipaddress import ip_address
from urllib.parse import urlsplit

#: A client's name is shown on the consent screen and the profile page. Bounded so a
#: registration cannot fill either with a paragraph.
MAX_CLIENT_NAME = 80
MAX_REDIRECT_URIS = 10


def valid_redirect(uri: str) -> bool:
    """https anywhere, or http on a loopback address for a client on this machine.

    No fragment, as RFC 6749 requires, and a host is always named.
    """
    if len(uri) > 2000:
        return False
    parts = urlsplit(uri)
    if parts.fragment or not parts.hostname:
        return False
    if parts.scheme == "https":
        return True
    if parts.scheme != "http":
        return False
    return _loopback(parts.hostname)


def _loopback(host: str | None) -> bool:
    if host is None:
        return False
    if host == "localhost":
        return True
    try:
        return ip_address(host).is_loopback
    except ValueError:
        return False


def redirect_allowed(requested: str, registered: list[str]) -> bool:
    """Whether a client may be sent to `requested`, given the redirects it declared.

    An exact match, or, for an http loopback redirect, a match in everything but the
    port. RFC 8252 7.3 requires that: a command-line assistant listens on whichever
    port is free when it signs in, so its published document names the callback
    without one (`http://localhost/callback`) and every real request carries a port
    nobody could have listed. Only the port is free. Scheme, host, path and query must
    match, so `127.0.0.1` does not stand in for `localhost`, and a code still only goes
    to this machine. The token exchange then has to name the same address the request
    did, port included, so a code cannot be moved to another port afterwards.
    """
    if requested in registered:
        return True
    if len(requested) > 2000:
        return False
    asked = urlsplit(requested)
    try:
        _ = asked.port  # read for the check: a port outside 0 to 65535 raises
    except ValueError:
        return False
    if (
        asked.scheme != "http"
        or not _loopback(asked.hostname)
        or asked.fragment
        or asked.username is not None
        or asked.password is not None
    ):
        return False
    for uri in registered:
        known = urlsplit(uri)
        if (
            known.scheme == "http"
            and known.username is None
            and known.hostname == asked.hostname
            and known.path == asked.path
            and known.query == asked.query
        ):
            return True
    return False
