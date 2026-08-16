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

Self-host all three as woff2 under `apps/web/public/fonts`, fetched by `pnpm fonts`.
No Google Fonts CDN: the app is behind auth on a single VPS, and a third-party font
request on every board load is a needless dependency and a privacy leak.

Fonts are a canvas concern, not just CSS. Text objects are measured in the DOM overlay
and their bounding boxes are written into the CRDT, so a font that loads late changes
`w`/`h` after the fact and shifts layout for everyone. Preload the two text-object
faces and gate first canvas render on `document.fonts.ready`. Adding a text-object face
later is a schema-visible decision, not a style tweak.

**Corrected in M3: `font-display: block`, not `swap`.** A swap paints fallback glyphs
first, and the measurer would measure *those* and write the resulting height into the
CRDT before the real face arrived. A short invisible period is the cheaper failure.

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
│       │   │   ├── renderers/   # shapeBatch (instanced SDF) + arrowPass (Graphics)
│       │   │   ├── overlay/     # textLayer — mounting and camera sync, no editor
│       │   │   ├── text/        # measurement, font loading, shared text styles
│       │   │   └── tools/       # select, rect, arrow, text, pen...
│       │   ├── overlay/         # TipTap editing session; ProseMirror lives only here
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
│           ├── text.ts      # text props and defaults — layout is measurement input
│           ├── arrows.ts    # arrow props; points are relative to the object origin
│           ├── arrowBinding.ts  # anchor resolution, outline intersection, routing
│           ├── bindings.ts
│           ├── doc.ts
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
│   ├── api/Dockerfile           # api, worker, and the one-shot migrator
│   ├── web/Dockerfile           # SPA build baked into nginx
│   ├── nginx/                   # base conf + the site template
│   ├── backup/                  # pg_dump sidecar
│   └── pgadmin/
├── docker-compose.yml           # production; a bare `up -d` on the VPS is the deploy
├── docker-compose.local.yml     # dev: postgres, redis, pgadmin only
├── .github/workflows/
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

**Built in M5.** `app/workers/compaction.py`: an arq cron sweeps every ten minutes for
boards past `COMPACTION_THRESHOLD` updates and enqueues one job per board, capped per
sweep so a backlog is worked through over several ticks rather than flooding the queue.
Jobs carry a per-board id, so a board still queued from the previous tick is not queued
twice. The worker runs as its own process with its own engine: an asyncpg pool belongs
to the loop that created it, and compaction merges whole documents in memory, which is
not something a request-serving process should be doing.

    cd services/api && .venv/bin/arq app.workers.settings.WorkerSettings

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

**Measured in M5, and narrower than that sentence implies.** Only one of the three
plausible readings is true, per `apps/web/src/doc/convergence.test.ts`:

| | |
|---|---|
| You delete, a peer deletes concurrently, you undo | **resurrected, for everyone** |
| You edit a field, a peer deletes, you undo the edit | not resurrected |
| You create, a peer deletes, you undo then redo | not resurrected |

Only undoing *your own* delete brings an object back, because the undo re-inserts and
an insert beats a tombstone. Restoring a field value does not restore the map that
held it. Worth stating precisely: the loose version implies undo is hazardous near any
concurrent delete, and it is not.

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

### Arrows are a separate pass, and a separate layer

Settled in M4, and it deliberately contradicts the batching rule above. That rule
exists because 5,000 rectangles at one draw call each is 5,000 draw calls. Arrows do
not have that problem: a board carries tens of them against thousands of shapes, so
their draw calls are noise. What they do have is genuinely dynamic geometry, since any
endpoint can move when an unrelated object is dragged, and instancing is the wrong tool
for that.

So: **one shared `Graphics`, cleared and re-recorded every frame**, not one per arrow.
Arrowheads are part of the path rather than sprites, because the sprite batching win is
worth nothing once the pass is not batched, and a path head rotates and scales for
free. Within the pass, geometry is still grouped by stroke style before being recorded
— that is the same "batch by material, not by logical object" rule, and it took the
per-arrow cost from 19 microseconds to 10.9.

Measured by `pnpm bench:arrows`, in the case that would have overturned it: one arrow
moving among many static ones, which invalidates the whole pass every frame.

| | |
|---|---|
| Per arrow | **10.9 µs** |
| 200 arrows, a busy board | 2.2 ms of a 16.7 ms frame |
| Arrow pass alone fills a frame at | ~1,500 arrows |

Past roughly 400 arrows this wants dirty-rect rebuilding. That would be a change to
*when* the pass is rebuilt, not to the layer or batching decisions.

**Arrows always draw above shapes.** The pass is a sibling of the batch, added after,
so z-order between an individual arrow and an individual rectangle is not expressible.
Figma and most whiteboards behave the same way, and users essentially never want a
connector tucked behind a box.

> **Known constraint, chosen rather than inherited.** A global arrows-on-top layer
> means arrows escape frame clipping. If frames later clip their contents visually, an
> arrow inside a frame will spill over the frame's edge instead of being cut off.
> Frames are v2 scope so this costs nothing now. The fix, when it matters, is one arrow
> pass per frame rather than one globally, which is a change in how many `Graphics`
> exist and nothing else.

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

**Resolved in M3.** `viewTransform(camera, dpr)` in `src/canvas/camera.ts` is computed
once per frame and handed to three consumers: the Pixi world container, the overlay
root's CSS transform, and the screen-space selection chrome. Nobody else projects.

One decision worth keeping: the snap lives in the render transform, not in the camera.
Quantising `camera.x` itself would look tidier and would break trackpad panning, since
a fractional delta would round to zero and never accumulate. So input reads the
continuous camera and rendering reads the snapped transform. They differ by at most
half a device pixel and that error cannot compound.

Verified against pixels, not arithmetic, by `scripts/overlay-smoke.mjs`: it screenshots
the canvas at each of the zooms above at dpr 1 and 2, finds the sticky note's fill
colour in the image, and compares that rectangle with the overlay element's client
rect. Both must land within one CSS pixel of where the shared transform says.

Only mount overlay elements for objects **in the viewport**. A board with 500 text
objects must not create 500 contenteditable nodes.

Text object lifecycle:
1. Idle → rendered as static HTML in the overlay
2. Double-click → mount a TipTap instance bound to that object's `Y.XmlFragment`
3. Blur/Escape → destroy the instance, revert to static HTML

The static half of that lifecycle is `src/doc/richText.ts`, which serialises a
`Y.XmlFragment` to HTML directly rather than mounting a headless editor to read one.
It is also an escaping boundary: the server never inspects CRDT payloads, so any
string a peer writes into a fragment reaches `innerHTML` through this function.

The set of node types the editor can produce and the set the serialiser can render are
one decision in two files. A node type only the editor knows would look right while
being typed and vanish when the editor closed.

**Undo is deliberately two stacks.** The Collaboration extension brings its own
`Y.UndoManager` over the fragment, so Ctrl+Z inside an editor undoes typing. The
session's UndoManager in `doc/mutations.ts` tracks only `LOCAL_ORIGIN`, which the
editor's writes do not use, so an object-level undo never reaches inside a paragraph.
One stack for both would mean undoing a move reverted someone's sentence.

**Text metrics are CRDT data, not layout.** A text object's height is measured from
rendered glyphs and written back to the document, so the measurement has to be
zoom-independent (it happens in an offscreen element outside the camera transform) and
font-dependent (the engine gates its first render on the three faces being loaded). A
client that measured against a fallback face would write a height every other client
disagreed with.

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

`docker-compose.yml` is production; `docker-compose.local.yml` is development. As
built:

```yaml
# docker-compose.yml (production) — services, project name meadow-prod
postgres:  postgres:16-alpine        named volume, shm_size: 1g, no host port
redis:     redis:7-alpine            appendonly yes, no host port
migrate:   api image, alembic upgrade head, one-shot; api gates on its exit
api:       docker/api/Dockerfile     one uvicorn worker, --proxy-headers
worker:    same image, arq entrypoint, healthcheck is `arq --check`
web:       docker/web/Dockerfile     SPA baked into nginx, proxies /api + /ws
backup:    docker/backup/Dockerfile  from postgres:16-alpine, verified pg_dump
```

Deliberately absent: **MinIO** (nothing in v1 writes to it; thumbnails are rows) and
**TLS** (host state with a renewal timer, terminated by the host's edge proxy).

```yaml
# docker-compose.local.yml — services, project name meadow
postgres:  published on 5435, redis on 6380, pgadmin on 5051

# behind `--profile app`, for running the whole thing in docker with hot reload
migrate:   api dev image, alembic upgrade head, one-shot
api:       uvicorn --reload, source bind-mounted, published on 8012
worker:    arq under watchfiles, so a compaction edit restarts it
web:       vite dev server, source bind-mounted, published on 3012
```

The application containers sit behind a profile rather than starting by default,
because they hold the two ports the M0 gate and the e2e scripts need for the servers
those spawn themselves. A plain `up -d` is infrastructure only, which is what the
default workflow wants.

Two details there are load-bearing. The web container bind-mounts `apps/web` and then
puts **anonymous volumes over the `node_modules` directories**, so the container keeps
its own dependencies: the host tree is installed for the host platform and pnpm's
symlinked layout does not survive being half-overlaid, and the symptom reads as a vite
fault rather than a mount one. And the API dev stage is a **separate stage**, not a
flag on the runtime one, because `--reload` adds a file watcher, a supervisor process,
and re-execution of code from a writable mount, none of which belongs in the image
that faces the internet. The suite is mounted rather than baked in, so
`services/api/.dockerignore` can keep tests out of the deployed artefact while
`exec api pytest` still works.

Postgres notes (decided earlier — do not revisit):
- **Named volume**, not a bind mount (avoids UID/GID startup failures)
- `shm_size: 1g` — the 64MB default causes confusing query failures
- Nightly `pg_dump` via the backup sidecar, 7-day retention. Offsite push to
  Backblaze B2 is **not wired**: the dumps are on the same disk as the database they
  protect, which covers a bad migration and not a lost VPS.
- No WAL archiving / PITR — disproportionate for this project
- Major version upgrades: dump → fresh volume → restore. Not a tag bump.

nginx sets `proxy_http_version 1.1`, `Upgrade`/`Connection` on `/ws`, and
`proxy_read_timeout 3600s`. The `Connection` value comes from a `map` on
`$http_upgrade` rather than being hardcoded, or every REST call through the same
server block loses keepalive. See M6 in §9 for the forwarded-header rules, which are
the part that is easy to get wrong quietly.

### CI (GitHub Actions)

```
lint      ruff + mypy (api) · tsc (web)
test      pytest (with postgres+redis services) · vitest
e2e       playwright against a real API and vite, on postgres+redis services
stack     build both images, run docker-compose.yml, assert against it
build     docker build both images -> GHCR (on main)
deploy    ssh to VPS, pull, docker compose up -d (on main)
```

`docker-compose.yml` is the production stack and `docker-compose.local.yml` is the
development one, rather than the other way round. The file that runs unattended on a
server is the one that should not need a flag to select, because the command that gets
typed under pressure is the short one.

---

## 9. Build order

Ship in this sequence. Do not start a milestone before the previous one works.

This section is the design record and holds the reasoning. `CHANGELOG.md` is the
delivery record for the same phases, dated from the commit that completed each one. If
the two disagree, one of them is wrong and it is worth finding out which.

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

### M2 — Canvas core (2 weeks) ✅ done
Camera, pan/zoom, rect/ellipse/diamond, rbush hit-testing, viewport culling,
multi-select, transform handles, snapping, z-order, `Y.UndoManager`.
**Exit criteria: 60fps with 5,000 objects.**

The renderer was benchmarked on day one, as §5 demands, and the batching caveat proved
real: a `Graphics` per object issued ~2,700 draw calls per frame at 5,000 objects, and
sharing a `GraphicsContext` per style bucket did not help (~2,760, since each instance
still has its own transform). The instanced SDF renderer issues **one**. See
`apps/web/src/canvas/renderers/shapeBatch.ts` and `pnpm bench:renderer`.

`packages/schema` now exists and owns the object model, per §4: a plain `ObjectData`
type plus accessors over the live `Y.Map`. The two are deliberately not the same type.

### M3 — Text objects (1.5 weeks) ✅ done
DOM overlay glued to camera, TipTap per object, `Y.XmlFragment` binding, sticky
notes, mount/unmount lifecycle, viewport-only mounting.

Layer drift was the budgeted risk and it is closed: one `viewTransform` feeds both
layers, and `scripts/overlay-smoke.mjs` proves it against screenshots at every zoom in
§5 at dpr 1 and 2. Inter, Comic Neue and JetBrains Mono are self-hosted under
`apps/web/public/fonts` (236KB, latin and latin-ext), fetched reproducibly by
`pnpm fonts`, and the engine waits on them before its first frame because their metrics
end up in the document.

Not built, and deliberately: tables. §5 describes them as `<table>` elements in the
overlay, which the mount and camera machinery now supports, but they are a v2 feature
and jumping to them before v1 ships would violate the milestone order.

### M4 — Arrows & binding (1 week) ✅ done
Arrow tool, endpoint attachment, anchor recalculation on target move, orthogonal
routing option, survival on target delete.

An arrow's endpoints are **derived, not authored**. The document stores a binding; the
point is recomputed by a solver in `doc/mutations.ts` that runs inside the same
transaction as the move that caused it. That placement is the whole design: a peer
never observes an arrow detached from the shape it is attached to, and one undo step
puts both back.

A centre anchor is directional — it aims at the target's centre and stops at the real
outline, so an arrow into an ellipse lands on the ellipse rather than in the corner of
its bounding box. An explicit anchor is honoured exactly. `anchorFor` picks between the
two by where the endpoint was dropped, which is what makes plain "drag between two
boxes" do the right thing with no modifier key.

Orthogonal routing regenerates its waypoints on every solve rather than storing and
adjusting them, so a route cannot drift out of step with its endpoints. It is not
obstacle-aware, on purpose: that is a genuinely hard problem, it is the part of arrows
that matters least when missing, and a route that reshuffles itself as unrelated
objects move is worse than one that runs straight through them.

Arrow-to-arrow bindings are expressible in the schema and are refused by the tool. The
target has no interior to aim at, so the anchor maths degenerates, and chains of them
can cycle.

### M5 — Realtime polish (1 week) ✅ done
Awareness cursors + selection highlights, offline reconnect convergence, snapshot
compaction job, thumbnails, presence avatars.

Also owns the concurrency and extreme-condition suite in §12. Those scenarios need a
real second peer and a real failure to inject, so they cannot be retrofitted cheaply
once the realtime surface is finished.

**Awareness never touches the Y.Doc.** It rides the same socket and the room relays it,
but a cursor position written into the CRDT would land in the update log, the snapshot,
and the undo stack, and a board would accumulate a permanent record of where everyone's
mouse had been. Cursors publish at ~30Hz; selection is unthrottled, because it is
discrete and rare and a late highlight reads worse than a late cursor.

**A joining client learns who is already here from its peers, not from the server.**
`YRoom.serve` sends a sync message and nothing else, so the newest peer used to sit in
an apparently empty room until somebody re-announced on the keepalive, roughly fifteen
seconds later. `pnpm e2e:presence` caught it as an asymmetry no single-page test could
produce: the first peer saw two avatars, the second saw one.

The fix is in `sync/awareness.ts`: when a peer we have not seen appears, re-publish our
own state so they learn about us in the same round trip. It cannot ping-pong, because a
re-announce arrives at the other side as an update to a client it already knows.

**The server-side version of this was tried first and reverted.** Encoding the room's
awareness and writing it to the socket during the handshake worked, and intermittently
deadlocked the room: it writes to the channel before `YRoom.serve` has taken it over.
The backend suite hung on `test_a_viewer_write_never_reaches_the_live_room` in three of
five full runs, for fifteen minutes each time, and passed in isolation every time.
Presence is a client concern and there is no race to have there.

Compaction is scheduled from here, in `app/workers/`. The fold itself stayed in
`realtime/ystore.py`, next to the read path it has to remain consistent with.

Thumbnails are stored **in Postgres**, not MinIO, which is a deliberate departure from
§1's "object storage: images, attachments, exports". A preview is a few kilobytes,
there is one per board, and it is rewritten in place. Standing up MinIO to hold one
small row per board would be a second system to back up, secure, and keep consistent
with the row pointing at it. `boards.thumbnail_url` stays unused and reserved: v2's
user-uploaded images and exports genuinely do need object storage.

The capture renders the whole board unculled into a fitted frame, then draws the text
on with 2D canvas calls. The real text lives in the DOM overlay, so extracting the
WebGL canvas alone produces a board on which every sticky note is blank.

### M6 — Ship v1
Infrastructure, README, deploy. In progress: the images, the production compose, the
proxy config and CI exist and are exercised; the deploy to `meadow.creara.in` and the
demo recording are not done, and the licence is unchosen.

**`docker-compose.yml` is production and `docker-compose.local.yml` is development**,
which is the reverse of the usual arrangement. The file that runs unattended on a
server is the one that should not need a flag to select, because the command typed
under pressure is the short one. The two pin different compose project names, so a
development machine can run both without either treating the other's containers as
orphans.

**One API image, three entrypoints.** The web process, the arq worker, and a one-shot
migrator share a codebase and a dependency set. The migrator is a compose service the
API declares `service_completed_successfully` on, so a failed migration stops the
deploy rather than producing a running API that 500s on its first query.

**The API runs a single uvicorn worker, and this is a ceiling, not a default.** Rooms
are in-process state. Two workers would each hold their own `YRoom` for the same board
and the two halves would see each other only through the Postgres update log. Scaling
past one process means a Redis-backed room registry, which is v2.

**`--proxy-headers` without a trust list is a vulnerability, not a flag.**
X-Forwarded-For is client-supplied and uvicorn's `*` mode reads the leftmost entry, so
any caller could name their own rate-limit bucket and their own audit-log address.
`FORWARDED_ALLOW_IPS` is pinned to the web container's fixed address on a fixed subnet.

nginx sets `real_ip_recursive off`, which is the counter-intuitive half. `on` walks the
forwarded list right to left and stops at the first untrusted address, which sounds
stricter and is the opposite: with a single trusted hop, a header the client sent
themselves puts a forged address at the far left and that is exactly where the walk
lands. `off` takes the last entry, the one the terminator appended, which no client can
write. `MEADOW_TRUSTED_PROXY_CIDR` defaults to `127.0.0.1` so an unconfigured
deployment ignores the header entirely and falls back to the TCP peer.

`scripts/stack-check.mjs` asserts this against the running stack by registering six
times behind six forged addresses and requiring a 429. Written against the earlier
config it failed, which is how the recursive-walk problem was found rather than
reasoned about.

**The stack check exists because every other test talks to a uvicorn on the host.** The
m0 gate, the smokes and the e2e scripts would all pass against a deployment whose proxy
dropped the websocket upgrade, cached `index.html` forever, or answered a missing
bundle with the SPA fallback. It drives the published port the way a browser does:
fingerprinted assets immutable, `index.html` not cached, a missing asset a 404 rather
than HTML, `/healthz` reaching the API rather than the fallback, and two yjs clients
converging through the proxy.

**TLS is not in the compose file.** Certificates are host state with a renewal timer.
The container serves plain HTTP on one published port bound to loopback and reads the
original scheme from X-Forwarded-Proto, so the refresh cookie is still marked Secure
behind a terminator on the host.

**MinIO is not in the compose file either**, which §8 lists. Nothing in v1 talks to it:
thumbnails are rows in `board_thumbnails` and there are no user uploads. It arrives
with images in v2.

**The backup sidecar is built here rather than pulled.** §8 named
`prodrigestivill/postgres-backup-local`; every binary in that image faults with "exec
format error" on the development machine, including when pulled by its amd64 digest,
while `debian` and `postgres:16-alpine` run fine on the same daemon. Deriving from
`postgres:16-alpine` is the better base regardless: pg_dump refuses to dump from a
server newer than itself, so one tag now pins both. Every dump is verified with
`pg_restore --list` before it is renamed into place, the first runs at startup so the
first deploy proves backups work, and the healthcheck watches the newest file rather
than the process, because a backup job's failure mode is running happily and producing
nothing.

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

### Measured so far, and what is still unverified

Report these honestly. A number taken under software rasterisation is not the number
the target is about.

| | Status |
|---|---|
| Draw calls at 5,000 objects | **1**, measured. See M2 above. |
| CPU frame cost at 5,000 objects | **3.5ms median**, measured by `pnpm bench:canvas`. |
| Overlay drift, zoom 0.33 to 2.5, dpr 1 and 2 | **within 1 CSS pixel**, measured against screenshots by `pnpm smoke:overlay`. |
| Arrow pass, per arrow | **10.9 µs**, measured by `pnpm bench:arrows`. 2.2 ms at 200 arrows. |
| 60fps at 5,000 objects | **not verified.** Every run so far rasterised in software (SwiftShader), where `app.render()` returns before rasterisation finishes, so it measures CPU work only. Needs `/canvas-dev.html?n=5000&stress` on real hardware. |
| 20,000 objects | **never measured.** The dev machine OOM-kills the run at that size, so the benchmark takes one object count per invocation. |
| Concurrent editors, cursor latency, compaction | not yet applicable. M5. |

---

## 12. Concurrency and extreme conditions

In scope for v1, and owned by M5 rather than left to "later". Everything below is a
class of bug that unit tests cannot reach, because each one needs either two peers, a
hostile input, or a resource limit to reproduce. They are listed as scenarios with an
expected outcome so each can become a test rather than a worry.

The rule for this whole section: **a failure must be one of correct, degraded, or
refused. Never silently wrong.** A dropped update, a resurrected object, or a board
that renders differently for two people who are looking at the same thing is worse
than an error, because nobody finds out.

### Convergence under concurrency

The property to assert is that every peer ends at byte-identical state once traffic
stops, regardless of ordering. Drive real `yjs` clients, as the M0 gate does.

- N peers editing **distinct** objects. Trivial, and the control case.
- N peers editing the **same field** of the same object. Last-writer-wins per field is
  correct; losing an unrelated field on the same object is not.
- Concurrent **reparent** of one object into two different frames. The flat map makes
  this a single `parentId` write, so one wins cleanly. This is the case a nested tree
  would corrupt, and the reason §4 is locked.
- Concurrent **delete plus edit**: A deletes an object while B drags it. Yjs resolves
  to deleted. B's drag must not resurrect a tombstoned object.
- Concurrent **z-order** changes. `order` is a `Y.Array` rewritten wholesale by
  `applyOrder`, so two simultaneous restacks can interleave into duplicate or missing
  ids. `reconcileOrder` repairs it; the test is that it converges and that no object
  ends up absent from `order`, which would make it invisible and unclickable while
  still occupying the map.
- **Undo across peers.** Local undo can resurrect an object a remote user deleted. This
  is inherent to `Y.UndoManager` and Figma behaves the same way. Assert the documented
  behaviour so a future change to undo scoping cannot alter it unnoticed.
- **Offline divergence.** Two peers both go offline, both edit, both return. Neither
  set of edits may be lost.

### Adversarial and malformed input

The websocket handshake is the security boundary (§7), so the tests that matter are
the ones where the client is not cooperating.

- A **viewer** sending updates over a valid socket. Dropped server-side, with the
  client-side refusal in `mutations.ts` as the second line rather than the only one.
- A tampered client that skips the client-side check entirely. The server drop must
  hold on its own.
- A **role downgrade mid-session**: editor demoted to viewer while connected. The open
  room must stop accepting that peer's writes without waiting for a reconnect.
- **Garbage on the wire**: truncated frames, random bytes, a valid update for a
  different document. Reject and close; never crash the room or the process.
- **Update flooding** from one peer. Rate-limit or disconnect. One client must not be
  able to starve the others or fill the disk.
- **Oversized payloads**: a single object with a megabyte of props, or a paste of
  50,000 objects in one transaction.

### Resource limits and failure injection

- **Room capacity**: connections past `max_clients_per_room` are refused with 4429, and
  the refusal does not disturb the peers already in the room.
- **Compaction racing live edits.** The §3 transaction is the load-bearing part: an
  update committing *while* compaction runs must survive. Sequences are
  non-transactional, so this is the scenario that motivated deleting exactly the folded
  ids rather than filtering on a watermark. Test it with a concurrent writer, not by
  inspection.
- **Two compaction workers on one board.** The advisory lock serialises them. Assert
  the second is a no-op rather than a double-fold.
- **Postgres or Redis dropping mid-session.** Degrade to in-memory relay if that is the
  chosen behaviour, or refuse new joins. Decide which, then test it.
- **Server killed mid-write.** No partially-applied update may survive; this is what
  the M0 gate's cold-restart phase already checks, extended to a kill during traffic.
- **Clock skew** between the API and the token issuer, which decides whether a valid
  ws-token is rejected as expired.

### Scale and endurance

- Frame time at 1k / 5k / 20k objects, on real hardware. The headless harness measures
  CPU-side cost only and cannot answer this; see `scripts/canvas-perf.mjs`.
- Time to first render on a 5k-object board, cold, including document load.
- A **soak test**: one board edited continuously for hours. Watch for growth in the
  update log, the room's memory, and the awareness map, which leaks if disconnected
  peers are never reaped.
- Many rooms at once, to find the per-room memory cost that sets the VPS ceiling.

---

## 13. Explicitly out of scope for v1

Voice/video · mobile native apps · real-time cursors in text (only object-level
awareness) · version history UI · multi-region · SSO/SAML · offline conflict UI
(CRDT handles it silently) · WAL archiving / PITR