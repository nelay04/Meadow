# Meadow MCP server

`meadow-mcp` lets AI assistants and coding agents read and edit your glades as structured
data. It speaks the Model Context Protocol, so any client that supports MCP can use it:
Claude Code, Codex, VS Code (Copilot and the Claude extension), Antigravity, claude.ai,
ChatGPT and Gemini.

The server joins a glade the way a browser does. People with the glade open see edits
arrive live, and the assistant appears among the wanderers while it works.

## 1. Create an access token

In Meadow, open **Profile > Access tokens**, name the token after what will use it, and pick
one of two kinds.

**Classic.** Everything your account can do, on every glade you can open, including
creating and importing glades. Use it for your own agent on your own machine.

**Fine-grained.** Only the glades you pick, each with its own permissions:

| Permission | Allows |
|---|---|
| View | Reading the glade. Always on for a chosen glade; turning Edit or Delete on turns it on |
| Edit | Adding, changing, moving, relabelling and connecting objects |
| Delete | Removing objects |

For example, with glades A to E you might choose A, C and D: view and edit on A, view only
on D, view and delete on C. B and E do not exist for that token. A fine-grained token
cannot create or import glades. You can change a token's glades later with
**Change glades**, and anything using it picks up the change straight away.

The token (`mdw_...`) is shown once. Copy it straight into the client config below.

Whatever the kind, a token can never do more than you can. If your role on a glade is
viewer, or its owner has locked it, the token cannot edit it either. Glades with a password
cannot be opened with a token. Revoking takes effect immediately, including on glades the
token has open.

**The server enforces this, not the assistant.** A fine-grained token without Delete cannot
remove objects even from a hand-written client talking to the websocket directly. The
server replays every change against a copy of the glade first and drops anything the grant
does not allow.

**The assistant knows its boundaries.** When it connects, the MCP server gives it:
- the token's kind and, for a fine-grained token, each glade with its permissions, in the
  server instructions;
- `can_edit` and `can_delete` for each glade in `list_glades`;
- a `get_my_access` tool.

Tools the token cannot use on any glade are not offered at all. For example, a view-only
token does not see `create_nodes` or `delete_objects`. When a call is refused, the refusal
names the missing permission.

## 2. Connect a client

### Local clients (stdio)

These start the server as a subprocess. For a local Meadow, start the local stack first
with `docker compose -f docker-compose.local.yml up -d`. It serves the API at
`http://127.0.0.1:8012`, which is the `MEADOW_API_URL` to use, and the app at
`http://localhost:3012`, where you create the token.

Build the bundle once from the repository:

```bash
pnpm install
pnpm --filter @meadow/mcp build     # writes packages/mcp/dist/meadow-mcp.js
```

Every config below runs `node /path/to/meadow-mcp.js` with two settings:

- `MEADOW_API_URL`: your Meadow address, e.g. `https://meadow.example.com`
- `MEADOW_TOKEN`: your access token

**Claude Code**

```bash
claude mcp add meadow \
  -e MEADOW_API_URL=https://meadow.example.com \
  -e MEADOW_TOKEN=mdw_... \
  -- node /path/to/meadow-mcp.js
```

**VS Code** (`.vscode/mcp.json`, used by Copilot agent mode)

```json
{
  "inputs": [{ "id": "meadow-token", "type": "promptString", "description": "Meadow access token", "password": true }],
  "servers": {
    "meadow": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/meadow-mcp.js"],
      "env": { "MEADOW_API_URL": "https://meadow.example.com", "MEADOW_TOKEN": "${input:meadow-token}" }
    }
  }
}
```

**Codex** (`~/.codex/config.toml`)

```toml
[mcp_servers.meadow]
command = "node"
args = ["/path/to/meadow-mcp.js"]
env = { MEADOW_API_URL = "https://meadow.example.com", MEADOW_TOKEN = "mdw_..." }
```

**Claude Desktop, Antigravity, Cursor and other JSON configs**

```json
{
  "mcpServers": {
    "meadow": {
      "command": "node",
      "args": ["/path/to/meadow-mcp.js"],
      "env": { "MEADOW_API_URL": "https://meadow.example.com", "MEADOW_TOKEN": "mdw_..." }
    }
  }
}
```

### Remote clients (Streamable HTTP)

A deployed Meadow serves the MCP endpoint at `https://<your-host>/mcp` (the `mcp` service
in `docker-compose.yml`, behind nginx). Each connection sends the token as a bearer
header:

```
Authorization: Bearer mdw_...
```

Clients that let you set headers on a remote MCP server can connect today. Examples are
VS Code (`"type": "http"` with a `headers` block) and Claude Code:

```bash
claude mcp add --transport http meadow https://meadow.example.com/mcp \
  --header "Authorization: Bearer mdw_..."
```

The claude.ai and ChatGPT custom connectors sign in with OAuth rather than a pasted
header. Meadow does not offer OAuth yet, so those two cannot connect until it does.

To run the HTTP server yourself, outside compose:

```bash
node meadow-mcp.js --http --api https://meadow.example.com --host 127.0.0.1 --port 8765
```

## 3. What an assistant can do

| Tool | What it does |
|---|---|
| `list_glades` | Glades the token can open, with `can_edit` and `can_delete` for each |
| `get_my_access` | The token's kind, and each glade it can open with its permissions |
| `get_glade_summary` | Size, bounds, counts by type, a sample of labels |
| `get_glade_graph` | Nodes and edges with ids, labels, positions, colours, and what each arrow connects. Paged |
| `find_objects` | Search by label text, type or region |
| `get_objects` | The full stored form of chosen objects |
| `export_glade` | The whole glade as a lossless `.meadow.json` file |
| `export_mermaid` | The glade as a Mermaid flowchart |
| `create_glade` | A new, empty glade |
| `create_nodes` | Add shapes, stickies and text, optionally with edges between them |
| `connect` | Draw arrows or lines between existing objects |
| `update_objects` | Change labels, position, size, rotation, colours, arrow direction and routing |
| `delete_objects` | Remove objects; attached arrows keep a free end |
| `set_text` | Replace an object's text (light Markdown) |
| `apply_diagram` | Draw or extend a diagram from nodes and edges, or from Mermaid |
| `import_glade` | Create a glade from a `.meadow.json` file |

Every write accepts `preview: true`, which returns the plan without changing anything.

Some behaviour to know about:

- **Layout.** Nodes created without `x` and `y` are laid out together (a layered layout)
  and placed to the right of what is already on the glade.
- **Matching.** `apply_diagram` matches a node to an existing object by id, then by exact
  label when exactly one object has that label. It never removes anything the diagram
  does not mention.
- **Atomic calls.** Each call is one transaction: it lands whole, or not at all when any
  id in it is wrong.
- **Undo.** A person's Ctrl+Z in the browser does not undo an assistant's edits, because
  undo only tracks your own changes. To take back an assistant's change, ask it to, or
  delete the objects.
- **Limits.** At most 500 objects per call.

Resources are also published: `meadow://glade/{id}` (the file) and
`meadow://glade/{id}/graph`.

## Try it

> Read the "Checkout flow" glade, explain it, then add a "Fraud check" step between
> Payment and Confirmation.

## Development

```bash
pnpm --filter @meadow/mcp test      # planning, Mermaid, text and graph tests
pnpm --filter @meadow/mcp start -- --api http://127.0.0.1:8012 --token mdw_...
pnpm e2e:mcp                        # real API, the bundle over stdio and HTTP, and a browser
```

The server does not have its own write path. It imports the web app's
`apps/web/src/doc/mutations.ts` and writes through `applyEdits`, so the rules the canvas
follows (z-order, bindings, arrow solving) are the same code.
