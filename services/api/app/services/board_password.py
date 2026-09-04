"""A password on a board, and the pass that proves somebody typed it.

The one rule this module exists to enforce: **the password outranks everything else**.
Roles, workspace seats, the public share link - all of them answer "who is this and
what may they do", and none of them answers "may this browser see the document at
all". A board with a password answers that second question first, and answers it the
same way for a stranger on a public link and for the owner who set it. That is the
whole point of the feature, and it is why the check lives beside the lock in
`app/services/permissions.py` rather than in a router: a rule that outranks the role
has to be resolved wherever the role is, or there is a route that forgets it.

The owner is not exempt. It reads as strange for about a second and then reads as the
only coherent rule: an exemption would make the password "everyone except one account",
which is a weaker thing than the control says it is, and the owner is the one person
who cannot be locked out anyway - `PUT`/`DELETE /boards/{id}/password` are owner-only
and neither one asks for the current password. Forgetting it costs an owner one click,
not a board.

**The pass.** Typing a password on every reconnect is not a feature, and a websocket
that reconnects on every eviction reconnects often. So a successful verification mints
a short-lived signed pass which the client keeps for the tab and presents at every
ws-token mint. It is a receipt, not a credential for anything else: it names one board,
carries no identity, grants no role, and stops working the moment the password changes.

That last part is `boards.password_version`, which is incremented by every set, change
and removal. It is what makes "change the password" mean "everybody currently holding
the old one is out", without a table of issued passes to sweep: the version is baked
into the pass and into the ws-token minted from it, and it is compared against the
board's own on every handshake and every fifteen-minute revalidation.

The hash itself is argon2id through `app/auth/password.py` - the same hasher accounts
use, because a board password is guessed the same way an account one is.
"""

import hashlib
import hmac
import time
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from app.auth.password import hash_password, verify_password
from app.config import settings

if TYPE_CHECKING:
    from app.models import Board

#: The shortest password worth calling one. Long enough that the rate limit on the
#: verify endpoint is doing arithmetic rather than a formality, short enough that a
#: board password can be the sort of thing said out loud on a call, which is how this
#: one is usually shared.
MIN_LENGTH = 6

#: Bounded so a multi-kilobyte string never reaches argon2, which would hash it
#: happily and slowly.
MAX_LENGTH = 128

#: Domain separator, so a pass can never be mistaken for a ws-token and the other way
#: round. Both are HMACs under `settings.jwt_secret`, and two token formats signed by
#: one key with no label between them is how one becomes the other.
_DOMAIN = "meadow.boardpass"

#: What a refusal for an unproved password says, on every route that can give one.
#:
#: A constant rather than a string typed into four routers, because the client branches
#: on it: this is the difference between showing a password prompt and showing "ask the
#: owner to let you in", and a router that phrased it its own way would send somebody to
#: the wrong screen.
PASSWORD_REQUIRED = "password required"

#: The field standing in for "no pass presented". Neither a uuid nor an integer can be
#: this, so it can never collide with a real value in the ws-token payload.
ABSENT = "-"


def is_set(board: "Board") -> bool:
    return board.password_hash is not None


def set_password(board: "Board", raw: str) -> None:
    """Put a password on the board, or replace the one it has.

    Bumps the version, which is what retires every pass already issued. Changing a
    password that has been passed around too widely is the whole reason somebody
    changes one, so it has to mean the people holding the old one stop.
    """
    board.password_hash = hash_password(raw)
    board.password_set_at = datetime.now(UTC)
    board.password_version += 1


def clear(board: "Board") -> None:
    """Take the password off. Also a version bump, for the same reason."""
    board.password_hash = None
    board.password_set_at = None
    board.password_version += 1


def check(board: "Board", raw: str) -> bool:
    """Whether this is the board's password. False when it has none.

    False rather than True for a board with no password: this answers "did they prove
    it", and there is nothing to prove. Callers ask `is_set` first; the endpoint that
    does not is refusing a verification against a board that has no password, which is
    a client bug and not an unlock.
    """
    if board.password_hash is None:
        return False
    return verify_password(board.password_hash, raw)


# --- the pass ---------------------------------------------------------------------


def _sign(payload: str) -> str:
    return hmac.new(
        settings.jwt_secret.encode(), f"{_DOMAIN}.{payload}".encode(), hashlib.sha256
    ).hexdigest()


def mint_pass(board_id: str, version: int) -> str:
    """A receipt for one board at one password version.

    Not consumed on use, unlike a ws-token: this one is presented at every mint for as
    long as somebody keeps the tab open, and single use would mean typing the password
    on every reconnect.
    """
    expires_at = int(time.time()) + settings.board_pass_ttl_seconds
    payload = f"{board_id}.{version}.{expires_at}"
    return f"{payload}.{_sign(payload)}"


def read_pass(token: str, board_id: str) -> int | None:
    """The password version this pass proves for this board, or None.

    None for every kind of failure - forged, expired, malformed, minted for another
    board - because the caller does nothing different with any of them: an unusable
    pass is no pass, and the answer is the password prompt either way.
    """
    parts = token.split(".")
    if len(parts) != 4:
        return None

    claimed_board, raw_version, raw_expires, signature = parts
    payload = f"{claimed_board}.{raw_version}.{raw_expires}"
    if not hmac.compare_digest(_sign(payload), signature):
        return None

    try:
        version = int(raw_version)
        expires_at = int(raw_expires)
    except ValueError:
        return None

    if expires_at < int(time.time()):
        return None
    # Scoped to one board, like a ws-token and for the same reason: an authentic pass
    # for somewhere else is not a pass for here.
    if claimed_board != board_id:
        return None
    return version
