from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Single .env at the repo root, shared with docker-compose.local.yml. Resolved from
# __file__ so it does not matter which directory the API is launched from. Real
# environment variables win over the file, which is how the test suite redirects at
# the test DB.
#
# The container image ships only `services/api`, so there is no repo root above it and
# `parents[3]` may not exist. Fall back to the package's own parent rather than raising
# at import: in a container the configuration arrives as real environment variables,
# and pydantic-settings ignores an env_file that is not there.
_MODULE = Path(__file__).resolve()
_PARENTS = _MODULE.parents
REPO_ROOT = _PARENTS[3] if len(_PARENTS) > 3 else _PARENTS[-1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MEADOW_",
        env_file=REPO_ROOT / ".env",
        extra="ignore",
    )

    database_url: str = "postgresql+asyncpg://meadow:meadow@localhost:5435/meadow"
    redis_url: str = "redis://localhost:6380/0"

    # --- auth (ARCHITECTURE 7) ---
    # One secret signs both the access JWT and the ws-token. They are different token
    # types with different lifetimes, and `typ` is checked on decode, so one key is
    # enough. Generate per environment: python -c "import secrets;
    # print(secrets.token_urlsafe(32))"
    jwt_secret: str = "dev-only-not-a-real-secret"
    access_token_ttl_seconds: int = 15 * 60
    refresh_token_ttl_days: int = 30
    # Cookie flags. secure=False only so the dev server works over plain http.
    refresh_cookie_name: str = "meadow_refresh"
    refresh_cookie_secure: bool = False

    ws_token_ttl_seconds: int = 60

    # ARCHITECTURE 6: "re-validate every 15 minutes; force reconnect on failure". The
    # watchdog also wakes early when the access token behind the connection expires,
    # so a socket can never outlive the session that authorised it.
    ws_revalidate_interval_seconds: int = 15 * 60

    # ARCHITECTURE 6: reject a room join beyond this many concurrent clients.
    max_clients_per_room: int = 50

    # ARCHITECTURE 7 rate limits, as "<count>/<window seconds>".
    rate_limit_enabled: bool = True
    rate_limit_login: str = "5/60"
    rate_limit_register: str = "3/3600"
    rate_limit_ws_token: str = "30/60"


settings = Settings()
