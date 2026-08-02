"""Pydantic request/response models for auth. Kept separate from the ORM models."""

import uuid

from pydantic import BaseModel, EmailStr, Field


class RegisterRequest(BaseModel):
    email: EmailStr
    # 12 rather than 8: length is the only knob that reliably helps, and argon2id
    # already covers the rest. No composition rules - they push users to Password1!.
    password: str = Field(min_length=12, max_length=256)
    display_name: str = Field(min_length=1, max_length=80)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(max_length=256)


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    avatar_url: str | None = None
    # Every user gets a personal workspace at registration, so the client always has
    # somewhere to create a board without a workspace-picker flow first.
    default_workspace_id: uuid.UUID | None = None


class TokenPair(BaseModel):
    """The refresh token is absent on purpose - it goes back as an httpOnly cookie.

    ARCHITECTURE 7: access token in memory only, never localStorage; refresh token in
    a cookie JavaScript cannot read. Returning it in the body would undo that.
    """

    access_token: str
    token_type: str = "bearer"
    expires_in: int


class AuthResponse(TokenPair):
    user: UserOut
