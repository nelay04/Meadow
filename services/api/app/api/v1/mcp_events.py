"""The audit trail for what an assistant did to a glade.

Tier 3 of the October review. The MCP server mints one operation id per tool call, uses
it as the Y.Doc transaction origin of that write, and posts the event here once the
write has gone. The id is what joins the two: a transaction in the document and a line
in this table are the same operation.

Why the event is posted rather than read off the socket: a Yjs update is a binary diff
and carries no origin. The origin is local metadata on the transaction that produced it
and is never encoded into the update, so no amount of reading the websocket would
recover it. The review's plan said the id would be "carried through the websocket",
which is not a thing that can be built without inventing a message type. An explicit
event is honest about where the information comes from, and it is the only way the
server learns the parts only the caller knows: which tool ran, how much it asked for,
and how long it took.

This records metadata about an edit and never the edit. What changed lives in the CRDT
log, as ARCHITECTURE 3 requires.
"""

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select

from app.auth.deps import (
    CurrentPrincipal,
    CurrentUser,
    Session,
    board_viewer,
    board_viewer_or_token,
)
from app.models import McpEvent
from app.schemas.boards import McpEventIn, McpEventOut
from app.services.permissions import BoardRole, at_least

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/boards", tags=["mcp"])

#: How many rows one read returns. The trail is read newest first and nobody pages
#: through it; a cap is here so a long-running glade cannot answer with everything.
_PAGE = 200


@router.post(
    "/{board_id}/mcp-events",
    response_model=McpEventOut,
    status_code=status.HTTP_201_CREATED,
)
async def record_event(
    board_id: uuid.UUID,
    body: McpEventIn,
    session: Session,
    principal: CurrentPrincipal,
    role: Annotated[BoardRole, Depends(board_viewer_or_token)],
) -> McpEvent:
    """Record one mutation. Access tokens only, and only ones that could have made it."""
    # A person editing in the browser is not an MCP mutation, and letting a browser
    # session post here would let anything with a logged-in tab write the trail.
    if principal.api_token is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="this route records what an access token did",
        )

    # Only somebody who could have made the edit may say they made it. `board_viewer_or_token`
    # is as far as that dependency goes with a token by deliberate design, so the edit
    # question is asked here, against the role it resolved rather than a second
    # resolution of its own: permissions live in one function.
    if not at_least(role, BoardRole.editor):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient role")

    # A fine-grained token narrows its owner. One granted read on this glade cannot have
    # edited it, whatever its owner's role is.
    grant = await principal.grant_for(session, board_id)
    if grant is None or not grant.edit:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="insufficient grant")

    event = McpEvent(
        operation_id=body.operation_id,
        board_id=board_id,
        # The server's own answer, from the credential that presented the event. Nothing
        # in the body names an actor, so a token cannot write a row in another's name.
        user_id=principal.user.id,
        api_token_id=principal.api_token.id,
        tool=body.tool,
        requested=body.requested,
        accepted=body.accepted,
        duration_ms=body.duration_ms,
        outcome=body.outcome,
        reason=body.reason,
    )
    session.add(event)
    await session.commit()
    await session.refresh(event)

    # The log line and the row say the same thing on purpose. The row is what you query
    # later; the line is what is there when somebody is watching the service and has no
    # database open.
    logger.info(
        "mcp mutation op=%s board=%s user=%s token=%s tool=%s requested=%d accepted=%d "
        "duration_ms=%d outcome=%s reason=%s",
        event.operation_id,
        board_id,
        principal.user.id,
        principal.api_token.id,
        event.tool,
        event.requested,
        event.accepted,
        event.duration_ms,
        event.outcome,
        event.reason or "-",
    )
    return event


@router.get("/{board_id}/mcp-events", response_model=list[McpEventOut])
async def list_events(
    board_id: uuid.UUID,
    session: Session,
    user: CurrentUser,
    role: Annotated[BoardRole, Depends(board_viewer)],
) -> list[McpEvent]:
    """What assistants have done to this glade, newest first.

    A browser session only. A token reading back the trail of its own edits is a feature
    nobody has asked for, and refusing it keeps the audit trail something a person reads
    rather than something a machine can inspect and work around.
    """
    rows = await session.execute(
        select(McpEvent)
        .where(McpEvent.board_id == board_id)
        .order_by(McpEvent.created_at.desc())
        .limit(_PAGE)
    )
    return list(rows.scalars().all())
