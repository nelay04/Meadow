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
- A design system in `apps/web/src/styles.css`: one token layer for surfaces, ink,
  lines, accent, radii and shadows, with light and dark expressed through CSS
  `light-dark()` rather than a duplicated palette. The palette follows Microsoft
  Copilot: warm cream in light, deep desaturated navy in dark, one flat blue accent.
- A theme control in the header. System, light or dark, remembered across sessions, and
  applied to the root's `color-scheme` before React mounts so a dark-theme user never
  sees a frame of cream. The canvas is told separately, because WebGL cannot read CSS.
- An icon set, `apps/web/src/ui/icons.tsx`. Twenty inline SVGs on one grid at one
  stroke weight, inheriting `currentColor`, so a button's colour states drive its icon.
  No icon font and no dependency.
- The real brand art, under `apps/web/public/brand`: the wordmark on the login card,
  the loading splash and the sidebar, and the sprout-m mark as the favicon and touch
  icon at 32, 180, 192 and 512. Both are trimmed from the source PNGs to the pixels
  above an alpha threshold, so the faint glow halo does not leave the mark floating in
  its own box. The drawn placeholder leaf and its accent plate are gone.
- A workspace shell for the board list: a fixed sidebar with search, four views and the
  account, beside a scrolling grid. Every view is derived from what the list endpoint
  already returns — `recent` from `updated_at`, `owned` and `shared` from the resolved
  role — so none of them is a label over an empty room. Sorting by modified, created or
  name, and cards now carry an "Edited N ago" line.

### Changed
- Every page redrawn. Login is a centred card with a segmented control instead of an
  underlined sentence that behaved like a button; the board list is a grid of preview
  cards with a create composer, a skeleton state and a real empty state instead of a
  bare `<ul>`; the board's tool rail floats over the canvas as a rounded panel with
  icons and tooltips rather than taking a column out of the drawing surface.
- **No underlined buttons anywhere.** `button.link` was a link that had failed to
  become a link. Quiet controls now read as controls by shape and hover.
- **No gradients anywhere.** The accent is one flat blue at three weights.
- **A board is a glade, not a field.** "Field" is one of the most overloaded words in
  software and collides with its own technical sense in this codebase: a CRDT field, a
  form field, a signed distance field. A glade is a clearing in a wood, which is what
  an infinite canvas is, and it sits beside **wanderers** without explanation. UI copy,
  the route and the agent instructions moved; `board_id` in the DB and the API did not,
  and `#/field/<id>` still resolves so a tab left open on it is not stranded.
- Comic Neue is the app's face, chrome and content both, and is the default for new
  text objects. Inter stays as a `props.fontFamily` slug so a document that asks for it
  keeps it. Note the metrics consequence in `docs/core/ARCHITECTURE.md`: a pre-M6 text
  object that never chose a family now measures against a different face.
- Default object fills and the canvas chrome retuned to the app palette, and unstyled
  shapes get a small corner radius instead of a hard 90-degree corner.

### Fixed
- **The canvas rendered with antialiasing off, so every diagonal was a staircase.** The
  reasoning was that the SDF batch antialiases itself with `fwidth` and does not need
  MSAA, which is true of the batch and irrelevant to the rest of the frame: arrows,
  lines, the marquee, the selection box, the handles, the guides and the wanderer
  cursors are all tessellated `Graphics`. MSAA costs fill rate rather than draw calls,
  so the 5k-object budget is untouched.
- Connectors were invisible in dark mode. Their default stroke was a constant dark ink
  drawn straight onto the board; it now follows the theme, while an arrow whose
  document carries an explicit colour keeps it in both themes.
- Board previews were cropped to a solid block of colour by `object-fit: cover`, which
  defeats the point of a preview. They are contained now.
- The board header printed the zoom level twice: a readout beside a button also
  labelled 100%. The readout is the reset button.
- The board list was a centred `max-width` page whose margins were most of the screen,
  on a view whose content is a grid of previews. The sidebar shell replaces it and the
  main column's padding came down with it.
- Board previews touched the frame they sat in, which reads as a cropped screenshot
  pressed against the edge. The well is matted now; the padding is on the well rather
  than the image, so the canvas colour still fills it.
- The login card carried a standing line of help that said one of two things whatever
  the user was doing, so it read as filler rather than as guidance. Removed.
- Board previews were cropped flush against the top and bottom of their frame despite
  the padding on it. Two causes, one after the other: a percentage height resolves
  against an indefinite height inside an `aspect-ratio` box, so `max-height: 100%`
  computed to `none`; and once the well had a real height, a grid item's `min-height`
  defaults to `auto`, which floors it at the picture's intrinsic size and beats
  `max-height`. The well has a definite height and the image has `min-height: 0`.
- A preview is captured once and served to everyone, so a background baked into it is
  one client's theme imposed on every viewer: it arrived in dark mode as a white slab.
  The capture is transparent now (webp carries alpha) and the card's well paints
  `--canvas-bg`, so a preview takes the reader's theme rather than the author's, the
  inset around it is invisible because the colour is the same on both sides, and a row
  of differently shaped previews no longer looks ragged.
- **The whole canvas was slightly soft at fractional display scaling.** Windows at
  125% is dpr 1.25, and an element whose height is a round number of CSS pixels is a
  fractional number of device pixels, so everything below it starts on a half pixel:
  measured on this layout, the canvas's top edge landed at 52.5 device pixels. A
  browser cannot blit a bitmap to half a pixel, so it resampled the entire canvas, and
  the board read as blurry at every zoom while the chrome beside it stayed sharp. DOM
  text escapes this because glyphs are rasterised at their final subpixel position; a
  canvas is one bitmap. The engine now nudges its host onto whole device pixels with a
  sub-pixel translate. Both layers live inside that host, so they move together and
  the overlay alignment is unaffected, which `pnpm smoke:overlay` confirms.
- Dropped `will-change: transform` from the text overlay root. It promoted the layer
  and let Chrome rasterise it once and reuse that bitmap, which is exact for a pan and
  wrong for a zoom: type was GPU-upscaled from whatever scale it was last rasterised
  at. Transforms composite either way; the hint only bought the right to skip the
  re-raster that keeps text crisp.
- The connection pill said "Live" beside a green dot permanently. The dot carries it,
  with the word on hover; the pill only speaks up when the state is not healthy.
- The favicon and touch icons carry a rounded cream plate. The mark is neon on transparency,
  which disappears into a dark tab strip; the in-app mark stays transparent, because
  it sits on a surface that is already chosen for it.
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
- **An update can be lost permanently when the last client disconnects.** `YRoom`
  persists with `task_group.start_soon(ystore.write, update)` and `stop()` cancels that
  group without waiting; with `auto_clean_rooms` on, the last client leaving stops the
  room. `PostgresYStore.write` shields its transaction, but the shield is inside the
  function body, so a task cancelled before its body runs never reaches it. The shield
  fixes the case where the write has begun and not the case where it has not. Proven by
  inserting one checkpoint ahead of the shield, which loses every write rather than
  some. Found by CI on a slower machine, where three tests fail on it; a fast local
  machine schedules the task in time and hides it.
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
