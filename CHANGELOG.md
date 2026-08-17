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
- **The app works on a phone.** It had a viewport meta tag and not one width media
  query, so a 15rem sidebar took 60 percent of a 390px screen and the page scrolled
  sideways. Everything added is additive: one `pointer: coarse` block and two width
  breakpoints, chosen from what actually breaks rather than from a device list. At
  860px the sidebar stops leaving room for a useful grid and becomes a drawer with a
  scrim; at 560px the vertical tool rail is taller than the canvas beside it and turns
  into a scrolling bar along the bottom, where a thumb already is. Nothing is removed
  on the way down: every tool, the lock, the grid, the theme control and the sign-out
  are all still reachable, and the keyboard hints in the status bar are hidden by input
  device rather than by width, because a small window on a laptop still has a keyboard.
- **Pinch to zoom and two-finger pan on the canvas.** One finger already worked, since
  the tools run on pointer events and a drag is a drag. Two fingers have no pointer
  event at all: the browser reports two independent streams and leaves the arithmetic
  to the page. Both readings come off the same pair every move, because nobody pinches
  without also moving their hand and a canvas that zooms but refuses to follow the
  drift feels like it is fighting you. The finger that started drawing has its gesture
  cancelled when the second one lands, so a pinch never leaves a stray rectangle
  behind it.
- **A confirmation dialog and toasts**, replacing the last two things in the app that
  spoke through the browser instead of through Meadow. Deleting a glade asked with
  `window.confirm`, which names the origin rather than the app, blocks the main thread,
  cannot be styled, and puts OK where the eye lands first on an irreversible action.
  The replacement is a native `<dialog>` opened with `showModal`, so the browser still
  supplies the top layer, the inert background, the focus trap and Escape, and the app
  supplies the appearance and a destructive-action default of Cancel.
- Toasts in the bottom right, for things that happened rather than things that are
  true: a glade deleted, a create that failed, a write the role refused. A standing
  condition like "you have viewer access" stays a banner on the page, because a toast
  takes itself away and a durable fact should not. Repeats of the same message collapse
  into one with a count, which is what makes them usable for canvas refusals: those
  fire from a pointer handler, so a two second drag on a locked glade used to be a
  hundred identical events. The clock is the progress bar's own CSS animation and
  dismissal happens when it ends, so there is no second timer to drift out of step with
  it, hovering the stack pauses both at once, and a background tab does not burn
  through its notifications unseen.
- **A pre-commit hook**, in `.githooks/` rather than in `.git/hooks/`, so the rules are
  versioned with the repo instead of being whatever each clone happened to copy in.
  `pnpm install` points `core.hooksPath` at it through `scripts/install-hooks.mjs`, and
  every failure mode there is a no-op: the web image runs `pnpm install` in a context
  with no `.git` and no `scripts/`, and a hook installer that can fail is one that can
  stop a deploy over something with no bearing on the running app.
  The hook picks its checks from what is staged. Repo rules always, tsc and vitest when
  `apps/web` or `packages/schema` is involved, ruff and mypy when `services/api` is, and
  a skipped check says so rather than looking like a pass. Nothing in it needs Postgres,
  Redis or a browser, so pytest, the gate, the smokes and the e2e scripts stay in CI: a
  check you cannot run because a container is down is a check people learn to skip.
- `scripts/check-staged.mjs`, which enforces the non-negotiables in `.claude/CLAUDE.md`
  that no linter knows about. `src/canvas/` importing from `src/features/`, a
  `Y.transact` outside `src/doc/`, a second `resolve_role`, an `any`, a default export
  outside a route component, an emoji, a staged `.env` or private key, a conflict
  marker, a file over a megabyte. Added lines only: a rule that fires on everything it
  can see turns a one-line fix into a repo-wide cleanup, and the commit that trips it is
  usually not the one that should pay for that. Style preferences print as notes and
  never block, because a hook that blocks on a judgement call teaches people to pass
  `--no-verify`, after which the real checks stop running too.
- `/fix-precommit.prompt`, the third shared agent command, for diagnosing a blocked
  commit. It maps each finding to its actual fix and rules out the workarounds,
  `--no-verify` included.
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
- **A lock for a glade.** Flip it and the board stops accepting edits: no drags, no
  new objects, no delete, no undo, no typing. It is a guard against your own hands
  while presenting or reading, not a permission, and it is implemented as one term in
  the `canWrite` boolean every mutation already passes through, so every tool and
  shortcut obeys it without knowing it exists. Per-tab, never written to the document,
  never sent to the server, and unlocking grants a viewer nothing.
- Graph paper on the glade surface, in two weights, tracking the camera and stepping
  its cell through powers of four so the spacing stays legible at any zoom. Each line
  is a short alpha ramp rather than a hard stop: a `colour 1px, transparent 1px` edge
  either lands exactly on a device pixel and reads as a wire or straddles two and
  shimmers while you pan. It is a
  CSS background rather than geometry: no draw calls, no fill rate, it follows the
  theme through the same tokens as everything else, and it stays out of thumbnails.
  Toggle in the header, remembered across sessions.
- A workspace shell for the board list: a fixed sidebar with search, four views and the
  account, beside a scrolling grid. Every view is derived from what the list endpoint
  already returns — `recent` from `updated_at`, `owned` and `shared` from the resolved
  role — so none of them is a label over an empty room. Sorting by modified, created or
  name, and cards now carry an "Edited N ago" line.
- **Arrows you can actually steer.** A selected arrow gets three or four handles and
  nothing else: drag either end to re-aim it, drop it on a shape to attach it or on
  empty canvas to detach it, and drag its middle to bend it. Dropping an end writes a
  binding either way, because leaving the old one in place made a detached arrow spring
  back the next time anything reflowed it.
- **Curved arrows, including S curves.** A cubic with a signed bow at each end rather
  than a quadratic with one, and that is the difference between a curve and a bow: one
  number can only lean the whole arrow one way. Opposite signs inflect, which is the
  shape a connector between two boxes on the same row wants to be. A straight arrow has
  one middle handle that bends it symmetrically; once it is a curve each half gets its
  own, solved exactly so the handle stays under the pointer rather than drifting over a
  long drag. The bow is derived from the two endpoints and a fraction, never stored as a
  flattened path, so it is tessellated for the zoom it is drawn at and keeps its shape
  when either end moves.
- A routing picker floating over the selected arrow: straight, curved, elbow. Three,
  because that is all FigJam has and nothing is missing from it. The elbow routing
  existed in the schema and had never been reachable.
- **Labels on arrows.** Double-click a connector and type. Half of what an arrow means
  on a diagram is written on the arrow, and a floating text object parked near one is
  not that, because it does not move when the arrow is re-routed. The label rides the
  middle of the drawn path rather than sitting in the object's box, because a horizontal
  arrow's box is one unit tall. No plate behind it: the arrow's own line is
  broken around the caption instead, which is what a person drawing this by hand does.
  A plate works and puts one more opaque rectangle on a surface whose whole character is
  that it has none, and on any board that is not the default colour it reads as a
  sticker.
- **Text formatting: size, bold, italic, underline, strikethrough.** A bar at the top of
  the canvas, live while a text object, sticky, shape label or arrow caption is being
  edited. The split between the two mechanisms is the document's, not an implementation
  detail: the marks are marks on a range inside the fragment and go through the editor,
  while size is a property of the whole object and is an ordinary patch, so it works on
  a multi-selection with no editor open at all. The mark list is defined by the
  serialiser rather than by the editor, so nothing can be typed that would vanish when
  the editor closed.
- Distribution guides. Dragging an object into a row now equalises the gap either side
  of it, or repeats a gap that already exists further along, and draws each one as a
  measuring bar with end ticks rather than as another alignment line. Resizing snaps
  too, so a column of boxes can be made the same width without typing a number.

- **Sign in with GitHub, and a profile page to go with it.** The button on the login
  card is real now: it starts an OAuth round trip and comes back as an ordinary Meadow
  session, an httpOnly refresh cookie set on the callback's redirect, with nothing in
  the URL. A token in a redirect lands in browser history, the referrer and every proxy
  log on the way, and the whole point of the cookie is that page scripts cannot read it.
  The provider is off unless `MEADOW_GITHUB_CLIENT_ID` and `MEADOW_GITHUB_CLIENT_SECRET`
  are set, and off means the endpoints answer 404 and the client hides the button rather
  than offering one that leads to an error.
  **An account is its email address**, and that is the rule the whole flow is built
  around: a GitHub sign-in whose verified email matches an existing account signs in to
  that account rather than making a second one, whether the first was created with a
  password or not. Matching is on GitHub's numeric user id once linked, so a rename over
  there is a refreshed row here and not a new person. An unverified GitHub email is
  refused outright, because matching on an address nobody has proved is account takeover
  by anyone who can type it into their GitHub settings.
  GitHub's copy of the user lives in `user_identities` and is never written by the
  profile editor: username, name, email, avatar and profile URL are refreshed on every
  sign-in and are what GitHub says, while `display_name` and the avatar choice on
  `users` are what the person chose here. That separation is what makes the profile page
  offering "use my GitHub name" possible at all, and it means no profile edit can
  corrupt the fields an account match is made on. **No GitHub access token is stored**:
  it is exchanged, used once server-side to read the profile, and dropped, so the table
  is not worth stealing.
  `users.password_hash` is nullable now, since an OAuth account has no password. A
  placeholder hash would have avoided the migration and would have been a credential
  nobody holds the input to. Password login on such an account is refused with the same
  message a wrong password gets, because which accounts use GitHub is not something an
  anonymous caller may enumerate.
- **A profile page**, at `#/profile` from the account chip in the sidebar. Display name,
  the picture (the GitHub one or initials, both shown as previews rather than described
  by a switch), and a read-only record of how this account signs in. The email is shown
  and not editable, with the reason in a sentence rather than as a greyed-out box:
  changing it is an account-merge question, not a profile field. Avatars became one
  component, `ui/Avatar.tsx`, replacing three copies of the same `initials()`: a remote
  avatar URL can 404 after a rename or be blocked, so a failed load falls back to
  initials instead of leaving the broken-image glyph. Remote wanderers on the canvas
  still draw as initials in WebGL, which is untouched.

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
- **Rotation moved from a dot above the box to the corners.** Figma's arrangement: the
  gesture lives in the empty space just outside each corner and is advertised by the
  cursor. One less piece of chrome to draw, four places to start it instead of one, and
  it stops occupying the spot a user reaching for the top edge expects to be empty.
- **A selected arrow no longer gets a bounding box, resize handles or a rotation.**
  None of them mean anything for a two-point path: there is no visible sense in which a
  diagonal line is "resized", and rotating about the box centre moves both ends at once.
  Its own handles replace them.
- **Arrow heads are open, not filled.** Two strokes meeting at the tip in the shaft's
  own weight and with its own round caps, so an arrow is one continuous mark rather than
  a line with a solid shape stuck on the end. `triangle` is still there for a document
  that asks for it, and it kept the notched back so the shaft runs into it rather than
  butting against a flat base. The default stroke went from 2 to 3 units, which is also
  the antialiasing fix below.
- A sticky note is blue (`#a8daff`), portrait at 3:3.25, and its corners are tighter than
  every other shape's. A note is a cut square of paper; the more its corners are rounded
  the more it reads as a button, and a square one is a coaster rather than a note. The
  dark variant is a deep blue rather than a pale one, because sticky text follows the
  theme's ink and a pale card would be light type on a light field.
- The delete control in the rail turns red on hover rather than sitting red. Permanent
  red is an alarm nobody is currently causing; red on hover answers "what happens if I
  press this".
- **A creation tool hands the pointer back to select once it has made something.** The
  gesture after drawing a box is almost always adjusting that box, not drawing a second
  one, and holding the tool is the rarer case that can cost a click. Matches every other
  canvas tool worth copying.
- **A sticky note is written like a note.** Text starts at the top-left and fills
  downwards instead of staying centred on both axes. Centring was borrowed from a
  shape's label and it is the wrong model: a caption in a box is a title, but text that
  re-centres itself as you add a second line is unusable for writing more than three
  words. The author's name sits in the bottom-right corner, stamped at creation because
  `createdBy` is a user id and nothing can turn one into a name for somebody who has
  since disconnected. The byline is chrome, not content, so it cannot be typed into,
  selected or deleted, and it never counts towards the note's measured height.
- **Element outlines are darker and connectors are lighter**, which is the reverse of
  what this had. A diagram drawn the other way inverts its own hierarchy: the arrows
  shout and the boxes they connect recede. A box is the thing being said; an arrow is
  the relation between two of them, and it reads one weight quieter. Both themes.
- Presence avatars carry a role badge: a pencil for an editor, an eye for a viewer.
  Which of the people in a room can change it is the one thing about presence that
  changes how you behave, and a row of identical circles does not say it. The role is
  published over awareness and is presentational only; every write is still checked
  server-side, so a peer lying about it changes what a badge looks like and nothing
  else.

### Fixed
- **A NUL byte in `canvas/overlay/textLayer.ts` made the file binary to every tool that
  reads source as text.** It was the sentinel for "nothing has been rendered into this
  node yet", written as the character rather than as `\u0000`. git diffed the file as
  "Binary files differ" instead of by line, grep skipped it without saying so, and the
  new pre-commit rules checker never saw a line of it. Same value, written as an escape.
- The board e2e read the typed sticky caption off the first overlay node's
  `textContent`, and two changes had quietly moved it: shapes became text bearing, so a
  drawn rectangle now mounts a node of its own and sorts first, and a sticky carries its
  author's byline inside the same box. It reads the rich-text nodes now, which is where
  a caption actually is.
- **The canvas rendered with antialiasing off, so every diagonal was a staircase.** The
  reasoning was that the SDF batch antialiases itself with `fwidth` and does not need
  MSAA, which is true of the batch and irrelevant to the rest of the frame: arrows,
  lines, the marquee, the selection box, the handles, the guides and the wanderer
  cursors are all tessellated `Graphics`. MSAA costs fill rate rather than draw calls,
  so the 5k-object budget is untouched.
- Text that never chose a colour was near-invisible in dark mode: the schema's default
  is a dark ink, right on paper and wrong on a dark board, so a caption sitting
  straight on the surface came out barely darker than the surface. It follows the theme
  now, on the same terms as connectors below - only ever a default, and an object whose
  document carries an explicit colour keeps it in both themes.
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
- The wanderer cursor was a four-point polygon, so its right wing and its tail were
  the same edge and the arrow came out pinched on that side. Seven points now, which
  is what an arrow needs. Its name plate was rasterised at the renderer's resolution,
  which lands the glyphs between pixels at fractional display scaling and read soft;
  it rounds up now, and the text is centred in a fixed-height plate rather than inset
  from the top, so a plate no longer sits high or low with the glyphs in a name. The
  weight came down from 700 to 500.
- Chrome was selectable. A logo, a nav label or a button caption highlighting because
  a drag started on it is the tell of a web page pretending to be an app, and on a
  canvas tool a drag that begins on the toolbar left a trail of selected UI behind it.
  Form fields and canvas text still select; nothing else does, and the logo no longer
  drags as a ghost image.
- The connection pill said "Live" beside a green dot permanently. Connected is the state you
  are in essentially always, and a permanent indicator for it is the app reporting
  that nothing is wrong, forever. It appears only when something is.
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
- **A text object nobody typed into stayed on the board forever.** The text tool creates
  the object and opens an editor in one gesture, so clicking the canvas and changing
  your mind left a zero-content object behind. It paints no box, so it was invisible -
  and still in the document, still in the index, still selectable, still synced to
  everyone. An empty one is discarded when the editor closes. Only standalone text: a
  blank sticky is a deliberate card, and a blank label belongs to the shape that owns it.
- The overlay pools its DOM nodes, and the arrow-label plate set a background and a
  radius that `applyContentStyle` did not reset, so a node that had been a label carried
  a grey band onto whatever plain text object reused it. Both the pool and the style
  function clear them now.
- An elbow arrived past the corner of the shape it pointed at, floating beside it. Its
  endpoint was solved against the straight line to the far end, which is right for a
  line that travels that way and wrong for a route whose last segment is horizontal or
  vertical. A centre-anchored endpoint on an orthogonal route is now aimed along the
  dominant axis, so it lands in the middle of the edge the route approaches from.
- Dragging the middle of an elbow sprang it into a curve. An elbow's shape *is* its
  routing, regenerated from its two ends on every solve, so a handle there could only
  have meant "stop being an elbow" - which is not something anybody asks for by grabbing
  a corner. It has no bend handle at all now.
- **The middle of an elbow is a handle that slides its dogleg**, and getting there took
  two wrong answers. The first turned the elbow into a curve, which is not what grabbing
  a corner means. The second removed the handle entirely, which was worse: the press fell
  through to the arrow itself and started a *move*, and moving an arrow with one end
  pinned to a shape stretches it, so reaching for the dogleg sent the connector across
  the board. Its position is one fraction on the arrow rather than stored waypoints, so
  it survives either end moving and cannot disagree with the route.
- An elbow drew as a straight line for the whole of the drag that created it and snapped
  into shape on release, which made it impossible to aim. It is routed as it is drawn.
- An elbow arrived past the corner of the shape it pointed at, floating beside it. Its
  endpoint was solved against the straight line to the far end, which is right for a line
  that travels that way and wrong for a route whose last segment is horizontal or
  vertical. A centre-anchored endpoint on an orthogonal route is now aimed along the
  dominant axis, so it lands in the middle of the edge the route approaches from.
- **Text on a shape could be clipped away to nothing, and the words were still there.**
  A label is centred on both axes, so a block taller than its box is cut at *both*
  ends: raise the size and the first and last lines go, raise it further and the whole
  caption does. It reads exactly like the text was never written, and there is no way
  from the outside to tell that it was. Labels are not clipped at all now - text that
  does not fit spills, centred and legible. Overflowing is visibly wrong in a way
  somebody can see and fix; clipping is invisibly wrong.
- A label in a diamond or an ellipse is laid out in the largest rectangle that fits
  *inside the shape*, not inside its bounding box. The corners of the box are outside
  the shape, which is why a caption that visibly had room still ran out over a slanted
  edge. Half the box for a diamond and 1/sqrt(2) of it for an ellipse, both centred.
- The overlay's two style functions disagreed about which properties they owned:
  `applyArrowLabelStyle` set `align-items` and `overflow` on top of `applyBoxStyle`,
  which set neither back. Overlay nodes are pooled, so a node that had been an arrow
  caption laid the next object's text out shrink-to-fit and unclipped, and the words
  ran out of the shape instead of wrapping inside it. There is now one function with a
  variant, assigning every property it cares about every time, and `beginEdit` and
  `endEdit` no longer poke at style behind its back - which is separately how a
  caption's `overflow: visible` came back as `hidden` and clipped anything longer than
  the label box's guess.
- Switching an arrow to the elbow routing left it drawn as a straight line. An elbow's
  waypoints are stored rather than derived, and writing the routing was never generating
  them; switching away was never dropping them either. Changing a routing now rebuilds
  the points and re-solves the bindings, since where an end sits depends on the route.
- Double-clicking a curved arrow, or clicking one to select it, tested the straight line
  between its endpoints rather than the drawn path, so the bow itself was unclickable and
  the empty space inside the curve was not. Hit-testing and rendering derive the path from
  one function, and a curved arrow's bounds are measured over that path rather than over
  its two endpoints - otherwise it is culled while the bulge is still on screen.

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
