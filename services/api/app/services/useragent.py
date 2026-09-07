"""Turn a User-Agent header into something a person can recognise.

Only ever for display. Nothing here is a security decision, nothing is stored, and the
raw header is kept beside the parse so a wrong guess is correctable by looking at it.

Deliberately a short table of substrings rather than a UA-parsing dependency. The whole
job is answering "is this the Firefox on my laptop or the Safari on my phone?" for a
person reading their own sessions list, and the modern header has been frozen into a
handful of shapes for exactly that much. A library would bring a regex database that
needs updating to keep telling the same small truth.
"""

from dataclasses import dataclass
from typing import Literal

DeviceKind = Literal["desktop", "mobile", "tablet", "unknown"]


@dataclass(frozen=True)
class Client:
    browser: str | None
    os: str | None
    device: DeviceKind

    def label(self) -> str:
        """ "Firefox on Windows", or as much of it as the header supports."""
        if self.browser is not None and self.os is not None:
            return f"{self.browser} on {self.os}"
        return self.browser or self.os or "Unknown browser"


# Order is the whole trick. Every Chromium browser says "Chrome", and Chrome itself
# says "Safari", so the specific names have to be tried before the ones they borrow.
_BROWSERS: tuple[tuple[str, str], ...] = (
    ("Edg/", "Edge"),
    ("OPR/", "Opera"),
    ("Opera", "Opera"),
    ("Vivaldi", "Vivaldi"),
    ("SamsungBrowser", "Samsung Internet"),
    ("YaBrowser", "Yandex"),
    ("Brave", "Brave"),
    ("CriOS", "Chrome"),
    ("FxiOS", "Firefox"),
    ("EdgiOS", "Edge"),
    ("Firefox", "Firefox"),
    ("Chromium", "Chromium"),
    ("Chrome", "Chrome"),
    ("Safari", "Safari"),
)

# Windows before the rest because "Windows NT" contains nothing else, and iOS before
# macOS because an iPad on desktop mode claims "Macintosh" and is caught by "iPad".
_OPERATING_SYSTEMS: tuple[tuple[str, str], ...] = (
    ("Windows NT", "Windows"),
    ("Android", "Android"),
    ("iPhone", "iOS"),
    ("iPad", "iPadOS"),
    ("iPod", "iOS"),
    ("CrOS", "ChromeOS"),
    ("Mac OS X", "macOS"),
    ("Macintosh", "macOS"),
    ("Ubuntu", "Ubuntu"),
    ("Linux", "Linux"),
)


def _device(raw: str) -> DeviceKind:
    if "iPad" in raw or ("Android" in raw and "Mobile" not in raw and "Mobi" not in raw):
        return "tablet"
    if "Mobi" in raw or "iPhone" in raw or "iPod" in raw or "Windows Phone" in raw:
        return "mobile"
    return "desktop"


def parse(raw: str | None) -> Client:
    """Best guess at the browser, OS and form factor behind a header.

    An absent or unrecognisable header is not an error: a session signed in from a
    scripted client is still a session, and it is listed with whatever is known.
    """
    if raw is None or raw.strip() == "":
        return Client(browser=None, os=None, device="unknown")

    browser = next((name for token, name in _BROWSERS if token in raw), None)
    operating_system = next((name for token, name in _OPERATING_SYSTEMS if token in raw), None)
    return Client(browser=browser, os=operating_system, device=_device(raw))
