"""Asking to be let in to a board you only have the address of.

Sharing, until now, was something an owner did *to* somebody: a link made public, or an
invitation aimed at an address. A restricted board handed everybody else the same
answer, which was nothing at all. Somebody following a link they were sent in good
faith got a refusal with no next step in it, and the owner's only ways to help were to
make the whole board public or to be asked about it somewhere that is not this app.

So this is the other direction, and it is deliberately not a second way in. A request
grants nothing. It records that a named account, signed in and therefore with a proved
address, asked for `viewer` or `editor` on one board. The only thing that ever grants
access is a `board_members` row, written when the owner says so, and resolved
afterwards through `app/services/permissions.py` exactly like every other grant.

Two rules the shape of the table comes from:

- **One row per person per board.** Asking again is the same request repeated, not a
  new case. A row per attempt would let one anxious person fill an owner's dialog.
- **A decision is never a dead end.** A declined request can be made again, because the
  reason it was declined is usually "I do not know who this is" and the answer to that
  arrives out of band, in a conversation this app cannot see.

What is *not* here, on purpose: a way to ask anonymously. The whole value of the
request to the person deciding it is a name and an address they can recognise, and a
form that let an anonymous visitor send one would be an unauthenticated write endpoint
that mails a stranger on a stranger's say-so - the same thing the invitation flow
refuses to do for exactly the same reason.
"""

import uuid
from datetime import UTC, datetime
from typing import TYPE_CHECKING

from sqlalchemy import and_, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.services.board_kinds import noun as kind_noun
from app.services.mail_templates import board_access_request_mail
from app.services.permissions import BoardRole, WorkspaceRole
from app.services.sharing import board_url, try_send

if TYPE_CHECKING:
    from app.models import Board, BoardAccessRequest, User

#: What a person may ask for. The same pair a share link may grant, and for the same
#: reason: `owner` carries deletion and membership, and nothing that can be *asked* for
#: may carry those.
ASKABLE_ROLES = frozenset({BoardRole.viewer, BoardRole.editor})

#: Statuses a row can hold. Mirrored by a check constraint in 0009.
PENDING = "pending"
GRANTED = "granted"
DECLINED = "declined"

#: How many owners one request will mail. A board with a large workspace behind it
#: would otherwise turn one click into a broadcast; the dialog shows every request to
#: every owner regardless, so the mail is a nudge and not the record.
_MAX_NOTIFIED = 5


async def ask(
    session: AsyncSession, *, board_id: uuid.UUID, user_id: uuid.UUID, role: BoardRole
) -> tuple["BoardAccessRequest", bool]:
    """Record a request. Returns it, and whether the owners should be told.

    Rewriting rather than inserting is what makes "ask again" mean asking again. It
    also means a person who asked to view and then decided they need to edit is one
    request that changed its mind, which is what the owner wants to see.

    The second half of the answer is about somebody else's inbox. A request that was
    already pending is already in front of the owner, so pressing the button again
    must not mail them again - otherwise the one endpoint a signed-in stranger can
    reach is also a way to send them a message per click.
    """
    from app.models import BoardAccessRequest

    existing = (
        await session.execute(
            select(BoardAccessRequest).where(
                BoardAccessRequest.board_id == board_id,
                BoardAccessRequest.user_id == user_id,
            )
        )
    ).scalar_one_or_none()

    if existing is None:
        request = BoardAccessRequest(
            board_id=board_id, user_id=user_id, role=role, status=PENDING
        )
        session.add(request)
        return request, True

    # A pending request that changes what it asks for is still worth a notice: the
    # owner may have been about to grant view to somebody who now needs to edit.
    notify = existing.status != PENDING or existing.role != role

    existing.role = role
    existing.status = PENDING
    existing.decided_at = None
    existing.decided_by = None
    existing.created_at = datetime.now(UTC)
    return existing, notify


async def mine(
    session: AsyncSession, *, board_id: uuid.UUID, user_id: uuid.UUID
) -> "BoardAccessRequest | None":
    """This person's request on this board, whatever became of it."""
    from app.models import BoardAccessRequest

    return (
        await session.execute(
            select(BoardAccessRequest).where(
                BoardAccessRequest.board_id == board_id,
                BoardAccessRequest.user_id == user_id,
            )
        )
    ).scalar_one_or_none()


async def waiting(
    session: AsyncSession, board_id: uuid.UUID
) -> list[tuple["BoardAccessRequest", "User"]]:
    """Pending requests on a board, oldest first, each with who made it.

    Oldest first because the list is a queue: somebody who has been waiting since
    yesterday should not be pushed down the dialog by somebody who asked a minute ago.
    """
    from app.models import BoardAccessRequest, User

    rows = await session.execute(
        select(BoardAccessRequest, User)
        .join(User, User.id == BoardAccessRequest.user_id)
        .where(
            BoardAccessRequest.board_id == board_id,
            BoardAccessRequest.status == PENDING,
        )
        .order_by(BoardAccessRequest.created_at)
    )
    return [(request, user) for request, user in rows.all()]


async def count_waiting(session: AsyncSession, board_id: uuid.UUID) -> int:
    """How many people are waiting, for the badge on the share button."""
    from app.models import BoardAccessRequest

    rows = await session.execute(
        select(BoardAccessRequest.id).where(
            BoardAccessRequest.board_id == board_id,
            BoardAccessRequest.status == PENDING,
        )
    )
    return len(rows.all())


async def owners(session: AsyncSession, board: "Board") -> list["User"]:
    """Everybody who could decide a request on this board.

    The same two sources `resolve_role` reads, asked in the other direction: an
    explicit `board_members` row at owner, and a workspace seat that maps to owner.
    Deliberately derived rather than "whoever created it" - a board whose creator has
    left the workspace would otherwise have requests going nowhere.
    """
    from app.models import BoardMember, User, WorkspaceMember

    rows = await session.execute(
        select(User)
        .distinct()
        .outerjoin(BoardMember, BoardMember.user_id == User.id)
        .outerjoin(WorkspaceMember, WorkspaceMember.user_id == User.id)
        .where(
            or_(
                and_(
                    BoardMember.board_id == board.id,
                    BoardMember.role == BoardRole.owner,
                ),
                and_(
                    WorkspaceMember.workspace_id == board.workspace_id,
                    WorkspaceMember.role.in_([WorkspaceRole.owner, WorkspaceRole.admin]),
                ),
            )
        )
    )
    return list(rows.scalars().all())


async def notify_owners(
    session: AsyncSession, *, board: "Board", asker: "User", role: BoardRole
) -> int:
    """Mail the owners that somebody is waiting. Returns how many were reached.

    Best effort, like every other notice in `sharing`: the request is already recorded
    and already visible in the share dialog, so a relay that is down must not turn a
    successful ask into a failed one.
    """
    recipients = (await owners(session, board))[:_MAX_NOTIFIED]
    sent = 0
    for recipient in recipients:
        if recipient.id == asker.id:
            # An owner asking for access to their own board is not a case worth
            # mailing anybody about, least of all themselves.
            continue
        delivered = await try_send(
            recipient.email,
            board_access_request_mail(
                name=recipient.display_name,
                asker=asker.display_name,
                asker_email=asker.email,
                title=board.title,
                noun=kind_noun(board.kind),
                role=str(role),
                link=board_url(board.id, board.kind),
            ),
        )
        sent += int(delivered)
    return sent
