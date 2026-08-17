"""What every third-party sign-in has to produce, and how it fails.

A provider module (`github.py`, `google.py`) owns exactly one job: turn an
authorization code into an `OAuthProfile`, or raise. Nothing about accounts, sessions
or the database belongs there, and nothing about a specific provider belongs above
this line. `app/services/accounts.py` takes the profile and decides what it means for
an account, the same way for every provider.

Two rules are shared rather than re-argued per provider, because both are security
decisions:

* **The access token is never returned and never stored.** It is used server-side to
  read the profile below, then dropped. Nothing after sign-in needs to call the
  provider again, so keeping it would be storing someone else's credential for no
  purpose.
* **An unverified email is refused.** Account matching is by email, so trusting an
  unverified one would let anyone who can type `you@example.com` into a provider's
  profile page sign in to your account.
"""

from dataclasses import dataclass
from typing import ClassVar, Protocol


class OAuthError(Exception):
    """The provider refused, or answered with something this code cannot use."""


class EmailUnverified(OAuthError):
    """No verified email on the account, so there is nothing safe to match on."""


@dataclass(frozen=True)
class OAuthProfile:
    """What a provider says about the person. A snapshot, not a live object.

    `provider` is a ClassVar rather than a field: it is a property of which module
    built the profile, not something a payload can influence.
    """

    provider: ClassVar[str] = ""

    provider_user_id: str
    # What a person would recognise as the account name over there. GitHub's `login`;
    # for Google, which has no handle, the email address.
    username: str
    name: str | None
    # Always present and always verified. Each provider module refuses anything else.
    email: str
    avatar_url: str | None
    profile_url: str | None


class OAuthClient(Protocol):
    """The surface `app/api/v1/oauth.py` builds a pair of routes from.

    Satisfied by a module, not a class. Each provider is a handful of URLs and two
    functions, and there is nothing to instantiate or keep.
    """

    PROVIDER: str

    def enabled(self) -> bool: ...

    def authorize_url(self, state: str) -> str: ...

    async def fetch_profile(self, code: str) -> OAuthProfile: ...


def normalise_email(email: str) -> str:
    """Lowered, because `users.email` is citext and the stored copy should be tidy.

    Matching is case-insensitive either way; this only keeps what lands in the row
    consistent with what every other path stores.
    """
    return email.strip().lower()
