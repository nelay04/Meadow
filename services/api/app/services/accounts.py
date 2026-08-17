"""Account creation, third-party identity linking, and the profile view of a user.

This module owns one rule, and it is the reason it exists rather than living in the
routers: **an account is its email address.** Signing in with GitHub resolves to the
existing row with that verified email, and only creates a new account when there is
none. If a second place ever starts deciding whether two logins are the same person,
that is the same class of bug `permissions.py` warns about for roles.
"""

import re
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import User, UserIdentity, Workspace, WorkspaceMember
from app.schemas.auth import GitHubIdentityOut, UserOut
from app.services.oauth.github import PROVIDER, GitHubProfile
from app.services.permissions import WorkspaceRole


class IdentityConflict(Exception):
    """The GitHub account and the Meadow account cannot be paired.

    Raised when the email match lands on an account that is already linked to a
    *different* GitHub account. Silently re-pointing the identity would let whoever
    controls one GitHub account displace another from a shared Meadow account.
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


async def github_identity(session: AsyncSession, user_id: uuid.UUID) -> UserIdentity | None:
    return (
        await session.execute(
            select(UserIdentity).where(
                UserIdentity.user_id == user_id, UserIdentity.provider == PROVIDER
            )
        )
    ).scalar_one_or_none()


async def build_user_out(
    session: AsyncSession, user: User, *, workspace_id: uuid.UUID | None = None
) -> UserOut:
    """The single shape every endpoint returns a user in.

    One builder rather than five constructor calls: `avatar_url` was already missing
    from the registration response before this existed, and every field added since
    would have been another chance to forget one of them.
    """
    identity = await github_identity(session, user.id)
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        avatar_url=user.avatar_url,
        avatar_source=user.avatar_source,
        has_password=user.password_hash is not None,
        github=(
            None
            if identity is None
            else GitHubIdentityOut(
                username=identity.username,
                name=identity.provider_name,
                email=identity.provider_email,
                avatar_url=identity.avatar_url,
                profile_url=identity.profile_url,
                linked_at=identity.created_at,
            )
        ),
        default_workspace_id=(
            workspace_id
            if workspace_id is not None
            else await default_workspace_id(session, user.id)
        ),
    )


def _apply_profile_snapshot(identity: UserIdentity, profile: GitHubProfile) -> None:
    """Refresh GitHub's half of the record. Never touches the user's own fields."""
    identity.username = profile.username
    identity.provider_name = profile.name
    identity.provider_email = profile.email
    identity.avatar_url = profile.avatar_url
    identity.profile_url = profile.profile_url
    identity.last_login_at = datetime.now(UTC)


def _follow_avatar(user: User, profile: GitHubProfile) -> None:
    """Keep a GitHub-sourced avatar current, and leave any other choice alone.

    Someone who turned their avatar off in the profile page has said so; re-applying
    GitHub's picture on their next sign-in would read as the setting not working.
    """
    if user.avatar_source == "github":
        user.avatar_url = profile.avatar_url


async def link_github_profile(
    session: AsyncSession, profile: GitHubProfile
) -> tuple[User, bool]:
    """Resolve a GitHub profile to an account, creating one if this is a new person.

    Returns `(user, created)`. Three cases, in this order:

    1. The GitHub account id is already linked - sign that user in. The link is keyed
       on GitHub's numeric id, so a rename over there is just a refreshed row here.
    2. Its verified email matches an existing account - link the two. This is the
       "same email means same person" rule, and it is only safe because the caller has
       already established the email is verified by GitHub. An unverified email is
       a claim, and anyone can claim one.
    3. Neither - create the account, its personal workspace, and the link.
    """
    identity = (
        await session.execute(
            select(UserIdentity).where(
                UserIdentity.provider == PROVIDER,
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
        if await github_identity(session, existing.id) is not None:
            raise IdentityConflict("account already linked to a different github account")
        identity = UserIdentity(
            user_id=existing.id, provider=PROVIDER, provider_user_id=profile.provider_user_id
        )
        _apply_profile_snapshot(identity, profile)
        session.add(identity)
        # An account that has been signing in with a password keeps its own name and
        # avatar. Linking GitHub is not a request to be renamed by it.
        _follow_avatar(existing, profile)
        await session.commit()
        return existing, False

    user = User(
        email=profile.email,
        # No password, rather than an unguessable placeholder: a hash nobody holds the
        # input to is a credential that cannot be revoked or reasoned about.
        password_hash=None,
        # GitHub's display name when they have set one, their login when they have
        # not. Theirs to change afterwards, and never overwritten again.
        display_name=profile.name or profile.username,
        avatar_url=profile.avatar_url,
        avatar_source="github",
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
        user_id=user.id, provider=PROVIDER, provider_user_id=profile.provider_user_id
    )
    _apply_profile_snapshot(identity, profile)
    session.add(identity)
    await session.commit()
    return user, True


async def _resolve_after_race(
    session: AsyncSession, profile: GitHubProfile, cause: IntegrityError
) -> tuple[User, bool]:
    existing = (
        await session.execute(select(User).where(User.email == profile.email))
    ).scalar_one_or_none()
    if existing is None:
        raise IdentityConflict("could not create account") from cause
    identity = await github_identity(session, existing.id)
    if identity is None:
        raise IdentityConflict("account created concurrently without a github link") from cause
    _apply_profile_snapshot(identity, profile)
    _follow_avatar(existing, profile)
    await session.commit()
    return existing, False
