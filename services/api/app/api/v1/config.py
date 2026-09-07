"""What the client is allowed to know about how this deployment is set up.

One route, and it stays small on purpose. Anything here is public - it answers before
sign-in, because the client reads it while a session is still being restored - so
nothing that is not already visible in the UI belongs in it.
"""

from fastapi import APIRouter

from app.config import settings
from app.schemas.boards import AppConfigOut

router = APIRouter(prefix="/config", tags=["config"])


@router.get("", response_model=AppConfigOut)
async def read_config() -> AppConfigOut:
    """The retention window, so both trashes count down against the same number.

    The board trash is swept on the server and does not need the client to know this;
    a lea's torn-out pages live in the CRDT document, where the server has no view of
    them at all, so the sweep for those runs on the client and has to be told how long
    the window is. Serving it rather than duplicating a default in the frontend is what
    keeps changing `MEADOW_TRASH_RETENTION_HOURS` from changing one trash and not the
    other.
    """
    return AppConfigOut(trash_retention_hours=max(0, settings.trash_retention_hours))
