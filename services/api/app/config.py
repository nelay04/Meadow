from pathlib import Path

from pydantic import SecretStr
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
    redis_url: str = "redis://localhost:6382/0"

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
    # Both ends of the OAuth dance. The callback is limited too: it is reachable by
    # anyone, and each call costs two requests to github.com.
    rate_limit_oauth: str = "20/60"
    # The unauthenticated sharing endpoints, keyed on the client address because there
    # is no user to key on. Looser than the others because a public board that ten
    # people open at once from one office is the feature working, and because a share
    # token is 192 bits: this is here to make walking token space pointless, not to
    # ration ordinary use.
    rate_limit_share: str = "60/60"

    # --- third-party sign-in (ARCHITECTURE 7) ---
    # Blank by default, and that is the off switch, per provider: with either half of a
    # pair missing that provider reports itself unavailable and its routes answer 404,
    # rather than the app offering a button that redirects into an error. The two
    # providers are independent - a deployment can run either, both, or neither.
    github_client_id: str = ""
    # SecretStr so it cannot reach a log, a traceback, or a settings repr by accident.
    # Only the token exchange unwraps it.
    github_client_secret: SecretStr = SecretStr("")
    # Absolute, and it has to match the callback URL registered on the GitHub OAuth
    # app character for character or GitHub refuses the exchange.
    github_callback_url: str = "http://localhost:3012/api/v1/auth/github/callback"

    google_client_id: str = ""
    google_client_secret: SecretStr = SecretStr("")
    # Google is stricter than GitHub about this one: the redirect URI has to be listed
    # on the OAuth client verbatim, and Google refuses the whole flow at the authorize
    # step rather than at the exchange.
    google_callback_url: str = "http://localhost:3012/api/v1/auth/google/callback"

    # Where the browser is sent once the callback has minted a session, and the only
    # origin any post-login redirect may point at. Everything the callback builds is
    # this value plus a path this code chose - never a value from the query string,
    # which is how OAuth callbacks become open redirects.
    web_base_url: str = "http://localhost:3012"

    # Ten minutes: long enough to sign in at the provider and approve, short enough that a
    # state value copied out of a browser history is dead by the time it is used.
    oauth_state_ttl_seconds: int = 600

    # --- activation mail ---
    # A registration is not finished until the address answers, so this is what makes
    # an account usable at all. Blank host is the off switch and it is honest about
    # itself: with no SMTP configured an account is created already activated, because
    # the alternative is an account nobody can ever open. That is a development
    # convenience and the API logs a warning every time it takes that path.
    smtp_host: str = ""
    smtp_port: int = 587
    # The sender's mailbox, and usually also the login. Kept as two settings because a
    # relay often authenticates as one identity and sends as another.
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = ""
    smtp_from_name: str = "Meadow"
    # STARTTLS on the submission port (587). Set false with port 465 for implicit TLS,
    # which `smtp_ssl` selects instead. One of the two is always on: an unencrypted
    # submission would put the password on the wire.
    smtp_starttls: bool = True
    smtp_ssl: bool = False
    smtp_timeout_seconds: int = 15

    # A day. Long enough for someone who registers at night and reads mail in the
    # morning, short enough that a link sitting in an unattended inbox is not a
    # standing key to the account.
    activation_ttl_hours: int = 24

    # One hour, not a day. A reset link is a key to an account that already exists and
    # has something in it, so it should be usable now and dead soon; an activation link
    # opens an empty account and can afford to wait for someone's morning.
    password_reset_ttl_hours: int = 1

    @property
    def mail_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_from)

    @property
    def github_oauth_enabled(self) -> bool:
        return bool(self.github_client_id and self.github_client_secret.get_secret_value())

    @property
    def google_oauth_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret.get_secret_value())


settings = Settings()
