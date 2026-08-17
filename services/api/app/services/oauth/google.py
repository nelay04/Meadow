"""The Google half of Google sign-in: the authorize URL, and the code-for-profile swap.

Same shape as `github.py`, and deliberately so - the differences are all Google's, not
this codebase's:

* One request instead of two. Google's OpenID `userinfo` endpoint carries the email and
  its verified flag alongside the profile, so there is no second call.
* The profile is read from `userinfo` rather than by decoding the `id_token`. Both are
  authoritative, but a JWT is only worth what its signature check is worth, and that
  means fetching and caching Google's JWKS and getting every step of the verification
  right. A TLS call to Google carrying a token Google just issued needs none of that.
  If a future feature needs the claims without a round trip, verify the id_token
  properly then; do not start trusting an unverified one.
* `sub` is the account id, and it is the only stable field Google publishes. Email can
  change on a Workspace account, so the link is keyed on `sub` exactly as GitHub's is
  keyed on its numeric id.

Google accounts do not have a username. `username` carries the email address, because
that is what a person recognises when the profile page says which account is linked.
"""

from dataclasses import dataclass
from typing import Any, ClassVar
from urllib.parse import urlencode

import httpx

from app.config import settings
from app.services.oauth.base import EmailUnverified, OAuthError, OAuthProfile, normalise_email

PROVIDER = "google"

AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo"

# The three OpenID scopes and nothing else. No Drive, no Gmail, no contacts: this
# grants the right to learn who someone is and nothing about what they own.
SCOPES = "openid email profile"

_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

_API_HEADERS = {"Accept": "application/json", "User-Agent": "meadow"}


@dataclass(frozen=True)
class GoogleProfile(OAuthProfile):
    """What Google says about the person. A snapshot, not a live object."""

    provider: ClassVar[str] = PROVIDER


def enabled() -> bool:
    return settings.google_oauth_enabled


def authorize_url(state: str) -> str:
    """Where to send the browser to start the dance.

    `access_type=online` and no `prompt=consent`: an offline grant would hand back a
    refresh token for calling Google later, and there is no later. `select_account`
    is there because a signed-in Google user would otherwise be bounced straight back
    as whichever account the browser happens to hold, with no way to pick another.
    """
    query = urlencode(
        {
            "client_id": settings.google_client_id,
            "redirect_uri": settings.google_callback_url,
            "response_type": "code",
            "scope": SCOPES,
            "state": state,
            "access_type": "online",
            "prompt": "select_account",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def _verified_email(payload: dict[str, Any]) -> str:
    """The address to match an account on, or a refusal.

    `email_verified` is compared against both `True` and `"true"`: it is a boolean in
    the userinfo JSON and a string in an id_token's claims, and reading the string
    form as truthy-because-non-empty would accept `"false"`.
    """
    email = payload.get("email")
    verified = payload.get("email_verified")
    if not isinstance(email, str) or "@" not in email:
        raise OAuthError("google userinfo has no email")
    if verified is not True and verified != "true":
        raise EmailUnverified("google has not verified the email on this account")
    return normalise_email(email)


def profile_from_userinfo(payload: object) -> GoogleProfile:
    if not isinstance(payload, dict):
        raise OAuthError("unexpected userinfo payload")

    subject = payload.get("sub")
    if not isinstance(subject, str) or subject == "":
        raise OAuthError("google userinfo is missing sub")

    email = _verified_email(payload)
    name = payload.get("name")
    picture = payload.get("picture")

    return GoogleProfile(
        provider_user_id=subject,
        # No handle exists over there, so the email is the recognisable name.
        username=email,
        name=name if isinstance(name, str) and name.strip() != "" else None,
        email=email,
        avatar_url=picture if isinstance(picture, str) else None,
        # Google has no public profile page to link to. Better empty than a guess.
        profile_url=None,
    )


async def _exchange_code(client: httpx.AsyncClient, code: str) -> str:
    response = await client.post(
        TOKEN_URL,
        data={
            "client_id": settings.google_client_id,
            "client_secret": settings.google_client_secret.get_secret_value(),
            "code": code,
            "grant_type": "authorization_code",
            "redirect_uri": settings.google_callback_url,
        },
        headers=_API_HEADERS,
    )
    if response.status_code != httpx.codes.OK:
        # Google answers 400 with an error body for a spent or forged code. The status
        # is logged, never shown: it distinguishes cases the browser has no business
        # distinguishing.
        raise OAuthError(f"token exchange failed with {response.status_code}")

    payload: Any = response.json()
    if not isinstance(payload, dict):
        raise OAuthError("unexpected token payload")

    token = payload.get("access_token")
    if not isinstance(token, str) or token == "":
        raise OAuthError("token exchange returned no access token")
    return token


async def fetch_profile(code: str) -> GoogleProfile:
    """Swap an authorization code for the profile behind it.

    `follow_redirects=False` for the same reason as GitHub's: a redirect here would be
    a signal something is wrong, and following one could replay the bearer token at
    whatever host it named.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False) as client:
        token = await _exchange_code(client, code)
        response = await client.get(
            USERINFO_URL, headers={**_API_HEADERS, "Authorization": f"Bearer {token}"}
        )
        if response.status_code != httpx.codes.OK:
            raise OAuthError(f"google userinfo answered {response.status_code}")

    return profile_from_userinfo(response.json())
