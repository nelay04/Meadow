"""Third-party sign-in.

One registry, so nothing downstream carries a list of providers. `app/api/v1/oauth.py`
builds its routes from it, `/auth/providers` reports it, and adding a third provider is
a module plus one line here.
"""

from app.services.oauth import github, google
from app.services.oauth.base import (
    EmailUnverified,
    OAuthClient,
    OAuthError,
    OAuthProfile,
    normalise_email,
)

# Insertion order is the order the sign-in buttons appear in, so it is worth choosing.
PROVIDERS: dict[str, OAuthClient] = {
    github.PROVIDER: github,
    google.PROVIDER: google,
}

__all__ = [
    "PROVIDERS",
    "EmailUnverified",
    "OAuthClient",
    "OAuthError",
    "OAuthProfile",
    "github",
    "google",
    "normalise_email",
]
