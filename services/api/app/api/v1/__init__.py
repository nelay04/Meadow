from fastapi import APIRouter

from app.api.v1 import auth, boards, workspaces, ws_token

router = APIRouter(prefix="/api/v1")
router.include_router(auth.router)
router.include_router(workspaces.router)
router.include_router(boards.router)
router.include_router(ws_token.router)
