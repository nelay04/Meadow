"""A board's words, as plain text.

The Python side of `richTextToPlain` in `packages/schema/src/graph.ts`: every object's
`text` fragment, one line per block, marks dropped. It exists for search, so it keeps
only what a person might type into a search box and none of the structure.
"""

from dataclasses import dataclass
from typing import Any

from pycrdt import Array, Doc, Map, XmlElement, XmlFragment, XmlText

# Blocks that end a line, as the schema has them. Anything else is inline and runs on.
LINE_BLOCKS = frozenset({"paragraph", "heading", "codeBlock", "blockquote", "listItem"})

# A ceiling on the copy of one board, not on the board. Search needs the words, and a
# board holding more than this much text is a document pasted in whole: its first
# megabyte is enough to find it by, and the whole of it would slow every match down.
MAX_BODY_CHARS = 1_000_000


def _walk(node: XmlFragment | XmlElement | XmlText, out: list[str]) -> None:
    if isinstance(node, XmlText):
        # `diff` rather than `str`: `str` renders marks as tags and does not escape the
        # text between them, so "a < b" in bold cannot be told apart from markup.
        for run, _attrs in node.diff():
            if isinstance(run, str):
                out.append(run)
        return
    if isinstance(node, XmlElement) and node.tag == "hardBreak":
        out.append("\n")
        return
    for child in node.children:
        _walk(child, out)
    if isinstance(node, XmlElement) and node.tag in LINE_BLOCKS:
        out.append("\n")


@dataclass(frozen=True)
class TextPiece:
    """The text of one object, or of one lea page's subject line."""

    object_id: str
    object_type: str
    body: str


def board_text(state: bytes) -> list[TextPiece]:
    """Every piece of text on the board whose merged update is `state`, per object."""
    doc: Doc[Any] = Doc()
    doc.apply_update(state)
    pieces: list[TextPiece] = []
    total = 0

    def add(object_id: str, object_type: str, body: str) -> None:
        nonlocal total
        body = "\n".join(line.strip() for line in body.split("\n") if line.strip())
        if body == "" or total >= MAX_BODY_CHARS:
            return
        body = body[: MAX_BODY_CHARS - total]
        total += len(body)
        pieces.append(TextPiece(object_id, object_type, body))

    objects = doc.get("objects", type=Map)
    for key, value in objects.items():
        if not isinstance(value, Map):
            continue
        fragment = value.get("text")
        if isinstance(fragment, XmlFragment):
            parts: list[str] = []
            _walk(fragment, parts)
            kind = value.get("type")
            add(str(key), kind if isinstance(kind, str) else "object", "".join(parts))

    # A lea's pages carry a subject line of their own, which is written like any other
    # text and looked for like it. Keyed by the page, since it belongs to no object.
    meta = doc.get("meta", type=Map)
    pages = meta.get("pages")
    if isinstance(pages, Array):
        for index, page in enumerate(pages):
            if isinstance(page, Map):
                subject = page.get("subject")
                page_id = page.get("id")
                if isinstance(subject, str):
                    add(f"page:{page_id if isinstance(page_id, str) else index}", "page", subject)
    subject = meta.get("pageSubject")
    if isinstance(subject, str):
        add("page:0", "page", subject)

    return pieces
