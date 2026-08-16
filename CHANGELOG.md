# Changelog

Meadow ships in milestones rather than on a version cadence, so this is organised by
phase. Each phase carries the date of the commit that completed it, in `dd-mmm-yyyy`.

`docs/core/ARCHITECTURE.md` section 9 is the design record and holds the reasoning.
This is the delivery record: what each phase actually produced, and what was thrown
away getting there.

---

## M6 - Ship v1 - Unreleased

The infrastructure to run the thing. Not deployed yet.

### Added
- Production stack in `docker-compose.yml`, with development moved to
  `docker-compose.local.yml`. The file that runs unattended on a server is the one that
  should not need a flag to select. The two pin different compose project names so a
  development machine can run both.
- One API image with three entrypoints: the web process, the arq worker, and a one-shot
  migrator the API gates on. A failed migration stops the deploy instead of producing a
  running API that fails on its first query.
- Web image with the SPA baked into nginx, which proxies `/api` and `/ws`.
- Backup sidecar. Nightly `pg_dump`, verified with `pg_restore --list` before it counts,
  seven days retained, and a first dump at startup so the first deploy proves backups
  work rather than finding out a day later. The healthcheck watches the newest file
  rather than the process, because a backup job's failure mode is running happily and
  producing nothing.
- `scripts/stack-check.mjs` and `pnpm check:stack`. Fifteen assertions against the
  running stack through its published port: fingerprinted assets immutable, `index.html`
  uncached, a missing asset a 404 rather than the SPA fallback, `/healthz` reaching the
  API, and two yjs clients converging through the proxy.
- CI on every push: lint, both test suites, the e2e scripts, and a job that builds the
  images and runs the stack check against them. `release.yml` publishes three images to
  GHCR and deploys over ssh, gated on CI passing.
- A development profile that runs the whole app in Docker with hot reload:
  `docker compose -f docker-compose.local.yml --profile app up`. uvicorn reloads on a
  Python edit, vite hot-reloads on a TypeScript one, and watchfiles restarts the arq
  worker.
- README architecture diagram and the CRDT-versus-OT rationale.

### Fixed
- `services/api/pyproject.toml` had no `[build-system]` and no package configuration, so
  a fresh `uv pip install -e .` failed outright: setuptools' flat-layout discovery finds
  `app` and `alembic`, refuses to guess between them, and stops. It only ever worked
  because the local virtualenv predated `alembic/` and was reused. A fresh clone could
  not follow the README, which is what CI does on every run.
- Forwarded headers could be forged. `--proxy-headers` without a trust list lets any
  caller choose their own rate-limit bucket and audit-log address, because
  X-Forwarded-For is client-supplied and uvicorn's permissive mode reads the leftmost
  entry. `FORWARDED_ALLOW_IPS` is now pinned to the web container's fixed address.
- nginx used `real_ip_recursive on`, which reads as the stricter setting and is the
  opposite: with a single trusted hop, the forged address a client puts at the far left
  is exactly where the right-to-left walk lands. Now `off`, which takes the entry the
  terminator appended and no client can write. Found by the stack check failing, not by
  reading the config.

### Known limitations
- Not deployed. `meadow.creara.in` does not serve this yet.
- No licence chosen, so the default applies and nobody may use the code.
- Backups have no offsite copy. They sit on the same disk as the database they protect,
  which covers a bad migration and not a lost VPS.
- TLS is not in the compose file. The stack serves plain HTTP on a loopback-bound port
  and expects the host's edge proxy to terminate.
- The API runs one uvicorn worker, and that is a ceiling rather than a default. Rooms
  are in-process state, so a second worker would hold its own room for the same board.

---

## M5 - Realtime polish - 06-Aug-2026

### Added
- Wanderer cursors and selection highlights over the y-protocols awareness channel,
  throttled to roughly 30Hz. Awareness never touches the Y.Doc: a cursor position
  written into the CRDT would land in the update log, the snapshot, and the undo stack.
- Snapshot compaction scheduled from an arq worker, in its own process. Compaction folds
  a whole document in memory, which would take a request-serving process down with it.
- Board thumbnails, stored in Postgres rather than object storage. A preview is a few
  kilobytes, there is one per board, and it is rewritten in place.
- The concurrency and extreme-conditions suite: convergence under concurrent edits,
  adversarial input on the wire, resource limits, and failure injection.

### Fixed
- A joining client sat in an apparently empty room for about fifteen seconds. The server
  sends a sync message and nothing else, so a new peer learned who was present only when
  somebody next published. Peers now answer an arrival by re-publishing their own state.
  Caught by the two-browser presence test as an asymmetry no single-page test could
  produce: the first peer saw two avatars, the second saw one.

### Reversed
- The server-side version of that presence fix. Encoding the room's awareness and
  writing it to the socket during the handshake worked, and intermittently deadlocked the
  room, because it writes to the channel before the room has taken it over. The backend
  suite hung on one websocket test in three of five full runs, for fifteen minutes each
  time, and passed in isolation every time. Presence is a client concern and there is no
  race to have there.

---

## M4 - Arrows and binding - 05-Aug-2026

### Added
- Arrows as a separate pass above the shape batch, one shared `Graphics` rebuilt each
  frame rather than one per arrow, with arrowheads as part of the path.
- Endpoints bound to objects through normalised anchors plus a gap, resolved against the
  real outline, so arrows follow their targets through a move or a resize. Binding reflow
  happens inside the same transaction as the move that caused it, so a peer never
  observes a shape in its new position with the arrow still on the old one.
- Deleting a target nulls the binding rather than the arrow. The endpoint goes free and
  stays where the shape was.

### Changed
- Arrows render on a dedicated layer above shapes, giving up z-interleaving between the
  two. This was chosen rather than inherited, and it constrains v2: a frame that clips
  its contents will not clip arrows.

### Known limitations
- Routing is not obstacle-aware. A route that reshuffles itself as unrelated objects move
  is worse than one that runs straight through them.
- Arrow-to-arrow binding is expressible in the schema and refused by the tool. The target
  has no interior to aim at and chains of them can cycle.

---

## M3 - Text objects - 04-Aug-2026

### Added
- An absolutely-positioned DOM overlay reading the same camera object as the WebGL
  layer, with the composed transform snapped to device pixels to stop subpixel drift
  between the two. Only viewport-visible objects mount.
- A TipTap editor per text object, bound to a `Y.XmlFragment`, so two people typing in
  one object merge character by character.
- Sticky notes, and self-hosted Inter, Comic Neue and JetBrains Mono. Text metrics feed
  CRDT bounds, so first canvas render waits on `document.fonts.ready`.

### Fixed
- ProseMirror destroyed the pooled overlay element on teardown, leaving the object blank
  for the rest of the session. Editing now mounts a sacrificial child.
- Ending an edit blanked the element for one frame, a 16ms flash that read as text loss.
  The static HTML is now written synchronously.

---

## M2 - Canvas core - 04-Aug-2026

### Added
- Pan and zoom with zoom-to-cursor over a range of 0.1 to 8. A single camera object is
  the only source of transform state; both layers read it and neither keeps a copy.
- Dirty-flag rendering, one pass per animation frame.
- R-tree culling, hit-testing, selection and transforms, and undo.

### Changed
- Primitives render through an instanced signed-distance batch rather than a container
  and graphics per object. Measured: **1 draw call at 5,000 objects**, against roughly
  2,670 for the per-object structure. An SDF evaluated in world units also keeps stroke
  width and corner radius exact at any size, which a texture atlas or scaled geometry
  cannot. Adding a shape type means adding an SDF branch.

### Known limitations
- **60fps at 5,000 objects is not verified.** Every run so far rasterised in software,
  where the render call returns before rasterisation finishes, so it measures CPU work
  only. Measured CPU frame cost at that size is 3.5ms median.
- 20,000 objects has never been measured. The development machine runs out of memory at
  that size.

---

## M1 - Auth, workspaces and boards - 02-Aug-2026

### Added
- Users, workspaces, boards and membership. Argon2id passwords, 15-minute access JWTs,
  and refresh tokens rotated on use with family revocation on reuse.
- Permission resolution in exactly one function, called by every router and by the
  websocket handshake. A second place computing a role is a bug.
- The handshake resolves real board roles and rejects non-members, tokens minted for
  another board, and boards deleted between mint and connect. Its five rejection paths
  were written as failing tests before the implementation.
- Viewer enforcement on both sides. The server drops a viewer's document writes, and the
  client is told its role at mint time so it refuses the write first. Server-side alone
  is not enough: a viewer's own document still applies their edits locally, so they would
  watch them appear, survive a refresh, and then vanish.
- citext emails, Redis rate limits, and Alembic owning the schema.

### Changed
- Tokens carry identity, never authorisation, which departs from the original design.
  Memberships in a bearer token are stale by design: a user removed from a workspace
  would keep access until their token expired. Roles resolve live from the database on
  every request and every connect.

---

## M0 - Realtime spike - 02-Aug-2026

The gate. Its job was to answer one question before any canvas code existed: does a
Python CRDT backend carry this workload, or does the project need Node and Hocuspocus?

### Added
- Monorepo scaffold, docker compose stack, websocket sync with Postgres persistence,
  snapshot compaction, and a reproducible gate harness driving real yjs clients over the
  wire.
- The gate passes bidirectional convergence between real yjs clients, state reload after
  a full server restart, an offline edit reaching a fresh client, and 4401 on replayed,
  invalid and missing ws-tokens.

### Changed
- **Stack decision closed: Python carries the realtime workload.** No fallback to Node
  and Hocuspocus.
