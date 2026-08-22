"""Account creation, third-party identity linking, and the profile view of a user.

This module owns one rule, and it is the reason it exists rather than living in the
routers: **an account is its email address.** Signing in with GitHub or Google resolves
to the existing row with that verified email, and refuses when there is none. If a
second place ever starts deciding whether two logins are the same person, that is the
same class of bug `permissions.py` warns about for roles.

**A sign-in and a registration are different requests, even through the same provider.**
Which one a round trip was is carried as an `Intent` from the button that started it, so
the answer does not depend on guessing from the state of the database:

* registering an address that already has an account is refused - log in instead;
* signing in with an address that has none is refused - register first;
* and either door can register: the password form, GitHub, or Google.

Without the intent, "this address already exists" would have to mean sign-in on one
screen and refusal on the other, and the same callback would do different things for
reasons the user never expressed.

Nothing below knows which provider it is looking at. Every provider produces the same
`OAuthProfile`, so "same email means same person" is one code path rather than one per
provider, and a third provider adds no branches here.
"""

import re
import uuid
from datetime import UTC, datetime
from enum import Enum

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserIdentity, Workspace, WorkspaceMember
from app.schemas.auth import IdentityOut, UserOut
from app.services.oauth.base import OAuthProfile
from app.services.permissions import WorkspaceRole


class Intent(Enum):
    """What the person pressed. Carried through the OAuth round trip in the state."""

    login = "login"
    register = "register"
    # Connect, from the profile page of an account that is already signed in. Unlike the
    # other two this one names a specific account up front, and may only ever touch it.
    link = "link"


class EmailMismatch(Exception):
    """The provider account's address is not the one on the account being connected.

    Its own outcome rather than a sign-in, because the person asked to connect *this*
    account to a provider, and the provider answered with someone else's address. Before
    this existed the flow fell through to the email match and signed them into the other
    account, which is a surprising place to end up from a button labelled Connect.
    """


class AlreadyRegistered(Exception):
    """Registration attempted for an address that already has an account.

    Named rather than silently signing them in: someone on the register form has said
    they think they are new here, and quietly logging them into an existing account
    answers a question they did not ask.
    """


class UnregisteredEmail(Exception):
    """The provider's verified email belongs to no account here.

    Not an error in the provider's half of the flow: everything about the sign-in
    worked, and the answer is that this address has never registered. The caller turns
    it into "register first", and that message is safe to be specific about because
    reaching it means completing a sign-in at the provider, which is proof of control
    over the address it names.
    """


class IdentityConflict(Exception):
    """The third-party account and the Meadow account cannot be paired.

    Raised when the email match lands on an account already linked to a *different*
    account at the same provider. Silently re-pointing the identity would let whoever
    controls one GitHub or Google account displace another from a shared Meadow
    account.
    """


def _slugify(name: str, suffix: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-") or "workspace"
    return f"{base[:40]}-{suffix}"


async def create_personal_workspace(session: AsyncSession, user: User) -> Workspace:
    """The workspace a new account starts with, whichever door they came in through.

    Boards always live in a workspace - that is where the shared permission grant
    lives - so without this a brand new user cannot create anything.
    """
    workspace = Workspace(
        name=f"{user.display_name}'s workspace",
        slug=_slugify(user.display_name, uuid.uuid4().hex[:8]),
        owner_id=user.id,
    )
    session.add(workspace)
    await session.flush()
    session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.owner)
    )
    return workspace


async def default_workspace_id(session: AsyncSession, user_id: uuid.UUID) -> uuid.UUID | None:
    return (
        await session.execute(
            select(Workspace.id)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
            .where(WorkspaceMember.user_id == user_id)
            .order_by(Workspace.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()


async def identity_for(
    session: AsyncSession, user_id: uuid.UUID, provider: str
) -> UserIdentity | None:
    return (
        await session.execute(
            select(UserIdentity).where(
                UserIdentity.user_id == user_id, UserIdentity.provider == provider
            )
        )
    ).scalar_one_or_none()


async def identities_of(session: AsyncSession, user_id: uuid.UUID) -> dict[str, UserIdentity]:
    """Every linked identity, keyed by provider. One query, not one per provider."""
    rows = (
        await session.execute(select(UserIdentity).where(UserIdentity.user_id == user_id))
    ).scalars()
    return {row.provider: row for row in rows}


async def build_user_out(
    session: AsyncSession, user: User, *, workspace_id: uuid.UUID | None = None
) -> UserOut:
    """The single shape every endpoint returns a user in.

    One builder rather than five constructor calls: `avatar_url` was already missing
    from the registration response before this existed, and every field added since
    would have been another chance to forget one of them.
    """
    linked = await identities_of(session, user.id)
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        avatar_source=user.avatar_source,
        has_password=user.password_hash is not None,
        identities={provider: _identity_out(row) for provider, row in linked.items()},
        default_workspace_id=(
            workspace_id
            if workspace_id is not None
            else await default_workspace_id(session, user.id)
        ),
    )


def _identity_out(identity: UserIdentity) -> IdentityOut:
    return IdentityOut(
        provider=identity.provider,
        username=identity.username,
        name=identity.provider_name,
        email=identity.provider_email,
        avatar_url=identity.avatar_url,
        profile_url=identity.profile_url,
        linked_at=identity.created_at,
    )


def _apply_profile_snapshot(identity: UserIdentity, profile: OAuthProfile) -> None:
    """Refresh the provider's half of the record. Never touches the user's own fields."""
    identity.username = profile.username
    identity.provider_name = profile.name
    identity.provider_email = profile.email
    identity.avatar_url = profile.avatar_url
    identity.profile_url = profile.profile_url
    identity.last_login_at = datetime.now(UTC)


def _follow_avatar(user: User, profile: OAuthProfile) -> None:
    """Keep the chosen provider's avatar current, and leave any other choice alone.

    `avatar_source` names the provider the picture came from, so a user showing their
    Google picture does not have it replaced by signing in with GitHub, and one who
    turned the picture off in the profile page keeps initials. Either way they said so
    already, and overriding it on the next sign-in would read as the setting not
    working.
    """
    if user.avatar_source == profile.provider:
        user.avatar_url = profile.avatar_url


async def link_oauth_profile(
    session: AsyncSession, profile: OAuthProfile, *, intent: Intent
) -> tuple[User, bool]:
    """Resolve a third-party profile to an account. Returns `(user, created)`.

    Four cases, in this order, and the same four whichever provider the profile came
    from:

    1. That provider account is already linked - sign that user in, or refuse if they
       asked to register. The link is keyed on the provider's own id (GitHub's numeric
       id, Google's `sub`), so a rename or an email change over there is just a
       refreshed row here.
    2. Its verified email matches an existing account - link the two and sign in, or
       refuse if they asked to register. This is the "same email means same person"
       rule, and it is only safe because the provider module has already established
       the email is verified. An unverified email is a claim, and anyone can claim one.
    3. No account, and they asked to register - create it, unactivated, with its
       personal workspace and the link. The caller sends the activation mail.
    4. No account, and they asked to log in - `UnregisteredEmail`.

    Case 2 is what makes the providers add up rather than multiply: signing in with
    Google on an account that already has a password and a GitHub link lands on that
    same account and adds a second identity to it.
    """
    identity = (
        await session.execute(
            select(UserIdentity).where(
                UserIdentity.provider == profile.provider,
                UserIdentity.provider_user_id == profile.provider_user_id,
            )
        )
    ).scalar_one_or_none()

    if identity is not None:
        user = await session.get(User, identity.user_id)
        if user is None:  # pragma: no cover - the FK cascades, so this cannot happen
            raise IdentityConflict("identity points at a deleted account")
        if intent is Intent.register:
            raise AlreadyRegistered(profile.email)
        _apply_profile_snapshot(identity, profile)
        _follow_avatar(user, profile)
        await session.commit()
        return user, False

    existing = (
        await session.execute(select(User).where(User.email == profile.email))
    ).scalar_one_or_none()

    if existing is None:
        if intent is Intent.login:
            raise UnregisteredEmail(profile.email)
        return await _register_with_provider(session, profile)

    if intent is Intent.register:
        raise AlreadyRegistered(profile.email)

    # Only a clash at the *same* provider is a conflict. Holding a GitHub link says
    # nothing about whether this Google account may be added, and refusing that would
    # be refusing the whole point of case 2.
    if await identity_for(session, existing.id, profile.provider) is not None:
        raise IdentityConflict(f"account already linked to a different {profile.provider} account")

    identity = UserIdentity(
        user_id=existing.id,
        provider=profile.provider,
        provider_user_id=profile.provider_user_id,
    )
    _apply_profile_snapshot(identity, profile)
    session.add(identity)
    # An account that already exists keeps its own name and avatar. Linking a provider
    # is not a request to be renamed by it.
    _follow_avatar(existing, profile)
    try:
        await session.commit()
    except IntegrityError as exc:
        # Two callbacks for the same account and provider, racing. Whoever lost re-reads
        # the winner's row rather than failing a sign-in that is entirely legitimate.
        await session.rollback()
        return await _resolve_after_race(session, profile, exc), False
    return existing, False


async def link_to_user(
    session: AsyncSession, profile: OAuthProfile, user: User
) -> User:
    """Attach a provider account to one specific existing account, or refuse.

    The account is named by the session that started the flow, not found from the
    profile, so the only question here is whether the two are the same person. The
    address is the answer: it is what every other match in this file is made on, and
    accepting a different one would let a provider account be bound to an account it has
    never proved any relationship to.
    """
    if profile.email != user.email:
        raise EmailMismatch(profile.email)

    existing = await identity_for(session, user.id, profile.provider)
    if existing is not None:
        if existing.provider_user_id == profile.provider_user_id:
            # Connecting something already connected. Refresh it and call it done.
            _apply_profile_snapshot(existing, profile)
            _follow_avatar(user, profile)
            await session.commit()
            return user
        raise IdentityConflict(f"account already linked to a different {profile.provider} account")

    identity = UserIdentity(
        user_id=user.id, provider=profile.provider, provider_user_id=profile.provider_user_id
    )
    _apply_profile_snapshot(identity, profile)
    session.add(identity)
    _follow_avatar(user, profile)
    try:
        await session.commit()
    except IntegrityError as exc:
        # The unique constraint on (provider, provider_user_id): that provider account
        # is already signing somebody else in.
        await session.rollback()
        raise IdentityConflict("that account is linked elsewhere") from exc
    return user


async def _register_with_provider(
    session: AsyncSession, profile: OAuthProfile
) -> tuple[User, bool]:
    """A new account opened through GitHub or Google.

    Unactivated, like every other registration: the provider verified the address for
    its own purposes, and this app confirms it for its own. The name and picture are
    seeded from the provider and are the user's from that moment, never overwritten by a
    later sign-in.
    """
    user = User(
        email=profile.email,
        # No password, rather than an unguessable placeholder: a hash nobody holds the
        # input to is a credential that cannot be revoked or reasoned about. They can
        # sign in with the provider, and the profile page says so.
        password_hash=None,
        display_name=profile.name or profile.username,
        avatar_url=profile.avatar_url,
        # Named after the provider, so the picture keeps following that account and the
        # profile page can say which one it is showing.
        avatar_source=profile.provider,
    )
    session.add(user)
    try:
        await session.flush()
    except IntegrityError as exc:
        # Two callbacks for the same new address, racing. The loser is a registration
        # for an address that now exists, which is exactly what case 2 refuses.
        await session.rollback()
        raise AlreadyRegistered(profile.email) from exc

    await create_personal_workspace(session, user)
    identity = UserIdentity(
        user_id=user.id, provider=profile.provider, provider_user_id=profile.provider_user_id
    )
    _apply_profile_snapshot(identity, profile)
    session.add(identity)
    await session.flush()
    return user, True


async def _resolve_after_race(
    session: AsyncSession, profile: OAuthProfile, cause: IntegrityError
) -> User:
    existing = (
        await session.execute(select(User).where(User.email == profile.email))
    ).scalar_one_or_none()
    if existing is None:
        raise UnregisteredEmail(profile.email) from cause
    identity = await identity_for(session, existing.id, profile.provider)
    if identity is None:
        raise IdentityConflict("the link vanished between two attempts") from cause
    _apply_profile_snapshot(identity, profile)
    _follow_avatar(existing, profile)
    await session.commit()
    return existing
