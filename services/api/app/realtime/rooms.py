"""Which sockets are open on which board, so a permission change can close them.

The handshake decides once. ARCHITECTURE 6 makes that explicit for the read-only
filter - it is chosen at join time and never re-chosen - and everything downstream of
it inherits the property: a connection that was granted `editor` keeps writing as an
editor until it is torn down and re-evaluated, whatever the database says in the
meantime. The watchdog exists precisely because of that, and closes a socket whose
role has drifted.

The watchdog wakes every fifteen minutes, which is right for the thing it was built
for - a grant quietly revoked, where nobody is watching a clock. It is wrong for the
lock. Somebody presses the lock button because they want the board to stop moving
*now*, in front of other people, and a quarter of an hour of everyone continuing to
type into it is not a slow update, it is the feature not working.

So the sockets on a board are tracked here and closed outright when the thing that
authorised them changes: the lock, the share mode, the link. They reconnect on their
own (`sync/provider.ts` treats 4403 as "re-mint and try again"), and the reconnect
runs the handshake, which is the only place access is ever decided. That is the whole
design: this module never adjusts anybody's permissions, it only ends connections so
the handshake can be asked again.

In-process, like the rooms themselves. A second API instance holds its own sockets and
its own registry, and eviction there arrives with the watchdog. Making this correct
across instances means a pub/sub fan-out, which is the same thing ARCHITECTURE 6 says
about rooms: single-instance for v1, and the shape that would change is documented
rather than half-built.
"""

from collections import defaultdict
from contextlib import suppress
from logging import getLogger

from fastapi import WebSocket

logger = getLogger(__name__)

# Close codes from ARCHITECTURE 6. They live here rather than in `main` because both
# the handshake and the evictor send them, and `main` imports the API router, so a
# router reaching back for a constant there would close the import cycle.
WS_CLOSE_UNAUTHORIZED = 4401  # the credential is bad: forged, expired, or spent
WS_CLOSE_FORBIDDEN = 4403  # the credential is good but does not authorise this board
WS_CLOSE_ROOM_FULL = 4429


class SocketRegistry:
    """Open board sockets, by board id."""

    def __init__(self) -> None:
        self._by_board: dict[str, set[WebSocket]] = defaultdict(set)

    def add(self, board_id: str, websocket: WebSocket) -> None:
        self._by_board[board_id].add(websocket)

    def discard(self, board_id: str, websocket: WebSocket) -> None:
        sockets = self._by_board.get(board_id)
        if sockets is None:
            return
        sockets.discard(websocket)
        # Drop the key rather than leaving an empty set behind. A long-lived process
        # that has served a lot of boards would otherwise accumulate one entry per
        # board it has ever seen.
        if not sockets:
            del self._by_board[board_id]

    def count(self, board_id: str) -> int:
        return len(self._by_board.get(board_id, ()))

    async def evict(self, board_id: str, *, code: int, reason: str) -> int:
        """Close every socket on this board. Returns how many were closed.

        Closing rather than notifying. There is no message a client could be sent that
        would make its already-chosen read-only filter change, and inventing one would
        be a second place access is decided - which is the exact failure ARCHITECTURE 7
        names about roles being computed twice.

        A copy of the set, because closing a socket runs its handler's teardown, which
        calls `discard`.
        """
        sockets = list(self._by_board.get(board_id, ()))
        for websocket in sockets:
            # A socket the peer has already dropped raises from close(); it is on its
            # way out either way, and one dead connection must not stop the rest being
            # evicted.
            with suppress(Exception):  # noqa: BLE001
                await websocket.close(code=code, reason=reason)
        if sockets:
            logger.info("evicted %d socket(s) from board %s: %s", len(sockets), board_id, reason)
        return len(sockets)
