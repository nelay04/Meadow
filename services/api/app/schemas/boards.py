"""Pydantic request/response models for workspaces, boards, and ws-tokens."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.services.board_kinds import DEFAULT_BOARD_KIND, BoardKind
from app.services.permissions import BoardRole, WorkspaceRole


class WorkspaceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=80)


class WorkspaceOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    role: WorkspaceRole


class WorkspaceMemberAdd(BaseModel):
    user_id: uuid.UUID
    role: WorkspaceRole = WorkspaceRole.member


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    display_name: str
    role: str


class BoardCreate(BaseModel):
    workspace_id: uuid.UUID
    title: str = Field(default="Untitled", max_length=200)
    # Chosen once, at creation. A kind decides what the surface looks like and nothing
    # about the document, so converting one to another later is a client-side setting
    # rather than a migration; it is still not offered, because a glade drawn against
    # a diary's ruling does not read the same on graph paper.
    kind: BoardKind = DEFAULT_BOARD_KIND


class BoardPatch(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    is_archived: bool | None = None


class BoardOut(BaseModel):
    id: uuid.UUID
    workspace_id: uuid.UUID
    title: str
    kind: BoardKind
    is_archived: bool
    created_at: datetime
    updated_at: datetime
    # The caller's effective role. The board list uses it to decide what to enable,
    # so it never has to guess from workspace membership.
    role: BoardRole


class BoardMemberAdd(BaseModel):
    user_id: uuid.UUID
    role: BoardRole


class WsTokenRequest(BaseModel):
    board_id: uuid.UUID


class WsTokenOut(BaseModel):
    token: str
    expires_in: int
    # The resolved role, so the client can disable its tools before the user reaches
    # for one. ARCHITECTURE 6: "the handshake must return the resolved role".
    role: BoardRole
