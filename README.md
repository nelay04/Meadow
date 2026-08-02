# Meadow

An infinite-canvas collaborative notes app: OneNote-style freeform editing combined
with FigJam-style whiteboarding. Text, shapes, arrows, tables, and charts all live as
objects on one shared surface.

A board is called a **field**. Remote cursors are **wanderers**.

> **Status: M1 complete.** Realtime foundation proven, auth and permissions in place.
> There is no canvas yet — that is M2. See [Build status](#build-status).

---

## The idea

**There is no page. There is only the canvas.** Everything a user creates is an object
at an (x, y) position on an infinite surface. A note is not a document, it is a text
object placed somewhere. That gives one object model, one selection system, one
transform system, one undo stack, and one CRDT document per board.

Rich text cannot be edited inside WebGL, so the canvas is two layers sharing a single
camera: a PixiJS/WebGL layer for shapes, arrows, and ink, and a DOM overlay for text,
tables, and charts. Both read the same camera matrix and must never drift.

Full design, schema, and milestone order: [`docs/core/ARCHITECTURE.md`](docs/core/ARCHITECTURE.md).

---

## Stack

| Layer | Choice |
|---|---|
| Frontend | React 19, TypeScript, Vite 6, PixiJS 8, TipTap 2, yjs, rbush, Zustand, Tailwind 4 |
| Realtime | yjs CRDT over websocket, y-indexeddb for offline, awareness for presence |
| Backend | FastAPI, pycrdt + pycrdt-websocket (Rust-backed yjs bindings), SQLAlchemy 2 async, Alembic, arq |
| Auth | argon2id, JWT access tokens, rotating refresh tokens with reuse detection |
| Data | PostgreSQL 16, Redis 7, MinIO |
| Infra | Docker Compose, nginx, GitHub Actions to GHCR to VPS |

Fonts: Inter for UI and default text objects, Comic Neue as a text-object option,
JetBrains Mono for code. Self-hosted woff2, no CDN.

---

## Build status

Milestones ship in order; a milestone does not start before the previous one works.

| Milestone | Scope | Status |
|---|---|---|
| M0 | Realtime spike: ws auth, CRDT convergence, Postgres persistence | Complete |
| M1 | Auth and boards CRUD, JWT with refresh rotation, permissions | Complete |
| M2 | Canvas core: camera, shapes, hit-testing, transforms, undo | Next |
| M3 | Text objects: DOM overlay, TipTap per object, sticky notes | Not started |
| M4 | Arrows and bindings | Not started |
| M5 | Realtime polish: awareness, compaction job, thumbnails | Not started |
| M6 | Ship v1 | Not started |

M0 was a gate, not a feature. Its job was to answer one question before any canvas
code existed: does a Python CRDT backend actually carry this workload, or does the
project need Node and Hocuspocus? The answer is that Python carries it.

### What M0 proves

Run it yourself with `./scripts/m0-gate.sh`:

```
== phase: convergence
PASS  client A connected with a valid ws-token
PASS  client B converged on A's 3 objects (saw 3)
PASS  client A saw B's object (4 objects)

== restarting api (cold process, nothing retained in memory)

== phase: persistence across restart
PASS  state reloaded from Postgres after full server restart (4 objects)
PASS  object contents intact: diamond, ellipse, rect, sticky

== phase: offline edit and reconnect
PASS  offline edit applied locally while disconnected
PASS  offline edit reached a fresh client after reconnect (5 objects)

== phase: handshake rejection
PASS  replayed ws-token rejected with 4401 (got 4401)
PASS  invalid ws-token rejected with 4401 (got 4401)
PASS  missing ws-token rejected with 4401 (got 4401)
```

The harness drives real `yjs` clients over the wire, so this tests genuine
JavaScript-to-pycrdt wire compatibility rather than pycrdt talking to itself. The
restart phase kills the server process entirely and starts a cold one; reloading after
a mere client reconnect would prove nothing, since the document would still be in
server memory.

## What M1 adds

Users, workspaces, boards, membership, and the permission layer the handshake needs
to stop being a stub.

**The five rejection paths were written as failing tests before the implementation.**
That ordering is the point: tests written afterwards get shaped by the code and pass
without proving anything.

| The socket must refuse | Close code |
|---|---|
| Valid token, real board, caller has no membership | 4403 |
| Token minted for board A, presented to board B | 4403 |
| Board deleted between mint and connect | 4403 |
| Access token expires mid-session | 4401, watchdog closes the live socket |
| Unknown board id (never distinguished from "no access") | 4403 |

Plus the viewer story, both halves together: the server drops a viewer's document
writes, and the client is told its role at mint time so it disables the tools and
refuses the write in `doc/mutations.ts`. Server-side dropping alone is not enough —
a viewer's own `Y.Doc` still applies their edits locally, so they would watch them
appear, survive a refresh via IndexedDB, and then vanish. That is the first bug report
a demo user files.

```bash
cd services/api && .venv/bin/python -m pytest    # 35 tests
```

Also in M1: argon2id passwords, refresh-token rotation with reuse detection, citext
emails, Redis rate limits, Alembic owning the schema, and a React app with
login/register and a board list.

### What is still deliberately missing

No canvas and no rendering — that is M2. The board view is a table of objects with
buttons, exercising the real CRDT schema and the real provider so M2 replaces the
rendering and nothing underneath it. Share links, assets, and comments are later
milestones.

---

## Running it

Requires Docker, Node 22+, pnpm, Python 3.13, and uv.

```bash
cp .env.example .env          # ports and credentials live here
docker compose up -d          # postgres, redis, pgadmin

cd services/api
uv venv --python 3.13
uv pip install -e . --group dev
.venv/bin/alembic upgrade head    # Alembic owns the schema from M1
cd ../..

pnpm install
```

Then two terminals:

```bash
# API
cd services/api && .venv/bin/python -m uvicorn app.main:app --port 8012

# web
pnpm --filter web dev
```

| Service | URL |
|---|---|
| Web app | http://localhost:3012 |
| API | http://localhost:8012 |
| API docs | http://localhost:8012/docs |
| pgAdmin | http://localhost:5051 |
| Postgres | localhost:5435 (`meadow`, and `meadow_test` for the suite) |
| Redis | localhost:6380 (db 0 dev, db 1 tests) |

Ports are read from `.env` by docker-compose, the API (via pydantic-settings), and
Vite alike, so there is one place to change them. Postgres sits on 5435 and Redis on
6380 to avoid colliding with native instances commonly already running on the
default ports.

Register an account, create a field, and open it. To see convergence, open the same
field in two browsers (two tabs of the same browser also work, but they sync through a
BroadcastChannel as well as the server, so a tab pair cannot tell you whether the
server is doing its job). To see persistence, stop the API, restart it, and reload.

### Tests and checks

```bash
cd services/api
.venv/bin/python -m pytest                 # 35 tests, against real Postgres and Redis
.venv/bin/ruff check . && .venv/bin/mypy app/

pnpm --filter web lint

./scripts/m0-gate.sh                       # end-to-end, restarts the server mid-run
node scripts/m0-gate.mjs seed|verify|offline|reject   # individual phases
```

The test suite creates and migrates a `meadow_test` database and uses Redis db 1, so
it never touches dev data. The M0 gate stays scoped to the foundation over a real
socket with the real `y-websocket` client; M1's permission assertions live in pytest,
which can set up ten users far more cheaply.

---

## Layout

```
apps/web/
  src/doc/             CRDT schema, mutations (every Y.Doc write), useObjects
  src/sync/            provider setup, reconnection, token minting
  src/features/        auth, boards list, board view
  src/lib/api.ts       REST client, access token in memory only
services/api/
  app/api/v1/          REST routers
  app/auth/            password hashing, JWT, refresh rotation, dependencies
  app/realtime/        ws endpoint, room manager, Postgres YStore, ws-tokens, guard
  app/services/        permissions.py (the single authority), rate limiting
  alembic/             migrations
  tests/               handshake, auth, permissions, persistence
docs/core/             ARCHITECTURE.md, the source of truth
scripts/               M0 gate harness
docker/                nginx and pgadmin config
```

`apps/web/src/canvas/` must never import from `src/features/`. The engine stays
independent and extractable.

---

## Decisions worth knowing

These are the ones that are expensive to reverse, so they were settled before any code
was written.

**A flat `objects` map with `parentId` pointers, not a nested tree.** Nested `Y.Map`
trees make reparenting (dragging a shape into a frame) a delete-and-recreate, which
loses concurrent edits. A flat map makes it a single field write.

**`Y.XmlFragment` for text, not a string field.** It is what `y-prosemirror` binds to.
Two users typing in the same text object merge character by character; a plain string
would last-write-wins and drop keystrokes.

**The websocket handshake is the security boundary.** Validate the token, resolve the
board role, and reject before joining the room. REST permission checks are decorative
if this is wrong, which is why its rejection paths were the first tests written.

**Compaction never derives its read set from a watermark.** Postgres sequences are
non-transactional, so a row holding `id=98` can commit after one holding `id=99`. A
compaction that folds everything `<= max(id)` and records that as a high-water mark
strands the late row permanently, and a room load filtering on it never sees the row
again. Instead, compaction deletes exactly the rows it folded and room load reads
every surviving row with no id filter. `up_to_update_id` is kept as a diagnostic
column only. Yjs updates are commutative and idempotent, so a duplicate re-apply is
harmless while a lost update is not.

**Single-use ws-tokens require driving reconnection manually.** `y-websocket` composes
its URL once and retries on its own schedule, so its built-in reconnect would replay a
spent token forever. `apps/web/src/sync/provider.ts` disables autoconnect and mints a
fresh token per attempt with capped backoff.

**Tokens carry identity, never authorisation.** The access token does not contain
`workspace_ids` and the ws-token does not contain a role, both departures from the
original spec. Memberships in a bearer token are authorisation data that is stale by
design: a user removed from a workspace would keep access until their token expired.
Roles are resolved live from the database on every request and at every connect, by
one function — `app/services/permissions.py`. The ws-token does carry its parent
access token's expiry, so a connection can never outlive the session that authorised
it.

**Compaction takes a Postgres advisory lock, not a Redis one.** `pg_advisory_xact_lock`
releases on commit or rollback, so a worker killed mid-run cannot strand a board behind
a TTL, and the lock lives in the same transaction as the work it guards — a separate
Redis TTL can lapse while the compaction transaction is still open. The key uses the
two-int form with a namespace constant rather than truncating the board uuid into the
single-bigint form; collisions only cost two unrelated boards serialising against each
other, but they are near-undiagnosable after the fact.

### Known sharp edges

- Local undo can resurrect an object that a remote user deleted. This is inherent to
  `Y.UndoManager` and Figma behaves the same way. Accepted and documented rather than
  worked around.
- `pycrdt-websocket` 0.16 dropped the server-level `ystore` argument; persistence is
  per-room, so `MeadowWebsocketServer.get_room` attaches the store and loads state
  before the room starts.
- **`YRoom.stop()` cancels in-flight store writes.** It cancels the task group that
  `ystore.write` was spawned on, without waiting — and with `auto_clean_rooms` on, the
  last client leaving stops the room. So an update that arrived moments earlier races
  its own persistence and loses: type, close the tab, edit gone. `PostgresYStore.write`
  shields its transaction from cancellation. This survived M0 only because real clients
  stayed connected long enough for the write to win the race.
- **`WebsocketServer.delete_room` is not idempotent**, and `serve` calls it whenever
  the client it was serving was the last one out. Two clients disconnecting together
  both observe an empty client set, and the second raises `ValueError` out of the
  teardown path of an ordinary disconnect. `MeadowWebsocketServer` overrides it.
- Two tabs of the same browser sync through a `BroadcastChannel` as well as the
  server, so a tab pair cannot verify server behaviour. Use two browsers, or
  `disableBc: true`.

---

## License

Not yet chosen.
