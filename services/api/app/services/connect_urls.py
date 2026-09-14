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
    if parts.hostname == "localhost":
        return True
    try:
        return ip_address(parts.hostname).is_loopback
    except ValueError:
        return False
