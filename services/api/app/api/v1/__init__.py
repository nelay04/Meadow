from fastapi import APIRouter

from app.api.v1 import auth, boards, oauth, workspaces, ws_token

router = APIRouter(prefix="/api/v1")
router.include_router(auth.router)
# One pair of routes per configured provider, from the registry in
# app/services/oauth. Adding a provider does not touch this file.
for oauth_router in oauth.routers:
    router.include_router(oauth_router)
router.include_router(workspaces.router)
router.include_router(boards.router)
router.include_router(ws_token.router)
