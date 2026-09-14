from fastapi import APIRouter

from app.api.v1 import auth, boards, config, connect, oauth, share, tokens, workspaces, ws_token

router = APIRouter(prefix="/api/v1")
router.include_router(auth.router)
# Deployment settings the client needs, and nothing else. Unauthenticated.
router.include_router(config.router)
# One pair of routes per configured provider, from the registry in
# app/services/oauth. Adding a provider does not touch this file.
for oauth_router in oauth.routers:
    router.include_router(oauth_router)
router.include_router(workspaces.router)
router.include_router(boards.router)
# The unauthenticated half of sharing: opening a public link, and reading an invitation
# addressed to somebody who has not registered yet. See `app/api/v1/share.py` for why
# each of its routes is reachable without a session.
router.include_router(share.router)
router.include_router(ws_token.router)
# Personal access tokens for MCP clients and scripts. Managed from a session only.
router.include_router(tokens.router)
# Assistants connecting by signing in with OAuth. The discovery documents are served at
# the site root from `connect.well_known`, mounted in `app/main.py`.
router.include_router(connect.router)
