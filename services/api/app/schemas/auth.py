"""Pydantic request/response models for auth. Kept separate from the ORM models."""

import uuid
from datetime import datetime
from typing import Literal

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


class IdentityOut(BaseModel):
    """A provider's copy of the user, read-only on this side.

    Sent so the profile page can show what each linked account actually is, and so it
    can offer "use my GitHub name" without inventing the value. Nothing here is
    writable: these fields are refreshed from the provider on every sign-in, and a
    profile edit must never be able to change what an account match is made on.
    """

    provider: str
    username: str
    name: str | None = None
    email: str | None = None
    avatar_url: str | None = None
    profile_url: str | None = None
    linked_at: datetime


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    avatar_url: str | None = None
    # "none", or the name of the provider the picture came from. Where `avatar_url`
    # came from, so the profile page can show which option is selected rather than
    # guessing from the URL.
    avatar_source: str = "none"
    # False for an account created through a provider and never given a password. The
    # UI uses it to explain how this account signs in, and it is not a secret: it is
    # the caller's own account, and /login already refuses both cases identically.
    has_password: bool = True
    # Keyed by provider name, and absent rather than null when nothing is linked. A
    # map rather than one field per provider, so adding a third provider does not
    # change this shape.
    identities: dict[str, IdentityOut] = Field(default_factory=dict)
    # Every user gets a personal workspace at registration, so the client always has
    # somewhere to create a board without a workspace-picker flow first.
    default_workspace_id: uuid.UUID | None = None


class ProfileUpdate(BaseModel):
    """A profile edit. Absent fields are left alone, which is what PATCH means.

    Email is not here on purpose. It is the account key that third-party sign-in
    matches on, so changing it is an account-merge question, not a profile field.
    """

    display_name: str | None = Field(default=None, min_length=1, max_length=80)
    # "none" means initials. Anything else names a provider that has to be linked
    # already, which the router checks rather than the schema: whether a link exists is
    # a fact about the caller, not about the request body.
    avatar_source: Literal["none", "github", "google"] | None = None


class RegistrationPending(BaseModel):
    """What registering answers with now: no session, because the address has not spoken.

    A registration used to come back signed in. It cannot any more - the account is
    unusable until the link in the activation mail is followed - and returning tokens
    for an account that cannot be used would be a lie the client would have to unpick.
    """

    email: str
    # False only on a deployment with no SMTP configured, where the account is opened
    # immediately. The client shows "check your mail" or "you can log in now" from this
    # rather than assuming which world it is in.
    activation_required: bool = True
    # True when a fresh link was put in the post as part of this request.
    activation_sent: bool = True


class ProvidersOut(BaseModel):
    """Which sign-in buttons the client should offer.

    The client cannot infer this: the provider is configured by environment variables
    the browser never sees, and a button that redirects into a 404 is worse than no
    button.
    """

    github: bool = False
    google: bool = False


class ResendActivation(BaseModel):
    email: EmailStr


class PasswordResetRequest(BaseModel):
    email: EmailStr


class PasswordReset(BaseModel):
    token: str = Field(max_length=256)
    # The same floor registration uses. A reset is not a place to relax it: it is the
    # one moment an attacker with a stolen link would choose the password.
    password: str = Field(min_length=12, max_length=256)


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
