"""Forgetting a board's password, and the two hours that gets you back.

`app/services/board_password.py` says an owner cannot be locked out of their own board,
because setting and clearing the password are owner-only routes that never ask for the
current one. That is true of the routes and was false of the app: both of those controls
live in the board's own menu, and the password is what stands in front of the board. The
hatch was on the far side of the door.

The shape here is the account password reset, one board down and shorter:

- **A code, not a link.** The account flow mails a 256-bit token in a URL because the
  click lands on a page that can take a new password. This one has to land back on the
  password screen the owner is already looking at, in the tab that already has their
  session, so what travels is six digits they type into it. Six digits is only enough
  because of `attempts` and the rate limit in front of the route - a code with neither
  would be a million guesses away from a board.
- **What redeeming buys is a new password, not the old one.** Nobody has the old one; it
  is argon2id. So the code is spent for a freshly generated password with two hours on
  it, mailed to the same address and returned once in the response.
- **Two hours, and then the board is shut again.** The temporary password is for getting
  an owner back to the control that sets a real one. When it runs out the board keeps its
  lock - see `board_password.has_expired` - and the answer is another code. The one
  behaviour this must never have is a lock that falls off on a timer.

Only an owner may ask, and the code goes to the address on the asking owner's account
rather than to an address in the request. There is nothing to type in, so there is
nothing to point somewhere else: this route cannot be made to mail anybody but the
person who is already signed in as the owner of the board.
"""

import hashlib
import secrets
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from logging import getLogger

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models import Board, BoardPasswordReset, User
from app.services import board_password, mail
from app.services.mail_templates import board_password_code_mail, board_temp_password_mail

logger = getLogger(__name__)

#: Digits in the mailed code. Six, like every other code of this kind anybody has typed,
#: because familiarity is worth more here than the two bits a seventh would add - what
#: makes it safe is `MAX_ATTEMPTS` and the rate limit, not its length.
CODE_LENGTH = 6

#: Wrong guesses before the code is dead and has to be asked for again. Five, so a
#: mistyped digit is forgiven twice over and a guesser is put behind a mail round trip
#: after five - which is what turns a million-wide space into one nobody can search.
MAX_ATTEMPTS = 5


class Outcome:
    """Why redeeming a code did or did not work. Strings, because they reach the client."""

    ok = "ok"
    invalid = "invalid"
    expired = "expired"
    exhausted = "exhausted"


@dataclass(frozen=True)
class Recovered:
    """The result of spending a code: the new password and when it stops."""

    password: str
    expires_at: datetime


def _hash(code: str) -> str:
    # sha256 rather than argon2id, and the reasoning is the opposite of the one for the
    # board password itself: this value lives for ten minutes, survives five guesses, and
    # is retired by use. Nothing about hashing it slowly would help. It is hashed at all
    # so that a database read is not a live code.
    return hashlib.sha256(code.encode()).hexdigest()


def _code() -> str:
    # `randbelow` rather than shuffling digits: this must be uniform, and leading zeros
    # are as valid as any other digit, so it is formatted to a fixed width rather than
    # printed as an integer.
    return f"{secrets.randbelow(10**CODE_LENGTH):0{CODE_LENGTH}d}"


async def request(session: AsyncSession, *, board: Board, owner: User) -> None:
    """Mint a code for this owner on this board and mail it. Raises `MailError`.

    The earlier code for the same owner and board is overwritten rather than kept
    alongside, which is the `board_access_requests` rule: asking twice is one request
    made again. It also means an inbox never holds two codes that both work, which is
    how somebody ends up typing the older one and being told they are wrong.

    Mail failure is not swallowed. An owner told "check your mail" for a message that
    was never accepted has no way to tell the difference between that and a slow relay,
    and the difference is whether waiting helps.
    """
    code = _code()
    row = (
        await session.execute(
            select(BoardPasswordReset).where(
                BoardPasswordReset.board_id == board.id,
                BoardPasswordReset.user_id == owner.id,
            )
        )
    ).scalar_one_or_none()

    expires_at = datetime.now(UTC) + timedelta(minutes=settings.board_recovery_code_ttl_minutes)
    if row is None:
        session.add(
            BoardPasswordReset(
                board_id=board.id,
                user_id=owner.id,
                code_hash=_hash(code),
                expires_at=expires_at,
            )
        )
    else:
        row.code_hash = _hash(code)
        row.attempts = 0
        row.used_at = None
        row.expires_at = expires_at

    await session.flush()
    subject, text, html = board_password_code_mail(
        name=owner.display_name,
        board_title=board.title,
        code=code,
        minutes=settings.board_recovery_code_ttl_minutes,
    )
    await mail.send(to=owner.email, subject=subject, text=text, html=html)


async def redeem(
    session: AsyncSession, *, board: Board, owner: User, code: str
) -> tuple[str, Recovered | None]:
    """Spend a code. Returns an `Outcome` and, when it worked, the new password.

    The board's password is replaced here rather than by the caller, because the two
    things have to happen together: a code that is marked spent without a password being
    set would leave an owner holding nothing and needing another mail, and a password set
    without the code being spent would leave the code working a second time.

    Every wrong guess costs an attempt, and the count is written whether or not the
    transaction that follows does anything else - so the caller commits on the refusal
    path too. A counter that only persisted on success would not be a counter.
    """
    row = (
        await session.execute(
            select(BoardPasswordReset).where(
                BoardPasswordReset.board_id == board.id,
                BoardPasswordReset.user_id == owner.id,
            )
        )
    ).scalar_one_or_none()

    if row is None or row.used_at is not None:
        return Outcome.invalid, None
    if row.attempts >= MAX_ATTEMPTS:
        return Outcome.exhausted, None
    if row.expires_at <= datetime.now(UTC):
        return Outcome.expired, None

    if not secrets.compare_digest(row.code_hash, _hash(code)):
        row.attempts += 1
        # The last wrong guess reports itself as exhausted rather than as wrong, so the
        # screen can say "ask for another one" instead of inviting a sixth attempt that
        # cannot succeed.
        return (
            Outcome.exhausted if row.attempts >= MAX_ATTEMPTS else Outcome.invalid
        ), None

    row.used_at = datetime.now(UTC)
    password = board_password.generate()
    lifetime = timedelta(hours=settings.board_temp_password_ttl_hours)
    board_password.set_password(board, password, expires_in=lifetime)
    assert board.password_expires_at is not None  # set_password, given a lifetime
    return Outcome.ok, Recovered(password=password, expires_at=board.password_expires_at)


async def announce(*, owner: User, board: Board, recovered: Recovered) -> bool:
    """Mail the temporary password to the owner. Returns whether the relay took it.

    Not fatal, and this is the one place in the flow where a mail failure is not. The
    password is already set and already in the response the owner is reading; a raise
    here would report a failure for something that worked, and the retry it invited
    would spend a code that is gone. The screen says the mail did not go instead.
    """
    subject, text, html = board_temp_password_mail(
        name=owner.display_name,
        board_title=board.title,
        password=recovered.password,
        hours=settings.board_temp_password_ttl_hours,
    )
    try:
        await mail.send(to=owner.email, subject=subject, text=text, html=html)
    except mail.MailError:
        logger.warning("temporary board password set but not mailed: board=%s", board.id)
        return False
    return True
