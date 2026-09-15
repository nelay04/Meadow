"""Pydantic request/response models for auth. Kept separate from the ORM models."""

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, model_validator


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
    # False only on a deployment with no mail provider configured, where the account is opened
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


class SessionOut(BaseModel):
    """One browser signed in to this account.

    `id` is the refresh-token family, which is what a session has always been here -
    see `app/services/sessions.py`. It is safe to hand out: knowing it grants nothing,
    because every use of a session requires the token itself, and the only thing it can
    be passed back to is the delete route, which is scoped to the caller's own rows.

    Both the parse and the raw header go out. The parse is what the list is read by;
    the raw string is what settles it when the parse is wrong about an unusual client,
    and it is the user's own header either way.
    """

    id: uuid.UUID
    #: The browser asking. Exactly one session is ever marked, and it cannot be ended
    #: from the list - logging out is its own, clearer button.
    current: bool
    browser: str | None = None
    os: str | None = None
    device: Literal["desktop", "mobile", "tablet", "unknown"] = "unknown"
    #: "Firefox on Windows", or as much of it as the header supports. Composed on the
    #: server so the list reads the same everywhere it is shown.
    label: str
    user_agent: str | None = None
    #: The address the session was last seen from, or null where the peer was not a
    #: parseable IP. Never a location: this deployment does no geolocation, and a
    #: guessed city on a security screen is worse than an address.
    ip: str | None = None
    #: When this browser signed in. The family's first token, carried forward.
    signed_in_at: datetime
    #: When it last renewed its access token, which is the closest thing to activity
    #: the server actually witnesses. A browser sitting idle does not renew.
    last_active_at: datetime
    #: When it will be signed out for doing nothing, unless it renews before then.
    expires_at: datetime


class SessionsRevoked(BaseModel):
    """How many other sessions "sign out everywhere else" ended. Zero is a fine answer."""

    revoked: int


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


class ApiTokenGrantIn(BaseModel):
    """One glade a fine-grained token may open, and what it may do there.

    `read` is part of the shape so a form can send what it shows, and it must be true:
    edit and delete are on top of reading, never instead of it, and a glade the token may
    not even read is simply a glade that is not listed.
    """

    board_id: uuid.UUID
    read: bool = True
    edit: bool = False
    delete: bool = False

    @model_validator(mode="after")
    def _reads(self) -> "ApiTokenGrantIn":
        if not self.read:
            raise ValueError("a granted glade is always readable; leave it out to grant nothing")
        return self


def _unique_grants(grants: list[ApiTokenGrantIn] | None) -> None:
    if grants is None:
        return
    ids = [grant.board_id for grant in grants]
    if len(set(ids)) != len(ids):
        raise ValueError("a glade may be granted once")


class ApiTokenCreate(BaseModel):
    """A personal access token, as the profile page asks for one."""

    name: str = Field(min_length=1, max_length=80)
    #: `classic` is everything the account can do; `fine_grained` names its glades.
    kind: Literal["classic", "fine_grained"]
    #: Required for a fine-grained token, and refused on a classic one.
    grants: list[ApiTokenGrantIn] | None = Field(default=None, max_length=100)
    #: Whether a fine-grained token may make new glades. A glade it makes is added to its
    #: own grants with edit and delete. Refused on a classic token, which may already.
    can_create: bool = False
    #: Days until it stops working. Null for never, which the page does not default to.
    expires_in_days: int | None = Field(default=None, ge=1, le=366)

    @model_validator(mode="after")
    def _grants_match_kind(self) -> "ApiTokenCreate":
        if self.kind == "classic" and self.grants is not None:
            raise ValueError("a classic token has no grants; it can do what the account can")
        if self.kind == "classic" and self.can_create:
            raise ValueError("a classic token may already create glades")
        if self.kind == "fine_grained" and not self.grants and not self.can_create:
            raise ValueError("a fine-grained token needs at least one glade, or leave to create")
        _unique_grants(self.grants)
        return self


class ApiTokenPatch(BaseModel):
    """Rename a token, or change what a fine-grained one may open, do and create."""

    name: str | None = Field(default=None, min_length=1, max_length=80)
    #: An empty list is allowed only for a token that may create: it then names nothing
    #: yet and fills its own list with the glades it makes. The router checks that,
    #: because it is the only side that knows what the token may do.
    grants: list[ApiTokenGrantIn] | None = Field(default=None, max_length=100)
    #: Whether a fine-grained token may make new glades. Null leaves it as it is; taking
    #: it away does not take back the glades it already made, which are on its list.
    can_create: bool | None = None

    @model_validator(mode="after")
    def _unique(self) -> "ApiTokenPatch":
        _unique_grants(self.grants)
        return self


class ApiTokenGrantOut(BaseModel):
    board_id: uuid.UUID
    title: str
    read: bool = True
    edit: bool
    delete: bool


class ApiTokenOut(BaseModel):
    """One token, as the list shows it. Never the secret."""

    id: uuid.UUID
    name: str
    #: The first characters of the raw token, so the person can tell which is which.
    prefix: str
    kind: Literal["classic", "fine_grained"]
    #: Null for a classic token, which names no glades because it has all of them.
    grants: list[ApiTokenGrantOut] | None = None
    #: Whether it may make new glades. Always true for a classic token.
    can_create: bool = False
    created_at: datetime
    expires_at: datetime | None = None
    #: The hard end of a connection made by signing in, however often it renews.
    ends_at: datetime | None = None
    last_used_at: datetime | None = None
    #: The assistant it was issued to by signing in, or null for one made by hand.
    client_name: str | None = None


class ApiTokenCreated(ApiTokenOut):
    """The response to issuing a token: the only time the secret is ever sent."""

    token: str


class ApiTokenCurrent(BaseModel):
    """A token describing itself, to the client holding it.

    What an MCP server reads at startup, so the model it serves knows its boundaries
    before it tries to cross one. Carries nothing the holder could not already learn by
    trying, and nothing about any other token.
    """

    id: uuid.UUID
    name: str
    kind: Literal["classic", "fine_grained"]
    expires_at: datetime | None = None
    #: Whether this token may make a glade. Always true for a classic token; true for a
    #: fine-grained one that was given the permission, and a glade it makes joins its own
    #: list with edit and delete.
    can_create_glades: bool
    grants: list[ApiTokenGrantOut] | None = None


class ConnectRequestOut(BaseModel):
    """What the consent screen shows about an assistant asking to connect."""

    client_name: str
    #: The domain a published client proved by serving its metadata document there. Null
    #: for a registered client, whose name nobody has checked.
    client_host: str | None = None
    #: Where the answer goes. Shown because the name is whatever the client registered
    #: with, and the address is the part it cannot choose freely.
    redirect_host: str


class ConnectApproval(BaseModel):
    """What a person grants an assistant: a fine-grained token's glades and creating."""

    grants: list[ApiTokenGrantIn] = Field(default_factory=list, max_length=100)
    can_create: bool = False
    #: Days until the connection ends however often it renews. Null renews while used.
    expires_in_days: int | None = Field(default=None, ge=1, le=366)

    @model_validator(mode="after")
    def _grants_something(self) -> "ConnectApproval":
        if not self.grants and not self.can_create:
            raise ValueError("pick at least one glade, or allow creating glades")
        _unique_grants(self.grants)
        return self


class ConnectRedirect(BaseModel):
    """Where the browser goes next: back to the assistant, with a code or an error."""

    redirect_url: str
