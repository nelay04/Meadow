"""A board's words, as plain text.

The Python side of `richTextToPlain` in `packages/schema/src/graph.ts`: every object's
`text` fragment, one line per block, marks dropped. It exists for search, so it keeps
only what a person might type into a search box and none of the structure.
"""

from typing import Any

from pycrdt import Array, Doc, Map, XmlElement, XmlFragment, XmlText

# Blocks that end a line, as the schema has them. Anything else is inline and runs on.
LINE_BLOCKS = frozenset({"paragraph", "heading", "codeBlock", "blockquote", "listItem"})

# A ceiling on the copy, not on the board. Search needs the words, and a board holding
# more than this much text is a document pasted in whole: its first megabyte is enough
# to find it by, and the whole of it would make every match slower for everybody.
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


def board_text(state: bytes) -> str:
    """Every piece of text on the board whose merged update is `state`."""
    doc: Doc[Any] = Doc()
    doc.apply_update(state)
    lines: list[str] = []

    objects = doc.get("objects", type=Map)
    for value in objects.values():
        if not isinstance(value, Map):
            continue
        fragment = value.get("text")
        if isinstance(fragment, XmlFragment):
            parts: list[str] = []
            _walk(fragment, parts)
            lines.extend(line.strip() for line in "".join(parts).split("\n"))

    # A lea's pages carry a subject line of their own, which is written like any other
    # text and looked for like it.
    meta = doc.get("meta", type=Map)
    pages = meta.get("pages")
    if isinstance(pages, Array):
        for page in pages:
            if isinstance(page, Map):
                subject = page.get("subject")
                if isinstance(subject, str):
                    lines.append(subject.strip())
    subject = meta.get("pageSubject")
    if isinstance(subject, str):
        lines.append(subject.strip())

    return "\n".join(line for line in lines if line)[:MAX_BODY_CHARS]
