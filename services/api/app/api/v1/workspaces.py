"""Workspaces and workspace membership."""

import re
import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, select

from app.auth.deps import CurrentUser, Session
from app.models import User, Workspace, WorkspaceMember
from app.schemas.boards import MemberOut, WorkspaceCreate, WorkspaceMemberAdd, WorkspaceOut
from app.services.permissions import WorkspaceRole

router = APIRouter(prefix="/workspaces", tags=["workspaces"])


async def _require_workspace_role(
    session: Session, user: User, workspace_id: uuid.UUID, *, admin: bool
) -> WorkspaceRole:
    role = (
        await session.execute(
            select(WorkspaceMember.role).where(
                WorkspaceMember.workspace_id == workspace_id,
                WorkspaceMember.user_id == user.id,
            )
        )
    ).scalar_one_or_none()

    # Same 403 whether the workspace is missing or merely not theirs.
    if role is None or (admin and role is WorkspaceRole.member):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="no access")
    return role


@router.get("", response_model=list[WorkspaceOut])
async def list_workspaces(user: CurrentUser, session: Session) -> list[WorkspaceOut]:
    rows = (
        await session.execute(
            select(Workspace, WorkspaceMember.role)
            .join(WorkspaceMember, WorkspaceMember.workspace_id == Workspace.id)
            .where(WorkspaceMember.user_id == user.id)
            .order_by(Workspace.created_at)
        )
    ).all()
    return [
        WorkspaceOut(id=w.id, name=w.name, slug=w.slug, role=role) for w, role in rows
    ]


@router.post("", response_model=WorkspaceOut, status_code=status.HTTP_201_CREATED)
async def create_workspace(
    body: WorkspaceCreate, user: CurrentUser, session: Session
) -> WorkspaceOut:
    slug_base = re.sub(r"[^a-z0-9]+", "-", body.name.lower()).strip("-") or "workspace"
    workspace = Workspace(
        name=body.name,
        slug=f"{slug_base[:40]}-{uuid.uuid4().hex[:8]}",
        owner_id=user.id,
    )
    session.add(workspace)
    await session.flush()
    session.add(
        WorkspaceMember(workspace_id=workspace.id, user_id=user.id, role=WorkspaceRole.owner)
    )
    await session.commit()
    return WorkspaceOut(
        id=workspace.id, name=workspace.name, slug=workspace.slug, role=WorkspaceRole.owner
    )


@router.get("/{workspace_id}/members", response_model=list[MemberOut])
async def list_members(
    workspace_id: uuid.UUID, user: CurrentUser, session: Session
) -> list[MemberOut]:
    await _require_workspace_role(session, user, workspace_id, admin=False)
    rows = (
        await session.execute(
            select(User, WorkspaceMember.role)
            .join(WorkspaceMember, WorkspaceMember.user_id == User.id)
            .where(WorkspaceMember.workspace_id == workspace_id)
            .order_by(WorkspaceMember.joined_at)
        )
    ).all()
    return [
        MemberOut(user_id=u.id, email=u.email, display_name=u.display_name, role=role)
        for u, role in rows
    ]


@router.post(
    "/{workspace_id}/members", response_model=MemberOut, status_code=status.HTTP_201_CREATED
)
async def add_member(
    workspace_id: uuid.UUID, body: WorkspaceMemberAdd, user: CurrentUser, session: Session
) -> MemberOut:
    await _require_workspace_role(session, user, workspace_id, admin=True)

    target = await session.get(User, body.user_id)
    if target is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")

    existing = await session.get(WorkspaceMember, (workspace_id, body.user_id))
    if existing is not None:
        existing.role = body.role
    else:
        session.add(
            WorkspaceMember(workspace_id=workspace_id, user_id=body.user_id, role=body.role)
        )
    await session.commit()
    return MemberOut(
        user_id=target.id, email=target.email, display_name=target.display_name, role=body.role
    )


@router.delete("/{workspace_id}/members/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def remove_member(
    workspace_id: uuid.UUID, user_id: uuid.UUID, user: CurrentUser, session: Session
) -> None:
    await _require_workspace_role(session, user, workspace_id, admin=True)

    workspace = await session.get(Workspace, workspace_id)
    if workspace is not None and workspace.owner_id == user_id:
        # Otherwise a workspace can be left with boards nobody can administer.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="cannot remove the workspace owner"
        )

    await session.execute(
        delete(WorkspaceMember).where(
            WorkspaceMember.workspace_id == workspace_id, WorkspaceMember.user_id == user_id
        )
    )
    await session.commit()
