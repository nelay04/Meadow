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

**Recovery.** That escape hatch is real but it is inside the board, and a forgotten
password is what is holding the board shut - so from the screen where it is needed it
could not be reached. `app/services/board_recovery.py` is the way round: a code to the
owner's own address, and spending it mints a temporary password with two hours on it,
which is `password_expires_at` here. An expired one leaves the board shut and not open;
`has_expired` says why.

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
import secrets
import time
from datetime import UTC, datetime, timedelta
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

#: The alphabet the temporary password is drawn from - see `generate`. Lower case
#: only, and without the pairs that are the same shape in most faces: `l`/`1`, `0`/`o`.
#: This is a string somebody reads out of an inbox and types into another window, and
#: an ambiguous character costs an attempt against a rate limit.
_TEMP_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789"

#: How many characters. 14 of a 31-character alphabet is ~69 bits, which is far past
#: what the rate limit in front of the verify route needs, and still four short groups.
_TEMP_LENGTH = 14

#: The field standing in for "no pass presented". Neither a uuid nor an integer can be
#: this, so it can never collide with a real value in the ws-token payload.
ABSENT = "-"


def is_set(board: "Board") -> bool:
    return board.password_hash is not None


def set_password(board: "Board", raw: str, *, expires_in: timedelta | None = None) -> None:
    """Put a password on the board, or replace the one it has.

    Bumps the version, which is what retires every pass already issued. Changing a
    password that has been passed around too widely is the whole reason somebody
    changes one, so it has to mean the people holding the old one stop.

    `expires_in` is the recovery flow's temporary password and nothing else. A password
    an owner chose has no expiry, and the column goes back to null on every ordinary
    set - which is how choosing a real one ends the temporary state, without a second
    call to undo it.
    """
    board.password_hash = hash_password(raw)
    board.password_set_at = datetime.now(UTC)
    board.password_expires_at = (
        None if expires_in is None else datetime.now(UTC) + expires_in
    )
    board.password_version += 1


def generate() -> str:
    """A temporary password, in groups of four so it can be read off a screen.

    Random rather than anything derived from the board or the owner: this is mailed,
    typed once, and meant to be replaced within the hour, and the only property it needs
    is that nobody can produce it who did not receive it.
    """
    body = "".join(secrets.choice(_TEMP_ALPHABET) for _ in range(_TEMP_LENGTH))
    return "-".join(body[i : i + 4] for i in range(0, _TEMP_LENGTH, 4))


def is_temporary(board: "Board") -> bool:
    """Whether the current password is one the recovery flow issued."""
    return board.password_hash is not None and board.password_expires_at is not None


def has_expired(board: "Board") -> bool:
    """Whether the password on this board has run out.

    True leaves the board *shut*, not open. `is_set` still answers True, so
    `resolve_access` still asks and nobody gets in - the only way past an expired
    temporary password is another recovery, or the owner setting a real one. An expiry
    that unlocked the board would turn a two-hour convenience into a two-hour delay
    before the lock fell off, which is the one thing this must never do.
    """
    if board.password_hash is None or board.password_expires_at is None:
        return False
    return board.password_expires_at <= datetime.now(UTC)


def clear(board: "Board") -> None:
    """Take the password off. Also a version bump, for the same reason."""
    board.password_hash = None
    board.password_set_at = None
    board.password_expires_at = None
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
    if has_expired(board):
        # Checked before the hash rather than after, so an expired temporary password
        # is refused whether or not it was the right one. "Correct but expired" and
        # "wrong" are the same answer to the only question this asks.
        return False
    return verify_password(board.password_hash, raw)


# --- the pass ---------------------------------------------------------------------


def _sign(payload: str) -> str:
    return hmac.new(
        settings.jwt_secret.encode(), f"{_DOMAIN}.{payload}".encode(), hashlib.sha256
    ).hexdigest()


def mint_pass(board_id: str, version: int, *, not_after: datetime | None = None) -> str:
    """A receipt for one board at one password version.

    Not consumed on use, unlike a ws-token: this one is presented at every mint for as
    long as somebody keeps the tab open, and single use would mean typing the password
    on every reconnect.

    `not_after` caps the receipt at the password's own expiry, and the caller passes the
    board's `password_expires_at`. Without it a pass minted from a temporary password
    would outlive the password by ten hours, which would quietly make "lasts two hours"
    mean two hours for anyone who had not opened it yet and half a day for everyone who
    had - the opposite of what a temporary password is for.
    """
    expires_at = int(time.time()) + settings.board_pass_ttl_seconds
    if not_after is not None:
        expires_at = min(expires_at, int(not_after.timestamp()))
    payload = f"{board_id}.{version}.{expires_at}"
    return f"{payload}.{_sign(payload)}"


def pass_lifetime(board: "Board") -> int:
    """How many seconds a pass minted for this board now is actually good for.

    The companion to `mint_pass`'s cap, and the reason it is a function rather than
    `settings.board_pass_ttl_seconds` typed into two routers: the number the client is
    told and the number baked into the token have to be the same one, or a tab keeps a
    pass it believes in past the point the server stopped accepting it.
    """
    ceiling = settings.board_pass_ttl_seconds
    if board.password_expires_at is None:
        return ceiling
    remaining = int(board.password_expires_at.timestamp() - time.time())
    return max(0, min(ceiling, remaining))


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
