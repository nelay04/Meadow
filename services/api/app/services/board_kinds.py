"""What kind of glade a board is.

A glade is still a glade: one Y.Doc, one flat `objects` map, one infinite canvas, and
the same tools. The kind says what the *paper* is, not what the editor is. That
distinction is the whole reason this is a column and not a second product:
ARCHITECTURE 1 has no page and no document editor, so a "diary" here is a surface a
canvas is drawn on, never a separate stack of pages.

A plain string with a check constraint rather than a native enum, following
`users.avatar_source`. Kinds are expected to be added - the sidebar is built from a
registry precisely so they can be - and adding one should be a one-line constraint
change rather than an `ALTER TYPE` that cannot run inside a transaction on older
Postgres.
"""

from enum import StrEnum


class BoardKind(StrEnum):
    #: The default, and the word for a board generally: bare canvas on graph paper.
    glade = "glade"
    #: A conventional diary: warm aged paper, ruled for writing on.
    lea = "lea"


#: Rendered into the check constraint and the migration. Keep in step with the enum.
BOARD_KINDS = tuple(kind.value for kind in BoardKind)

DEFAULT_BOARD_KIND = BoardKind.glade
