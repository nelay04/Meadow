/**
 * Who may write to a document.
 *
 * Defined here rather than beside the REST client because the document layer is what
 * acts on it: `createDocSession` takes a role and `roleCanWrite` is the gate every
 * mutation passes. The API clients in the app and in the MCP server both re-export
 * this, so the four spellings cannot drift apart - they were two identical copies
 * before this package existed.
 *
 * The server is the authority regardless. This is the client-side half of a decision
 * `app/services/permissions.py::resolve_role` has already made, and a tampered value
 * here buys nothing: the websocket handshake re-resolves the role and a viewer's
 * writes are dropped server-side whatever the browser believes.
 */
export type BoardRole = 'owner' | 'editor' | 'commenter' | 'viewer'
