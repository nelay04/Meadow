"""Account creation, third-party identity linking, and the profile view of a user.

This module owns one rule, and it is the reason it exists rather than living in the
routers: **an account is its email address.** Signing in with GitHub or Google resolves
to the existing row with that verified email, and only creates a new account when there
is none. If a second place ever starts deciding whether two logins are the same person,
that is the same class of bug `permissions.py` warns about for roles.

Nothing below knows which provider it is looking at. Every provider produces the same
`OAuthProfile`, so "same email means same person" is one code path rather than one per
provider, and a third provider adds no branches here.
"""

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserIdentity, Workspace, WorkspaceMember
from app.schemas.auth import IdentityOut, UserOut
from app.services.oauth.base import OAuthProfile
from app.services.permissions import WorkspaceRole


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


async def link_oauth_profile(session: AsyncSession, profile: OAuthProfile) -> tuple[User, bool]:
    """Resolve a third-party profile to an account, creating one if this is a new person.

    Returns `(user, created)`. Three cases, in this order, and the same three whichever
    provider the profile came from:

    1. That provider account is already linked - sign that user in. The link is keyed on
       the provider's own id (GitHub's numeric id, Google's `sub`), so a rename or an
       email change over there is just a refreshed row here.
    2. Its verified email matches an existing account - link the two. This is the
       "same email means same person" rule, and it is only safe because the provider
       module has already established the email is verified. An unverified email is a
       claim, and anyone can claim one.
    3. Neither - create the account, its personal workspace, and the link.

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
        _apply_profile_snapshot(identity, profile)
        _follow_avatar(user, profile)
        await session.commit()
        return user, False

    existing = (
        await session.execute(select(User).where(User.email == profile.email))
    ).scalar_one_or_none()

    if existing is not None:
        # Only a clash at the *same* provider is a conflict. Holding a GitHub link says
        # nothing about whether this Google account may be added, and refusing that
        # would be refusing the whole point of case 2.
        if await identity_for(session, existing.id, profile.provider) is not None:
            raise IdentityConflict(
                f"account already linked to a different {profile.provider} account"
            )
        identity = UserIdentity(
            user_id=existing.id,
            provider=profile.provider,
            provider_user_id=profile.provider_user_id,
        )
        _apply_profile_snapshot(identity, profile)
        session.add(identity)
        # An account that already exists keeps its own name and avatar. Linking a
        # provider is not a request to be renamed by it.
        _follow_avatar(existing, profile)
        await session.commit()
        return existing, False

    user = User(
        email=profile.email,
        # No password, rather than an unguessable placeholder: a hash nobody holds the
        # input to is a credential that cannot be revoked or reasoned about.
        password_hash=None,
        # The provider's display name when they have set one, their username when they
        # have not. Theirs to change afterwards, and never overwritten again.
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
        # Two callbacks for the same new person, racing. Whoever lost re-reads the
        # winner's row rather than failing a sign-in that is entirely legitimate.
        await session.rollback()
        return await _resolve_after_race(session, profile, exc)

    await create_personal_workspace(session, user)
    identity = UserIdentity(
        user_id=user.id, provider=profile.provider, provider_user_id=profile.provider_user_id
    )
    _apply_profile_snapshot(identity, profile)
    session.add(identity)
    await session.commit()
    return user, True


async def _resolve_after_race(
    session: AsyncSession, profile: OAuthProfile, cause: IntegrityError
) -> tuple[User, bool]:
    existing = (
        await session.execute(select(User).where(User.email == profile.email))
    ).scalar_one_or_none()
    if existing is None:
        raise IdentityConflict("could not create account") from cause
    identity = await identity_for(session, existing.id, profile.provider)
    if identity is None:
        raise IdentityConflict("account created concurrently without the link") from cause
    _apply_profile_snapshot(identity, profile)
    _follow_avatar(existing, profile)
    await session.commit()
    return existing, False
