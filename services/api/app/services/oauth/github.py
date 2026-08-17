"""The GitHub half of GitHub sign-in: the authorize URL, and the code-for-profile swap.

Nothing in here touches the database or the session. It answers one question - "who is
the person behind this authorization code, and has GitHub verified their email" - and
`app/services/accounts.py` decides what that means for an account.

Deliberate omissions, both security ones:

* The access token is never returned to the caller and never stored. It is used for
  two GETs inside `fetch_profile` and then goes out of scope. Nothing after sign-in
  needs to call GitHub, so keeping it would be storing a credential to someone's
  repositories for no purpose.
* An unverified email is refused rather than trusted. Account matching is by email
  (see `accounts.py`), so accepting an unverified one would let anyone who can add
  `you@example.com` to their GitHub account sign in to yours.
"""

from dataclasses import dataclass
from typing import Any
from urllib.parse import urlencode

import httpx

from app.config import settings

PROVIDER = "github"

AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
TOKEN_URL = "https://github.com/login/oauth/access_token"
USER_URL = "https://api.github.com/user"
EMAILS_URL = "https://api.github.com/user/emails"

# The narrowest pair that answers the question. `read:user` is the profile; `user:email`
# is needed because a user's email is often private and absent from /user. Neither
# grants any access to code.
SCOPES = "read:user user:email"

# GitHub is a third party in the request path of a page load. A hung connection there
# must not hold a worker open indefinitely.
_TIMEOUT = httpx.Timeout(10.0, connect=5.0)

_API_HEADERS = {
    "Accept": "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "meadow",
}


class GitHubOAuthError(Exception):
    """GitHub refused, or answered with something this code cannot use."""


class EmailUnverified(GitHubOAuthError):
    """No verified email on the GitHub account, so there is nothing safe to match on."""


@dataclass(frozen=True)
class GitHubProfile:
    """What GitHub says about the person. A snapshot, not a live object."""

    provider_user_id: str
    username: str
    name: str | None
    # Always present and always verified - `select_email` refuses anything else.
    email: str
    avatar_url: str | None
    profile_url: str | None


def authorize_url(state: str) -> str:
    """Where to send the browser to start the dance.

    `redirect_uri` is sent explicitly even though the OAuth app has one registered:
    GitHub then checks the two match, which is one more thing an attacker who has
    somehow reached this endpoint cannot redirect.
    """
    query = urlencode(
        {
            "client_id": settings.github_client_id,
            "redirect_uri": settings.github_callback_url,
            "scope": SCOPES,
            "state": state,
            "allow_signup": "true",
        }
    )
    return f"{AUTHORIZE_URL}?{query}"


def select_email(payload: object) -> str:
    """Pick the address to match an account on: verified, and primary if there is one.

    Raises `EmailUnverified` when there is no verified address at all. That is a real
    outcome rather than an edge case - a fresh GitHub account has one unverified
    address - and it has to fail closed.
    """
    if not isinstance(payload, list):
        raise GitHubOAuthError("unexpected email payload")

    verified = [
        entry
        for entry in payload
        if isinstance(entry, dict)
        and entry.get("verified") is True
        and isinstance(entry.get("email"), str)
        and "@" in entry["email"]
    ]
    if not verified:
        raise EmailUnverified("no verified email on the github account")

    primary = next((entry for entry in verified if entry.get("primary") is True), verified[0])
    email: str = primary["email"]
    # Lowered because `users.email` is citext and every other path stores what the user
    # typed. Matching is case-insensitive either way; this only keeps the stored copy tidy.
    return email.strip().lower()


def profile_from_payloads(user_payload: object, emails_payload: object) -> GitHubProfile:
    if not isinstance(user_payload, dict):
        raise GitHubOAuthError("unexpected user payload")

    provider_user_id = user_payload.get("id")
    username = user_payload.get("login")
    if provider_user_id is None or not isinstance(username, str) or username == "":
        raise GitHubOAuthError("github user payload is missing id or login")

    name = user_payload.get("name")
    avatar_url = user_payload.get("avatar_url")
    profile_url = user_payload.get("html_url")

    return GitHubProfile(
        # str() because GitHub sends a JSON number and the column is text. The value is
        # only ever compared, never arithmetic.
        provider_user_id=str(provider_user_id),
        username=username,
        name=name if isinstance(name, str) and name.strip() != "" else None,
        email=select_email(emails_payload),
        avatar_url=avatar_url if isinstance(avatar_url, str) else None,
        profile_url=profile_url if isinstance(profile_url, str) else None,
    )


async def _exchange_code(client: httpx.AsyncClient, code: str) -> str:
    response = await client.post(
        TOKEN_URL,
        data={
            "client_id": settings.github_client_id,
            "client_secret": settings.github_client_secret.get_secret_value(),
            "code": code,
            "redirect_uri": settings.github_callback_url,
        },
        headers={"Accept": "application/json", "User-Agent": "meadow"},
    )
    if response.status_code != httpx.codes.OK:
        raise GitHubOAuthError(f"token exchange failed with {response.status_code}")

    payload: Any = response.json()
    if not isinstance(payload, dict):
        raise GitHubOAuthError("unexpected token payload")
    if "error" in payload:
        # GitHub answers 200 with an error body for a spent or forged code. The message
        # is logged, never shown: it distinguishes cases the browser has no business
        # distinguishing.
        raise GitHubOAuthError(str(payload.get("error")))

    token = payload.get("access_token")
    if not isinstance(token, str) or token == "":
        raise GitHubOAuthError("token exchange returned no access token")
    return token


async def fetch_profile(code: str) -> GitHubProfile:
    """Swap an authorization code for the profile behind it.

    `follow_redirects=False`: a redirect from either endpoint would be a signal
    something is wrong, and following one could replay the bearer token at whatever
    host it named.
    """
    async with httpx.AsyncClient(timeout=_TIMEOUT, follow_redirects=False) as client:
        token = await _exchange_code(client, code)
        headers = {**_API_HEADERS, "Authorization": f"Bearer {token}"}

        user_response = await client.get(USER_URL, headers=headers)
        if user_response.status_code != httpx.codes.OK:
            raise GitHubOAuthError(f"github /user answered {user_response.status_code}")

        emails_response = await client.get(EMAILS_URL, headers=headers)
        if emails_response.status_code != httpx.codes.OK:
            raise GitHubOAuthError(f"github /user/emails answered {emails_response.status_code}")

    return profile_from_payloads(user_response.json(), emails_response.json())
