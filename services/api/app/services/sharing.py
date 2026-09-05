"""Who a board is open to, and how somebody without a grant gets one.

Three mechanisms, and they are deliberately not the same mechanism.

**The link.** `boards.share_mode` is `restricted` or `public`. Restricted is what a
board has always been: the URL is just an address, and opening it needs a workspace
seat or a `board_members` row. Public means the row in `share_links` is a *capability*
- anyone holding it gets `boards.share_role` on the board, with no account and no
sign-in - which is what a link posted into a chat or a timeline has to mean to be worth
posting. Nothing is shared publicly by default, and turning it on is the one action in
this file that changes who can read a board without naming anybody.

**The invitation to a person who has an account.** Straight to `board_members`, and a
mail goes out saying so. There is nothing to accept: the owner had the authority to
grant it, the address is already proved (the account could not have been opened
otherwise), and a board that appeared in your list after you were told about it is less
surprising than one hidden behind a second click.

**The invitation to an address with no account.** This is the case that cannot be
mailed, and the restraint is the feature. Sending mail to an arbitrary unverified
address that a stranger typed in is an open relay for spam wearing our from-address,
and it is how invitation systems get their domain blocklisted. So nothing is sent: the
row is written, and the owner is handed a link to pass on personally through whatever
channel they already reach that person on. The link lands on registration, and the
grant is applied the moment the account opens - see `apply_pending`, called from
activation - so accepting is not a step the person has to remember to take.

The tokens here are stored raw, unlike `email_verifications`. See 0008_sharing: a link
the owner copies out of a dialog more than once cannot be a digest, because the server
has to be able to produce it. What replaces "unguessable and unreadable at rest" is
"narrow and revocable": 192 bits of randomness, one live link per board, rotation as a
single button, and a mode that has to be switched on before the link means anything at
all.
"""

import secrets
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from enum import StrEnum
from typing import TYPE_CHECKING

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.services import mail
from app.services.board_kinds import BoardKind
from app.services.board_kinds import noun as kind_noun
from app.services.mail_templates import board_invite_mail, board_role_changed_mail
from app.services.permissions import BoardRole, rank

if TYPE_CHECKING:
    # `app.models` imports this module for the share-mode constants, so the models can
    # only be named here, not imported. Every use below is inside a function and does
    # its own local import at runtime.
    from app.models import Board, BoardInvitation, ShareLink, User


class ShareMode(StrEnum):
    #: Reachable only through a workspace seat or an explicit board grant.
    restricted = "restricted"
    #: The live share link opens it for anybody, signed in or not.
    public = "public"


#: Rendered into the check constraint in 0008. Keep in step with the enum.
SHARE_MODES = tuple(mode.value for mode in ShareMode)

DEFAULT_SHARE_MODE = ShareMode.restricted

#: The only roles a link or an invitation may hand out.
#:
#: `owner` is missing on purpose: it carries deletion and membership changes, and a
#: URL that can be forwarded must never carry those. `commenter` is missing because it
#: is inert in v1 and offering a choice that behaves exactly like `viewer` is offering
#: a decision with no consequence.
SHAREABLE_ROLES: tuple[BoardRole, ...] = (BoardRole.editor, BoardRole.viewer)

#: 24 bytes, so ~32 urlsafe characters. Long enough that guessing is not a strategy,
#: short enough that the whole link still fits in a message without being wrapped.
_TOKEN_BYTES = 24


def new_token() -> str:
    return secrets.token_urlsafe(_TOKEN_BYTES)


def _base() -> str:
    return settings.web_base_url.rstrip("/")


def board_url(board_id: uuid.UUID, kind: str, *, link_token: str | None = None) -> str:
    """Where a board lives, as something a person can paste somewhere.

    The kind is the path segment because the address bar is the one part of this app
    people read and forward, and `#/glade/...` for a diary is simply wrong. It is not
    load-bearing - the client corrects the hash once the server tells it the real kind
    - so this staying in step with `features/boards/kinds.ts` is a nicety, not a
    correctness requirement.

    The link token rides in the query string rather than the fragment, unlike a
    password reset link. A reset token hides in the fragment because it is a key to an
    account and must not reach a server log; this one is a key to one board that has
    been deliberately made public, and it has to survive being pasted into places that
    normalise a URL. The fragment is also where the route lives, and burying a
    capability inside a route is how it ends up truncated by the next thing that
    touches it.
    """
    segment = kind if kind in tuple(k.value for k in BoardKind) else BoardKind.glade.value
    suffix = "" if link_token is None else f"?k={link_token}"
    return f"{_base()}/{suffix}#/{segment}/{board_id}"


def invite_url(token: str) -> str:
    """Where an invitation for an address with no account points.

    The app, not the API: this link ends at a registration form, and only the browser
    can fill one in. The token is in the fragment because the page reads it directly
    and nothing needs to be posted anywhere to display it.
    """
    return f"{_base()}/#/join/{token}"


# --- the public link -------------------------------------------------------------


async def active_link(session: AsyncSession, board_id: uuid.UUID) -> "ShareLink | None":
    """The board's live share link row, or None if it has never been shared."""
    from app.models import ShareLink

    return (
        await session.execute(
            select(ShareLink).where(
                ShareLink.board_id == board_id, ShareLink.revoked_at.is_(None)
            )
        )
    ).scalar_one_or_none()


async def ensure_link(
    session: AsyncSession, board_id: uuid.UUID, created_by: uuid.UUID
) -> "ShareLink":
    """The live link, minting one the first time a board is shared.

    Lazy rather than created with the board: a token that exists for every board ever
    made is a larger surface than one that exists for the boards somebody chose to
    share, and most boards are never shared.
    """
    from app.models import ShareLink

    existing = await active_link(session, board_id)
    if existing is not None:
        return existing

    link = ShareLink(board_id=board_id, token=new_token(), created_by=created_by)
    session.add(link)
    await session.flush()
    return link


async def rotate_link(
    session: AsyncSession, board_id: uuid.UUID, created_by: uuid.UUID
) -> "ShareLink":
    """Retire the current link and mint a new one.

    This is the undo for "that went somewhere I did not mean it to go". The old row is
    revoked rather than deleted so a link that has stopped working can be recognised as
    one that used to work - which is a different thing to tell somebody than "that was
    never a link".
    """
    from app.models import ShareLink

    await session.execute(
        update(ShareLink)
        .where(ShareLink.board_id == board_id, ShareLink.revoked_at.is_(None))
        .values(revoked_at=datetime.now(UTC))
    )
    link = ShareLink(board_id=board_id, token=new_token(), created_by=created_by)
    session.add(link)
    await session.flush()
    return link


async def resolve_link(
    session: AsyncSession, token: str
) -> tuple["Board", BoardRole] | None:
    """What a share token opens, and at what role. None if it opens nothing.

    The mode is checked here and not by the caller. A token stays valid across a board
    being switched back to restricted and public again - that is what makes "share,
    unshare, share again" not invalidate the link somebody already has - so *the mode
    is the switch*, and any path that resolved a token without consulting it would keep
    a board readable after its owner had closed it.

    A board in the trash opens for nobody, and that is checked here for exactly the same
    reason. This is the one way into a board that does not go through `resolve_role`:
    it answers a caller who may have no account at all, so there is no role to resolve.
    Every other route inherits the rule from that function; this one has to state it,
    and it states it once, at the bottom, rather than in each of the routes above.
    """
    from app.models import Board, ShareLink

    row = (
        await session.execute(
            select(Board, ShareLink)
            .join(ShareLink, ShareLink.board_id == Board.id)
            .where(ShareLink.token == token, ShareLink.revoked_at.is_(None))
        )
    ).first()
    if row is None:
        return None

    board, _link = row
    if board.share_mode != ShareMode.public:
        return None
    # Suspended along with everything else about the board, and given back by a
    # restore. Not revoked: a link somebody was only ever going to lose for a week
    # should be the same link when the board comes back.
    if board.deleted_at is not None:
        return None
    return board, BoardRole(board.share_role)


# --- invitations -----------------------------------------------------------------


@dataclass(frozen=True)
class InviteResult:
    """What happened when an owner typed an address into the share dialog.

    `status` is what the dialog says out loud, and the three values are three genuinely
    different outcomes rather than three shades of success:

    - `granted`: there is an account at that address. It now has the role, and it has
      been told so by mail.
    - `pending`: there is no account. Nothing was sent. `link` is the invitation the
      owner passes on themselves, and it is the only copy - see the module docstring
      for why this path does not touch the mail relay.
    - `member`: they already had this exact role. Nothing changed and nothing was sent,
      because a mail announcing an unchanged fact is noise.
    """

    status: str
    role: BoardRole
    email: str
    user_id: uuid.UUID | None = None
    display_name: str | None = None
    link: str | None = None
    #: False when the grant landed but the relay would not take the notice. The dialog
    #: says so rather than claiming a mail that was not sent.
    mailed: bool = True


async def pending_invitation(
    session: AsyncSession, board_id: uuid.UUID, email: str
) -> "BoardInvitation | None":
    """The outstanding invitation for this address on this board, if there is one."""
    from app.models import BoardInvitation

    return (
        await session.execute(
            select(BoardInvitation).where(
                BoardInvitation.board_id == board_id,
                BoardInvitation.email == email,
                BoardInvitation.accepted_at.is_(None),
                BoardInvitation.revoked_at.is_(None),
            )
        )
    ).scalar_one_or_none()


async def upsert_invitation(
    session: AsyncSession,
    *,
    board_id: uuid.UUID,
    email: str,
    role: BoardRole,
    invited_by: uuid.UUID,
) -> "BoardInvitation":
    """Record that this address is expected, at this role.

    Inviting the same address twice changes the role on the invitation already out
    there rather than issuing a second one: two live links promising different things
    is a question nobody can answer from the inbox they arrived in.
    """
    from app.models import BoardInvitation

    existing = await pending_invitation(session, board_id, email)
    if existing is not None:
        existing.role = role
        await session.flush()
        return existing

    invitation = BoardInvitation(
        board_id=board_id,
        email=email,
        role=role,
        token=new_token(),
        invited_by=invited_by,
    )
    session.add(invitation)
    await session.flush()
    return invitation


async def apply_pending(session: AsyncSession, user: "User") -> int:
    """Turn every invitation waiting on this address into a grant. Returns how many.

    Called when an account opens - that is, from activation, and from the OAuth path
    that opens one - and not when a link is followed. An invitation is a promise made
    to an *address*, and the address is proved by the account existing at all, so
    making the person also find and click the original link would be asking them to
    prove it twice.

    Never lowers an existing role. Somebody invited as a viewer to a board they already
    edit through their workspace keeps the edit: the invitation was an offer of access,
    and access they already have is not withdrawn by accepting it.
    """
    from app.models import BoardInvitation, BoardMember

    invitations = list(
        (
            await session.execute(
                select(BoardInvitation).where(
                    BoardInvitation.email == user.email,
                    BoardInvitation.accepted_at.is_(None),
                    BoardInvitation.revoked_at.is_(None),
                )
            )
        ).scalars()
    )

    applied = 0
    now = datetime.now(UTC)
    for invitation in invitations:
        existing = await session.get(BoardMember, (invitation.board_id, user.id))
        if existing is None:
            session.add(
                BoardMember(
                    board_id=invitation.board_id, user_id=user.id, role=invitation.role
                )
            )
        elif rank(invitation.role) > rank(existing.role):
            existing.role = invitation.role
        invitation.accepted_at = now
        applied += 1

    return applied


async def invitation_by_token(session: AsyncSession, token: str) -> "BoardInvitation | None":
    """The invitation a `#/join/...` link names, live or spent."""
    from app.models import BoardInvitation

    return (
        await session.execute(
            select(BoardInvitation).where(BoardInvitation.token == token)
        )
    ).scalar_one_or_none()


# --- the two things an owner does that another person hears about ------------------


async def invite(
    session: AsyncSession,
    *,
    board: "Board",
    email: str,
    role: BoardRole,
    inviter: "User",
) -> InviteResult:
    """Give an address access to a board, by whichever of the two routes applies.

    The branch is on whether an account exists, and it is the whole of this feature's
    honesty about email. An address with an account is a person this deployment has
    already sent mail to and had answered, so granting and telling them is safe. An
    address without one is a string somebody typed, and mailing it would be sending
    unsolicited mail to a stranger on a stranger's say-so. So that path writes a row
    and hands the link back to the person doing the inviting, who knows how to reach
    the human they have in mind.

    Never lowers an existing membership, for the same reason `apply_pending` does not:
    inviting somebody is offering access, and an offer does not take anything away. An
    owner who genuinely wants to demote uses the member list, where it is what the
    control says it does.
    """
    from app.models import BoardMember, User

    target = (
        await session.execute(select(User).where(User.email == email))
    ).scalar_one_or_none()

    if target is None:
        invitation = await upsert_invitation(
            session, board_id=board.id, email=email, role=role, invited_by=inviter.id
        )
        return InviteResult(
            status="pending", role=role, email=email, link=invite_url(invitation.token)
        )

    existing = await session.get(BoardMember, (board.id, target.id))
    if existing is not None and existing.role == role:
        return InviteResult(
            status="member",
            role=role,
            email=target.email,
            user_id=target.id,
            display_name=target.display_name,
        )

    if existing is None:
        session.add(BoardMember(board_id=board.id, user_id=target.id, role=role))
    elif rank(role) > rank(existing.role):
        existing.role = role
    await session.flush()

    mailed = await try_send(
        target.email,
        board_invite_mail(
            name=target.display_name,
            inviter=inviter.display_name,
            title=board.title,
            noun=kind_noun(board.kind),
            role=str(role),
            link=board_url(board.id, board.kind),
        ),
    )

    return InviteResult(
        status="granted",
        role=role,
        email=target.email,
        user_id=target.id,
        display_name=target.display_name,
        mailed=mailed,
    )


async def notify_role_change(
    *, board: "Board", member: "User", role: BoardRole, actor: "User"
) -> bool:
    """Tell somebody their access to a board changed. True if the mail went out.

    Sent on a demotion as loudly as on a promotion, and the demotion is the one that
    earns it: discovering you can no longer type into something by trying to type into
    it, halfway through a thought, is the version of this that costs somebody an hour.

    The caller decides whether anything actually changed. It is the only party that
    knows what the role was before, and a mail announcing an unchanged fact is noise
    that teaches people to ignore the ones that matter.
    """
    return await try_send(
        member.email,
        board_role_changed_mail(
            name=member.display_name,
            actor=actor.display_name,
            title=board.title,
            noun=kind_noun(board.kind),
            role=str(role),
            link=board_url(board.id, board.kind),
        ),
    )


async def try_send(to: str, message: tuple[str, str, str]) -> bool:
    """Send, and report whether it went, rather than raising.

    Public because `app/services/access_requests.py` sends its notice the same way and
    for the same reason. Two copies of "swallow the relay being down" would be two
    chances to get the swallowing wrong.

    Deliberately different from activation, where a failed mail fails the request: an
    account nobody can open is worse than a refused registration, so there the failure
    is the answer. Here the grant is already real and already useful - the board is in
    their list either way - so a relay that is down must not undo it. The caller passes
    the outcome to the dialog, which says "shared, but the notice could not be sent"
    instead of claiming a mail that never left.
    """
    subject, text, html = message
    try:
        await mail.send(to=to, subject=subject, text=text, html=html)
    except mail.MailError:
        return False
    return True
