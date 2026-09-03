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


#: What one board of each kind is called, in a sentence. Sentence case because these
#: are common nouns: "invited you to a lea", not "invited you to a Lea".
#:
#: Mirrors the `label` in `apps/web/src/features/boards/kinds.ts`. It is duplicated
#: rather than served because the only thing that reads it here is outgoing mail, which
#: is composed on the server and has to name the thing it is about.
KIND_NOUNS: dict[str, str] = {
    BoardKind.glade: "glade",
    BoardKind.lea: "lea",
}


def noun(kind: str) -> str:
    """The word for one board of this kind, falling back to the default's.

    Falling back rather than raising, for the same reason the client does: a kind this
    build has not heard of should still produce a readable sentence.
    """
    return KIND_NOUNS.get(kind, KIND_NOUNS[DEFAULT_BOARD_KIND])
