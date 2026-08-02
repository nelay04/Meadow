# Meadow — Architecture & Implementation Plan

> **Meadow** — an infinite-canvas collaborative notes app: OneNote-style freeform
> editing combined with FigJam-style whiteboarding. Text, tables, shapes, arrows,
> charts, and diagrams all live as objects on one shared surface.
>
> Naming: repo/package slug `meadow`, board unit called a **field**, cursor presence
> called **wanderers**. Dev deploy at `meadow.creara.in`. Tagline: *an open field for
> your ideas.*
>
> This document is the source of truth for Claude Code. Read it before writing code.
> If a decision here conflicts with something you'd do by default, follow this doc
> or raise the conflict explicitly.

---

## 0. Core mental model

**There is no page. There is only the canvas.**

Everything the user creates is an *object* positioned on an infinite 2D surface.
A "note" is not a document — it is a text object placed at (x, y). A table is an
object. A chart is an object. This is the OneNote/FigJam model, and it means:

- One object model
- One selection system
- One transform (move/resize/rotate) system
- One undo stack
- One CRDT document per board

Do **not** build a document editor and a canvas as separate features. Text editing
is a mode that activates on a text-bearing object.

### Two-layer rendering

Rich text cannot be edited inside WebGL — no caret, no selection, no IME, no
accessibility. So the canvas is two synchronised layers sharing one camera:

```
┌─────────────────────────────────────────┐
│  DOM overlay  (z-index above)           │  text objects, tables, charts,
│  absolutely-positioned elements         │  active TipTap editors
├─────────────────────────────────────────┤
│  PixiJS / WebGL canvas                  │  shapes, arrows, ink, connectors,
│                                         │  selection handles, grid
└─────────────────────────────────────────┘
         ↑ both transformed by the same camera matrix
```

Camera state lives in one place. Both layers read it. They must never drift.

---

## 1. Stack

### Frontend — `apps/web`

| Concern | Choice | Notes |
|---|---|---|
| Framework | React 19 + TypeScript | strict mode on |
| Build | Vite 6 | not Next.js — app is behind auth, nothing to SSR |
| Canvas renderer | PixiJS 8 | WebGL; Canvas2D fallback not required |
| Text editing | TipTap 2 (ProseMirror) | one instance per active text object |
| CRDT | yjs | document state lives here, not in React |
| CRDT ↔ editor | y-prosemirror | binds `Y.XmlFragment` to TipTap |
| Offline | y-indexeddb | local persistence + offline edits |
| Transport | y-websocket client | talks to FastAPI ws endpoint |
| Spatial index | rbush | R-tree for hit-testing and viewport culling |
| UI state | Zustand | **UI only** — never document data |
| Styling | Tailwind 4 | |
| Charts | Recharts | rendered into DOM overlay |
| Forms/validation | react-hook-form + zod | |
| Tests | Vitest + Playwright | |

### Typography

| Role | Family | Notes |
|---|---|---|
| UI chrome | Inter | toolbars, panels, menus, board list. Variable weight. |
| Text objects | Inter (default) + Comic Neue (option) | user-selectable per object, stored in `props.fontFamily` |
| Code | JetBrains Mono | code blocks inside text objects, and any monospace UI |

Self-host all three as woff2 under `apps/web/public/fonts` with `font-display: swap`.
No Google Fonts CDN: the app is behind auth on a single VPS, and a third-party font
request on every board load is a needless dependency and a privacy leak.

Fonts are a canvas concern, not just CSS. Text objects are measured in the DOM overlay
and their bounding boxes are written into the CRDT, so a font that loads late changes
`w`/`h` after the fact and shifts layout for everyone. Preload the two text-object
faces (`<link rel="preload">`) and gate first canvas render on `document.fonts.ready`.
Adding a text-object face later is a schema-visible decision, not a style tweak.

### Backend — `services/api`

| Concern | Choice | Notes |
|---|---|---|
| Framework | FastAPI | REST + WebSocket in one app |
| CRDT server | pycrdt + pycrdt-websocket | Rust-backed Yjs bindings, wire-compatible |
| ORM | SQLAlchemy 2.0 (async) | |
| Migrations | Alembic | |
| DB | PostgreSQL 16 | |
| Cache/queue | Redis 7 | job broker, presence, rate limits |
| Jobs | arq | async-native, same codebase as API |
| Auth | python-jose + argon2-cffi | JWT + password hashing |
| Object storage | MinIO (S3 API) | images, attachments, exports |
| Validation | Pydantic v2 | |
| Tests | pytest + pytest-asyncio + httpx | |

### Infra

Docker Compose · nginx · GitHub Actions → GHCR → VPS over SSH · Sentry · structured JSON logs

---

## 2. Repository layout

Single **public** monorepo. pnpm workspaces for JS, uv for Python.

Two JS packages: `apps/web` and `packages/schema`. The schema package holds the CRDT
document types and Zod validators — imported by the web app, and mirrored (not shared)
in Python for export rendering.

```
meadow/
├── apps/
│   └── web/
│       ├── src/
│       │   ├── canvas/          # engine — camera, renderer, hit-test, tools
│       │   │   ├── engine.ts
│       │   │   ├── camera.ts
│       │   │   ├── spatial-index.ts
│       │   │   ├── renderers/   # one per shape type
│       │   │   └── tools/       # select, rect, arrow, text, pen...
│       │   ├── overlay/         # DOM layer — text, tables, charts
│       │   ├── doc/             # yjs schema helpers, mutations, undo
│       │   ├── sync/            # provider setup, awareness, offline
│       │   ├── features/        # auth, boards list, sharing, settings
│       │   ├── components/      # shared UI
│       │   └── lib/
│       └── tests/
├── packages/
│   └── schema/              # CRDT doc types + Zod validators (TS)
│       └── src/
│           ├── objects.ts   # ObjectType, BaseObject, per-type props
│           ├── bindings.ts
│           └── index.ts
├── services/
│   └── api/
│       ├── app/
│       │   ├── main.py
│       │   ├── config.py
│       │   ├── db.py
│       │   ├── models/          # SQLAlchemy
│       │   ├── schemas/         # Pydantic
│       │   ├── api/v1/          # REST routers
│       │   ├── auth/            # jwt, deps, password, refresh rotation
│       │   ├── realtime/        # ws endpoint, room manager, ystore
│       │   ├── workers/         # arq tasks
│       │   └── services/        # business logic
│       ├── alembic/
│       └── tests/
├── docker/
│   ├── nginx/nginx.conf
│   └── api/Dockerfile
├── docker-compose.yml           # dev
├── docker-compose.prod.yml
├── .github/workflows/ci.yml
└── README.md
```

**Rule:** `apps/web/src/canvas` must not import from `features/`. The engine is
independent of the app shell and should be extractable.

---

## 3. Data model (PostgreSQL)

Relational tables hold *metadata and permissions*. Board **content** lives in the
CRDT blob, not in normalised tables. Do not try to mirror canvas objects into SQL.

```
users
  id              uuid pk
  email           citext unique not null
  password_hash   text not null
  display_name    text not null
  avatar_url      text
  created_at      timestamptz
  updated_at      timestamptz

refresh_tokens
  id              uuid pk
  user_id         uuid fk -> users on delete cascade
  token_hash      text not null          -- sha256 of the raw token
  family_id       uuid not null          -- rotation lineage
  expires_at      timestamptz not null
  revoked_at      timestamptz
  user_agent      text
  ip              inet
  index (user_id), index (token_hash)

workspaces
  id, name, slug unique, owner_id fk -> users, created_at

workspace_members
  workspace_id, user_id, role enum(owner|admin|member), joined_at
  pk (workspace_id, user_id)

boards
  id              uuid pk
  workspace_id    uuid fk -> workspaces
  title           text not null default 'Untitled'
  created_by      uuid fk -> users
  thumbnail_url   text
  is_archived     bool default false
  created_at, updated_at
  index (workspace_id, is_archived)

board_members                            -- per-board override of workspace role
  board_id, user_id, role enum(owner|editor|viewer|commenter)
  pk (board_id, user_id)

board_updates                            -- append-only Yjs update log
  id              bigserial pk
  board_id        uuid fk -> boards on delete cascade
  update          bytea not null
  created_at      timestamptz default now()
  index (board_id, id)

board_snapshots                           -- compacted state vectors
  id              uuid pk
  board_id        uuid fk -> boards
  state           bytea not null
  up_to_update_id bigint not null         -- DIAGNOSTIC ONLY, never filter loads by it
  created_at      timestamptz not null default now()   -- load + prune order both key on this
  index (board_id, created_at desc)

share_links
  id, board_id, token unique, role enum(viewer|editor),
  expires_at, created_by, revoked_at

assets
  id, board_id, uploader_id, s3_key, mime, size_bytes, width, height, created_at
```

### Persistence strategy

1. Every Yjs update arriving on the websocket is appended to `board_updates`.
2. A background job (or a threshold of N surviving updates) merges updates into a new
   `board_snapshots` row and deletes the exact rows it folded.
3. On room load: read the latest snapshot + **all surviving `board_updates` rows** for
   the board. No id filter.

**Compaction must not derive its read set from a watermark — this is a silent
data-loss bug.** Postgres sequences are non-transactional: `nextval()` is handed out
at insert time, so a transaction holding `id=98` can commit *after* one holding
`id=99`. A compaction that reads `max(id) = 99`, folds rows `<= 99`, and records
`up_to_update_id = 99` will never see row 98 — and a room load filtering
`id > up_to_update_id` skips it forever. A per-board lock does not help; it
serialises compactions against each other, not against live writers.

The fix is cheap because Yjs updates are commutative and idempotent — delete exactly
the rows you folded, and read everything that survives:

```sql
-- COMPACTION — one transaction, and the order matters
BEGIN;
  SELECT pg_advisory_xact_lock(:ns, :board_key);   -- see "Serialise compaction" below
  -- (rows were SELECTed and merged in application code -> :merged_ids)
  INSERT INTO board_snapshots (board_id, state, up_to_update_id) VALUES (...);
  DELETE FROM board_updates  WHERE board_id = :b AND id = ANY(:merged_ids);
  DELETE FROM board_snapshots WHERE board_id = :b
    AND id NOT IN (SELECT id FROM board_snapshots WHERE board_id = :b
                   ORDER BY created_at DESC LIMIT 3);
COMMIT;

-- ROOM LOAD — latest snapshot + ALL surviving update rows, no id filter
SELECT update FROM board_updates WHERE board_id = :b ORDER BY id;
```

**Insert the snapshot before deleting the folded rows, in one transaction.** A crash
between them costs a harmless duplicate re-apply. Delete-first — or the same two
statements in separate transactions — loses updates permanently.

**Prune old snapshots in that same transaction.** Each row is full document state, so
one snapshot per compaction run grows faster than the update log it replaced, which
defeats the point. Keep the last 3 as a hedge against a corrupt write.

A late-committing row is simply picked up on the next load rather than stranded, and
re-applying an update already folded into the snapshot is harmless.

> `up_to_update_id` is a **diagnostic column only**. Do not filter room loads by it.
> Reintroducing that filter reintroduces the bug.

**Serialise compaction runs with a Postgres transaction-level advisory lock, not a
Redis one.** `pg_advisory_xact_lock` releases on commit *or* rollback, so a worker that
is OOM-killed mid-run cannot strand a board behind a TTL that has to expire before the
next attempt. It also puts the lock in the same transaction as the work it guards, which
removes the lock/work split-brain a separate Redis lock allows — a Redis TTL can lapse
while the compaction transaction is still open, letting a second worker start.

Advisory lock keys are `bigint`, or a pair of `int4`. `board_id` is a uuid, so it has
to be hashed down either way. Use the **two-int form with a namespace constant** —
`pg_advisory_xact_lock(:ns, :board_key)` — rather than truncating the uuid into the
single-bigint form. The namespace keeps compaction's key space from colliding with any
other advisory lock added later, and the intent is legible in `pg_locks`. Collisions
within the namespace are benign, two unrelated boards simply serialise against each
other, but they are close to undiagnosable after the fact, so do not make them more
likely than the hash already does.

Derive `board_key` in application code (a stable digest of the uuid bytes), not with
Postgres's internal `hashtext`, which carries no cross-version stability guarantee.

**This compaction job is not optional.** Yjs update logs grow without bound and
will fill the VPS disk. Build it in Milestone 5, not "later".

---

## 4. CRDT document schema

**Lock this down before writing canvas code.** It is the one decision that is
expensive to change later.

```ts
// packages/schema — shared types (TS side; mirror in Python for exports)

Y.Doc {
  "objects":  Y.Map<ObjectId, Y.Map<...>>   // FLAT, not nested
  "bindings": Y.Map<BindingId, Y.Map<...>>  // arrow ↔ object attachments
  "order":    Y.Array<ObjectId>             // z-order, index = depth
  "meta":     Y.Map<...>                    // title, background, grid settings
}
```

### Object

Objects are `Y.Map`s at runtime. The shape below is **descriptive** — it is not the
type you write in `packages/schema`. That package should export a plain-fields
`ObjectData` type (for validation, exports, and tests) plus typed accessors that read
and write the underlying `Y.Map`. Decide this before M2, not during it.

```ts
type BaseObject = {
  id: string            // nanoid(12)
  type: ObjectType
  x: number             // canvas coords, not screen
  y: number
  w: number
  h: number
  rotation: number      // radians
  opacity: number
  locked: boolean
  parentId: string | null   // frame/group membership
  createdBy: string
  props: Y.Map          // type-specific
  text?: Y.XmlFragment  // ONLY on text-bearing types
}

type ObjectType =
  | 'text' | 'sticky' | 'rect' | 'ellipse' | 'diamond' | 'triangle'
  | 'line' | 'arrow' | 'freedraw' | 'image'
  | 'table' | 'chart' | 'frame' | 'embed'
```

**Why flat:** nested `Y.Map` trees make reparenting (dragging an object into a
frame) require delete+recreate, which loses concurrent edits. A flat map with a
`parentId` pointer makes reparenting a single field write.

**Why `Y.XmlFragment` for text:** it is what `y-prosemirror` binds to. Two users
typing in the same text object merge character-by-character. A plain string field
would last-write-wins and lose keystrokes.

### Bindings

Arrows attach to objects rather than storing absolute endpoints, so an arrow
follows its shape when moved:

```ts
type Binding = {
  id: string
  arrowId: string
  end: 'start' | 'end'
  targetId: string | null      // null = free-floating endpoint
  anchor: { nx: number, ny: number }   // normalised 0..1 within target bounds
  gap: number                  // px standoff from target edge
}
```

Deleting an object must null out bindings that reference it — the arrow survives
as a free endpoint rather than disappearing.

### Undo

Use `Y.UndoManager` scoped to the local client's origin, tracking `objects`,
`bindings`, and `order`. Do **not** hand-roll an undo stack — it will diverge from
CRDT state under concurrency.

Known sharp edge to document in the README: local undo can resurrect an object a
remote user deleted. Accept it, document it; Figma has the same behaviour.

---

## 5. Canvas engine

### Camera

```ts
type Camera = { x: number, y: number, zoom: number }

screen = (world - camera.xy) * zoom
world  = screen / zoom + camera.xy
```

Zoom range 0.1 → 8. Zoom to cursor, not to viewport centre. The DOM overlay applies
the same transform via CSS: `transform: translate(...) scale(...)` on a wrapper,
with `transform-origin: 0 0`.

### Rendering loop

- Never render on every state change. Mark dirty, render once per rAF.
- Viewport culling: query the R-tree for objects intersecting the visible rect.
- Target: 60fps with 5,000 objects on screen, 20,000 in document.

**Batching caveat — read before writing the renderer.** A `Container` + `Graphics`
per object is the obvious structure and it breaks PixiJS's batching: each `Graphics`
becomes its own draw call, and you will not hit 5k at 60fps. Plan for:

- Shared geometry + instancing for repeated primitives (rects, ellipses, stickies)
- Sprite-based rendering from a texture atlas for simple shapes
- One `Graphics` reserved for genuinely irregular paths (freedraw, custom arrows)
- Batch by material/blend state, not by logical object

Prototype the renderer against 5k objects on day one of M2. Discovering this at the
milestone exit means rewriting the renderer.

### Hit-testing

`rbush` gives you candidate objects by bounding box; then run precise per-type
tests (point-in-polygon for shapes, distance-to-segment for arrows/lines with a
tolerance of ~8px at zoom 1). Test in reverse z-order, return the first hit.

### Tools (state machine)

One active tool at a time. Each implements:

```ts
interface Tool {
  onPointerDown(e: CanvasPointerEvent): void
  onPointerMove(e: CanvasPointerEvent): void
  onPointerUp(e: CanvasPointerEvent): void
  onKeyDown(e: KeyboardEvent): void
  cursor: string
}
```

Tools: `select` `hand` `text` `sticky` `rect` `ellipse` `diamond` `arrow` `line`
`freedraw` `frame` `table` `image` `laser`

### Selection & transform

- Click to select, shift-click to add, drag-marquee for area select
- 8 resize handles + rotation handle
- Shift = preserve aspect, Alt = resize from centre
- Snapping: object edges/centres, spacing guides, grid — with a 5px threshold
- Multi-select transforms operate on the union bounding box

### DOM overlay

**Layer drift is the hard part, not the mounting.** CSS `transform: scale()` and your
WebGL camera matrix disagree at fractional zoom levels, and browsers round subpixel
positions differently. The symptom is text sitting 1–2px off its shape border at
zoom 1.37 — which reads as "broken app" rather than "minor bug". Mitigations:

- Derive overlay transforms from the *same* camera object, never a parallel copy
- Snap the composed transform to device pixels: `Math.round(v * dpr) / dpr`
- Set `will-change: transform` and avoid nested transformed ancestors
- Test explicitly at zoom 0.33 / 0.67 / 1.37 / 2.5, not just 1 and 2

Budget real time for this in M3.

Only mount overlay elements for objects **in the viewport**. A board with 500 text
objects must not create 500 contenteditable nodes.

Text object lifecycle:
1. Idle → rendered as static HTML in the overlay
2. Double-click → mount a TipTap instance bound to that object's `Y.XmlFragment`
3. Blur/Escape → destroy the instance, revert to static HTML

Tables are real `<table>` elements in the overlay. Each cell's content is a
`Y.XmlFragment` in the table object's `props`. Do not reimplement cell editing on
canvas.

---

## 6. Backend

### REST API (`/api/v1`)

```
POST   /auth/register           { email, password, display_name }
POST   /auth/login              -> { access_token, refresh_token }
POST   /auth/refresh            rotates; reuse detection revokes family
POST   /auth/logout
GET    /auth/me

GET    /workspaces
POST   /workspaces
GET    /workspaces/{id}/members
POST   /workspaces/{id}/members
DELETE /workspaces/{id}/members/{user_id}

GET    /boards?workspace_id=&archived=
POST   /boards
GET    /boards/{id}                   metadata only, not content
PATCH  /boards/{id}                   title, archive
DELETE /boards/{id}
POST   /boards/{id}/duplicate
GET    /boards/{id}/members
POST   /boards/{id}/members
POST   /boards/{id}/share-links
DELETE /share-links/{id}

POST   /boards/{id}/assets            presigned MinIO upload
POST   /boards/{id}/export            { format: pdf|png|svg } -> job id
GET    /jobs/{id}

POST   /ws-token                      short-lived (60s) token for ws handshake
```

### WebSocket

```
/ws/board/{board_id}?token=<ws_token>
```

Handshake sequence — **this is the security boundary**:

1. Accept connection
2. Validate `ws_token` (60s TTL, single-use, scoped to one board_id)
3. Resolve the user's effective role on the board — **live, at connect time**, never
   from a role baked into the token. The 60s lifetime is a window in which access can
   be revoked or the board deleted.
4. Reject with close code 4403 if no access
5. Reject with 4401 if the token is invalid/expired
6. Join the pycrdt room; attach role to the connection
7. If role is `viewer`, drop inbound updates (accept awareness only)

**4401 means the credential is bad; 4403 means it is good but does not authorise this
board.** The split matters for a token presented to the wrong board: it is authentic
and unexpired, so 4401 would tell a client holding a perfectly valid token to go and
refresh it, which cannot help, and would bury a real access violation in ordinary
expiry noise. Scope mismatch is checked *before* the token is consumed, so presenting
A's token to board B does not burn it for the legitimate holder.

Never distinguish "no access" from "no such board" — same 4403 for both, or the
socket becomes an oracle for which board ids exist.

**Server-side dropping is defense-in-depth, not the UX.** A viewer's local Y.Doc still
applies their own edits — they will see changes appear, persist, and then silently
vanish on reload. The handshake must return the resolved role to the client, and the
client must disable the tool palette and refuse writes in `doc/mutations.ts`. Build
both halves together in M1; don't leave the client half for M5.

Re-validate every 15 minutes, **and whenever the access token behind the connection
expires, whichever comes first**. Otherwise the handshake is a one-time check: a
socket held open for days keeps the role it was granted on day one, and revoking
access does nothing until the user happens to reconnect. The watchdog closes on 4401
when the session lapses and 4403 when the role changes; either way the client
reconnects and is re-evaluated from scratch.

**The websocket is the door.** REST permission checks are decorative if this is
wrong. Write tests for it first — see `services/api/tests/test_ws_handshake.py`,
which was written before the implementation.

### Room manager

```python
class RoomManager:
    # board_id -> Room
    # Room owns: YDoc, connected clients, awareness, dirty flag
    async def get_or_create(board_id) -> Room   # loads snapshot + tail updates
    async def close_if_empty(board_id)          # persist, then evict after 30s grace
```

- Persist updates debounced: every 2s of quiet, or every 50 updates, whichever first
- Always persist on last-client-disconnect
- Cap: reject a room join beyond 50 concurrent clients

⚠️ **"Always persist on last-client-disconnect" is not free with pycrdt-websocket.**
`YRoom` spawns each store write on the *room's* task group, and `YRoom.stop()` cancels
that group without waiting for its children. With `auto_clean_rooms` on, the last
client leaving stops the room — so an update that arrived moments earlier races its own
persistence and loses. A user types, closes the tab, and the edit is gone on reload.
`PostgresYStore.write` therefore shields its transaction from cancellation. Regression
test: `tests/test_persistence.py::test_last_client_disconnect_persists_the_update`.

Also note `WebsocketServer.delete_room` is not idempotent, and `serve` calls it
whenever the client it was serving was the last one out — two clients disconnecting
together both see an empty client set and the second raises out of the teardown path.
`MeadowWebsocketServer` overrides it.

### Background jobs (arq)

| Job | Trigger |
|---|---|
| `compact_board(board_id)` | `count(*)` of surviving `board_updates` > 500, or nightly |
| `generate_thumbnail(board_id)` | 5 min after last edit, debounced |
| `export_board(board_id, format)` | on request |
| `index_board_text(board_id)` | after compaction — tsvector for search |
| `cleanup_expired_tokens()` | hourly cron |

---

## 7. Auth specifics

- Passwords: argon2id
- Access token: JWT, 15 min, `{ sub, jti, exp }`

  `workspace_ids` was in this list and is deliberately **not** implemented. Putting
  memberships in a bearer token means authorisation data that is 15 minutes stale by
  design: a user removed from a workspace keeps access until their token expires.
  Every path that needs a role already resolves it live through `permissions.py`, so
  the claim would be either unused or a bug waiting to be written. `sub` is the
  identity; roles are resolved, never asserted by the client.
- Refresh token: opaque 32-byte random, sha256-hashed in DB, 30 days, **rotated on
  every use**. On reuse of an already-rotated token, revoke the entire `family_id`
  (theft detection).
- Refresh token in httpOnly + secure + SameSite=Lax cookie. Access token in memory
  only — never localStorage.
- ws-token: separate short-lived token, 60s, single board scope, consumed on use.
  Carries `sub` and the *parent access token's* expiry, so a ws-token can never
  outlive the session that minted it — otherwise it is a way to launder an expiring
  session into a connection that stays open past it. It does **not** carry a role,
  for the same reason the access token does not carry `workspace_ids`.

  ⚠️ Single-use tokens fight `y-websocket`'s auto-reconnect: the provider composes its
  URL once and retries on its own schedule, so a flaky connection loops forever on a
  spent token. Fetch a fresh token per connection attempt — likely a thin wrapper
  around the provider rather than a plain URL string. **Verify what the pinned
  version supports during M0** (five minutes then, an annoying detour in M1).
- Rate limits (Redis): login 5/min/IP, register 3/hour/IP, ws-token 30/min/user.

### Permission resolution

Effective role = max(workspace role mapped to board role, explicit board_members role).
Owner > editor > commenter > viewer. Implement once in
`app/services/permissions.py`; every router and the ws handshake calls it.

Note: `commenter` exists in the enum and the hierarchy but is **inert in v1** —
comments are v2 scope. In v1 it resolves with the same capabilities as `viewer`.
Keep the enum value so the migration isn't needed later.

An explicit `board_members` row can only *raise* the effective role, never lower it —
`max()` of the two grants means a board-level downgrade would be silently undone by
the workspace grant. So a board-level downgrade is not offered in the UI, and the
members endpoint returns the *effective* role rather than the one just written, so a
caller is never told a downgrade took effect when it did not.

---

## 8. Docker & deployment

```yaml
# docker-compose.yml — services
api:       build services/api        depends_on: postgres, redis
worker:    same image, arq entrypoint
postgres:  postgres:16-alpine        named volume, shm_size: 1g
redis:     redis:7-alpine            appendonly yes
minio:     minio/minio
nginx:     nginx:alpine              serves web build, proxies /api + /ws
backup:    prodrigestivill/postgres-backup-local
```

Postgres notes (decided earlier — do not revisit):
- **Named volume**, not a bind mount (avoids UID/GID startup failures)
- `shm_size: 1g` — the 64MB default causes confusing query failures
- Nightly `pg_dump` via the backup sidecar → Backblaze B2, 7-day retention
- No WAL archiving / PITR — disproportionate for this project
- Major version upgrades: dump → fresh volume → restore. Not a tag bump.

nginx must set `proxy_http_version 1.1`, `Upgrade`/`Connection` headers on `/ws`,
and `proxy_read_timeout 3600s`.

### CI (GitHub Actions)

```
lint      ruff + mypy (api) · eslint + tsc (web)
test      pytest (with postgres+redis services) · vitest
e2e       playwright against docker compose
build     docker build both images -> GHCR (on main)
deploy    ssh to VPS, pull, docker compose up -d (on main)
```

---

## 9. Build order

Ship in this sequence. Do not start a milestone before the previous one works.

**On the estimates below:** they are focused-work estimates and assume nothing goes
wrong. Solo, alongside a job search, expect roughly **2× wall-clock** — most of the
overrun lands in M2 (renderer batching) and M3 (overlay drift). Plan for ~3 months to
v1, not 7 weeks. The *ordering* is what matters; the numbers are relative weights.

### M0 — Spike (2–3 days) ⚠️ GATE
Prove the foundation before committing to the stack.
- FastAPI ws endpoint + pycrdt room, one hardcoded board
- Token validated on connect
- Two browser tabs with a yjs client; edits converge
- Updates persisted to Postgres and **correctly reloaded after a full server restart**
  (not just after a client reconnect — the restart is what actually tests the design)
- One client edits while offline, reconnects, and both converge

`pycrdt-websocket` is the load-bearing unknown here. pycrdt itself is solid (Rust
`yrs` bindings, wire-compatible with yjs); the websocket layer is thinner and less
battle-tested than Hocuspocus. Treat this gate as a genuine decision point, not a
formality.

**If it fails:** switch to Node 22 + Fastify + Hocuspocus for the whole backend. The
React/PixiJS/yjs frontend is byte-identical — only the server changes, so the cost is
these three days, not three weeks. In that case Python re-enters in v2 as a separate
`services/worker` (arq or Celery) handling exports, thumbnails, compaction, and LLM
features — off the request path, no shared ORM, no duplicated auth. Do **not**
pre-build that worker now; a third service before v1 exists is how this project dies
at week four.

### M1 — Auth & boards CRUD (1 week) ✅ done
Users, workspaces, boards, membership, JWT + refresh rotation, ws-token endpoint,
permission service, board list UI, login/register.

The handshake's five rejection paths were written as failing tests before any of it
existed. Alembic owns the schema from here; the API no longer creates tables at boot.

### M2 — Canvas core (2 weeks)
Camera, pan/zoom, rect/ellipse/diamond, rbush hit-testing, viewport culling,
multi-select, transform handles, snapping, z-order, `Y.UndoManager`.
**Exit criteria: 60fps with 5,000 objects.**

### M3 — Text objects (1.5 weeks)
DOM overlay glued to camera, TipTap per object, `Y.XmlFragment` binding, sticky
notes, mount/unmount lifecycle, viewport-only mounting.

### M4 — Arrows & binding (1 week)
Arrow tool, endpoint attachment, anchor recalculation on target move, orthogonal
routing option, survival on target delete.

### M5 — Realtime polish (1 week)
Awareness cursors + selection highlights, offline reconnect convergence, snapshot
compaction job, thumbnails, presence avatars.

### M6 — Ship v1
README with architecture diagram, CRDT-vs-OT rationale, measured numbers, known
limitations. Deploy. Record a demo GIF.

### v2 — after v1 is live
Tables · charts · freedraw · frames/groups · images · export to PDF/PNG · full-text
search · comments · LLM features (board summarisation, text→flowchart generation,
pgvector semantic search)

---

## 10. Conventions

**Python:** ruff (line 100), mypy strict on `app/`, async everywhere, no sync DB
calls in request path. Pydantic schemas separate from SQLAlchemy models.

**TypeScript:** strict, no `any`, no default exports except route components,
`type` over `interface` for object shapes.

**Document mutations:** every write to the Y.Doc goes through a function in
`src/doc/mutations.ts`, wrapped in `Y.transact` with a consistent origin. Never
mutate a Y.Map from a component.

**React + Yjs:** components subscribe via `useSyncExternalStore` to a Y.Map
observer. Never copy document state into `useState` — it will desync.

**Commits:** conventional commits. Small, working increments.

**Tests to write first:** ws handshake auth (all rejection paths), permission
resolution, refresh token rotation + reuse detection, CRDT convergence under
simulated concurrent edits.

---

## 11. Measure these (for the README and interviews)

- Concurrent editors sustained per board
- Cursor propagation p50 / p95 latency
- Canvas frame time at 1k / 5k / 20k objects
- Time to first render on a 5k-object board
- Update log size before vs after compaction

Numbers are what separate "I built a collaborative app" from a conversation.

---

## 12. Explicitly out of scope for v1

Voice/video · mobile native apps · real-time cursors in text (only object-level
awareness) · version history UI · multi-region · SSO/SAML · offline conflict UI
(CRDT handles it silently) · WAL archiving / PITR