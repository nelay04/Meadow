from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Single .env at the repo root, shared with docker-compose. Resolved from __file__ so
# it does not matter which directory the API is launched from.
REPO_ROOT = Path(__file__).resolve().parents[3]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_prefix="MEADOW_",
        env_file=REPO_ROOT / ".env",
        extra="ignore",
    )

    database_url: str = "postgresql+asyncpg://meadow:meadow@localhost:5435/meadow"
    redis_url: str = "redis://localhost:6380/0"

    # M0 only. M1 replaces this with the real JWT signing key from the auth service.
    ws_token_secret: str = "dev-only-not-a-real-secret"
    ws_token_ttl_seconds: int = 60

    # ARCHITECTURE 6: reject a room join beyond this many concurrent clients.
    max_clients_per_room: int = 50


settings = Settings()
