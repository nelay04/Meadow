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
- **A parallelogram, the fourth primitive.** `G` draws one, or pick it out of the shape
  button on the rail. It is a real primitive rather than a sheared rectangle: another
  branch in the instanced SDF shader, so five thousand of them still cost the one draw
  call every other shape costs, and it carries a label like every other shape.

  The slant is geometry, not styling, and it is defined in exactly one place. Four
  things have to agree about where the edges of this shape are - the shader that paints
  it, the click that selects it, the arrow that stops on it, and the caption laid out
  inside it - and four copies of the same number is four bugs: a click that misses the
  shape it landed on, an arrow that stops in mid-air beside it, a caption that runs out
  over the slanted edge. So `parallelogramSlant` is the one definition and all four read
  it. The lean is a proportion of the shorter side rather than of the width, so a wide
  flowchart box and a narrow one lean at the same angle instead of one of them being a
  sheared ribbon.

  A label keeps the full height and loses only the slant off each end of every line.
  The fit inside a shape used to be a single ratio applied to both axes, which is right
  for a diamond and an ellipse and wrong here, because a parallelogram's top and bottom
  edges are horizontal and there is nothing to lose vertically.

- **A pen, with five nibs and a nib is a shape rather than a setting.** Pick it up with
  `P` and draw. What comes out is one object on the canvas like everything else: it
  drags, it selects, it deletes, it undoes, and it is one undo step per stroke rather
  than per twitch of the hand.

  The five are a ballpoint, a fineliner, a calligraphy nib, a brush and a highlighter,
  and they are not five presets on one line. Each is the region swept by a shape pulled
  along the path: a disc whose radius answers to pressure, or a blade held at a fixed
  angle. That is why the calligraphy nib is broad on a downstroke and a hairline on a
  cross-stroke without anything measuring the direction, and why the highlighter is
  simply that blade turned a quarter and made translucent. Width, colour and the angle
  a cut nib is held at are chosen in a flyout beside the pen, before the stroke rather
  than after it, and the pen you left it set to is the pen you get back next time.

  **Width comes from speed when it cannot come from pressure.** A stylus reports how
  hard it is being leant on; a mouse reports a constant, and a constant is a line of
  uniform width, which is the flattest a stroke can look. So on a mouse or a finger the
  nib takes its width from how fast the hand is moving, which is what a real nib does,
  because a hand moving fast has less time to press. It is the difference between
  mouse-drawn ink that reads as handwriting and mouse-drawn ink that reads as a graph.

  **The pen stays in your hand.** Every other creation tool hands back to select once it
  has made something, because you usually want to adjust what you just drew. Nobody
  draws one stroke, so this one does not. `V` or `Escape` puts it down.

  A stroke lands in the document when the pointer lifts, not while it is moving, so
  somebody else on the board sees a finished stroke rather than a growing one. Their
  cursor still moves, so the board is not frozen; what this buys is one object and one
  undo step per stroke instead of a document write per sample.

- **The rail's flyouts put themselves away.** Both of them used to be tied to which
  tool was in your hand, which meant neither could ever close: the pen stays in your
  hand across strokes on purpose, so its nibs sat over the board for the rest of the
  session. Touching the canvas now dismisses whichever one is open, because starting to
  draw is the clearest possible sign that you are done choosing what to draw with. The
  arrow's goes one better and closes on the choice itself, since picking a shape is the
  whole errand there. Pressing the button of the tool already in your hand is how you
  get a flyout back, or put it away without drawing.

- **A lea has pages now, and the diary lists them beside the paper.** A notebook that
  could only ever be one page is a diary to look at rather than one to keep: the only
  answer to a full page was another ten rules on the end of the same one. *New page*
  starts a fresh sheet with the caret already on its first line, and every page in the
  book is a row down the right hand side, titled by its own subject. Click one and the
  diary turns to it. There is no second name to keep in step - the title in the list is
  the line you write at the top of the page - and a page nobody has titled says so
  rather than inventing one.

  One line per page, set the way a book's contents are: number, title, length, and the
  way to tear it out. It was two lines with a little ruled sheet standing in for the
  number, which gave every row three left edges and a column of identical thumbnails of
  the one thing every row in the list already is. Tearing a page out asks in the same
  modal the board list asks with, in the middle of the screen, rather than in a strip
  inside the row being deleted: one way of putting a destructive question in this app,
  and it is the one that cannot be mistaken for part of the thing it is about.

  A page is a strip of the world, not a document. A row is still one ordinary `text`
  object and the CRDT schema has not moved; the row sits at `(slot * stride, band *
  spacing)` now, and which page it is on is *where it is*, exactly as which rule it is
  on is where it is. Nothing is stamped onto a row, so a client that has never heard of
  pages still renders one correctly.

  Pages are side by side rather than stacked down one column, and the slot a page sits
  in is handed out once and never reused. Both of those are about what happens later:
  sharing a column would mean lengthening page one moves every line of every page after
  it, and a reused slot would hand a torn out page's writing to whatever page took its
  place.

  Which page you are on is yours. It is not written to the document, because two people
  reading one diary are rarely on the same page. Turning a page re-fences the camera and
  lands at the top of the new one; the caret, the selection and any scrolling still owed
  to the wheel stay behind with the page they belonged to.

  Tearing a page out takes the writing on it, asks first, and cannot be undone. Undo is
  scoped to the objects, so an undo of the delete on its own would put the writing back
  without the page: rows in a strip of the world nothing can scroll to, which is worse
  than the delete being final. Being final is why it asks, and why the last page in a
  diary cannot be torn out at all.

- **The page list is a column of the view, not a panel over it.** So the paper
  re-centres into what is left rather than sitting underneath the list, with nothing
  having to tell the engine that a sidebar opened: a lea is centred in the canvas host,
  and the host is what narrows. It closes from its own header as well as from the board
  bar, and stays closed across visits, which is a preference of this browser rather than
  of the diary. Under 900px wide it floats over the desk after all, because by then what
  is left of the window is narrower than the measure the whole surface exists to hold.

  A closed list leaves a handle on the edge it came off, carrying the number of pages
  behind it. The board bar has the same toggle, but a button in a row of eight icons is
  not what somebody looks at when they wonder where their pages went - the first person
  to close the list could not find it again, which is the whole argument.

- **Wheel scrolling is eased rather than applied on arrival.** A mouse wheel does not
  send a stream: one notch is a single 100px event, and moving the camera the moment it
  lands is a jump. On a lea that read as a stutter, because a page of ruling is a
  repeating pattern and the eye tracks it. A wheel event now adds to a target and the
  render loop walks toward it exponentially, against elapsed time so it takes the same
  wall clock at 60Hz and at 144. No gain on the delta: smoothing is about when the
  movement happens, not how much of it there is. `deltaMode` is honoured, so the
  browsers that measure the wheel in lines or pages scroll the same distance as the
  ones that measure it in pixels. Zoom stays immediate, because easing a move anchored
  to the pointer slides the thing you are pointing at out from under it.

- **A lea can be printed on other paper, and you can say what your default is.** Four
  stocks: vintage kraft, light, dark, and one that matches the theme. The page's own
  choice lives in the document beside its date and subject, so stationery travels with
  the diary and everyone opening it sees the same page; the profile setting is the
  other question - what a page that never chose should look like *to you* - and lives
  in this browser beside the theme. A page set to Default takes the reader's.

  A stock is five variables and nothing else: pulp, mottling, ruling, ink, desk. Every
  layer above is written against those, so adding one is a `[data-paper]` block and a
  name in one list, with no change to the engine and none to the header furniture. The
  engine still learns its ink the way it always has, by reading the host's `color` back
  off the cascade, so the writing follows the paper without a second copy of the
  colours to keep in step.

- **Glades have kinds, and the first new one is a lea: a diary.** Kraft paper, ruled for
  writing, on a fixed column you scroll down rather than a plane you fly over.
  `boards.kind` is a string with a check constraint, backfilled to `glade`, and "glade"
  stays the word for a board of any kind rather than becoming the name of one of them.

  **Every rule is its own writing slot**, the way a spreadsheet's rows are. Click the
  tenth or the hundredth and the caret is there; the ones between stay empty rather than
  having to be typed past. A row is an ordinary `text` object at `(0, row * spacing)`
  carrying the page's type, created on the click that needs it and discarded again if
  the caret leaves without anything typed, so clicking around a page does not litter it.
  This replaced a single flowing column, which was the same idea in text-box form: it
  could only be appended to, and where line fifty fell depended on how much had been
  written above it rather than on where you pointed.

  Nothing in the CRDT moved. A lea is the same Y.Doc and the same flat `objects` map,
  and its page is one ordinary `text` object; a client that has never heard of leas
  renders it correctly. The kind decides three client-side things: the surface, which
  tools the rail and the keyboard offer, and whether the camera is fenced. The fence
  lives in `Camera` rather than at the call sites, because a camera can be moved from
  six places and a rule enforced at each of them is a rule missing from the seventh.

  The ruling is spaced at exactly one line of the column's type and phased to its
  baseline, so the writing rests on the lines instead of walking off them down the page.

  The page is not an object you select. One click anywhere on it starts writing on the
  rule you clicked, and there is no selection box, no resize handles
  and no formatting bar until the caret is actually in the page. Select-then-double-
  click-to-edit is how you handle an object lying on a canvas and not how anybody
  handles paper. The page also cannot be deleted, and leaving it clears the selection,
  so the toolbar's delete button never quietly arms itself against the paper while the
  chrome that would have shown it is hidden. Anything else added to a lea with the text
  tool selects, moves and deletes normally.
  That needed a new `paragraphSpacing` text prop: the 0.4em between blocks is right for
  a note and puts every paragraph on a ruled page a little lower than the last. The size
  control is gone from a lea's formatting bar for the same reason - the ruling is spaced
  at one line of the page's type, so a size chosen per paragraph is a paragraph that no
  longer sits on the lines. Weight and slant stay; the measure belongs to the paper.

  The type is 21/1.45 rather than 16/1.75 - the same rule pitch with bigger letters in
  it. Size and leading move together on purpose, because the ruling is spaced at
  `fontSize * lineHeight`: growing the type alone would push the lines apart rather
  than fill them, and at the smaller size the writing floated in the middle of each
  band with air above and below. Type that does not fill its line does not read as
  written *on* anything.

  Phasing the ruling to the type is now a measurement rather than a fitted constant.
  It was a fraction of the font size, calibrated by driving a real page, and the
  trouble with that is that it is only right for the size it was fitted at - the first
  step up in type walked the writing six pixels off the rules. The engine now lays out
  one line in the offscreen measurer, reads where the browser put its baseline, and
  phases the rules to that. Measured over a driven page: **the baseline lands on the
  rule within 0.03px, at device scale 1, 1.25 and 1.5.**

- **Fixed: you could not click into an empty rule between two written ones.** The
  writing went to the end of the line above instead. A row's box was one line plus its
  padding top and bottom, on a page whose rules are one line apart, so every row
  overlapped the band below it; the click then hit-tested the objects before falling
  back to the rule, and a hit test carries a tolerance on top of that. Rows are now
  exactly one band tall - the margin beside the writing is the paper's, not the row's -
  and on a fenced page the rule you clicked is the only thing that decides. A row that
  has wrapped over several rules still takes a click on any of them, so long writing is
  continued rather than written over.

- **Fixed: a lea written before the type changed had its writing walking off the
  rules.** A row's position is a band index times the rule pitch, and the pitch is the
  page's own `fontSize * lineHeight`. Change the type and every row already in the
  document is anchored to a pitch that no longer exists: measured on a page written at
  16/1.75 and reopened at 21/1.45, the first line was still right and each one after it
  was a further 2.45 units out, so by the tenth the writing sat half a band above its
  rule. It read as the page coming apart rather than as a setting that changed.

  Opening a ruled page now puts its rows back on the ruling, in the order they already
  sit in and never merging two onto one rule. Same page after the repair: rows at 0,
  30.45, 60.9, 91.35, 121.8 and every baseline within 0.02 of where it belongs. A
  no-op once a page is on its bands, so it costs a scan and no write from then on.

- **A lea is a page now, not an endless roll.** Twenty-five rules and then paper stops,
  with an *Add 10 lines* button past the last one when you need more. Writing into something
  with no bottom is a different feeling from writing into something with an end, and a
  diary is the second one: the point of a page is that you can fill it. The length
  lives in the document's `meta` root, so lengthening a page sticks and reaches
  everyone on it.

- **The page has a printed header: a subject, and a date.** Two short lines above the
  writing, the way stationery prints them, set in the page's own type so they scale
  with it. Both are page values in `meta` rather than objects on the canvas - a note on
  a page could sensibly exist twice, a page's date could not.

  The date is a picker, and the calendar is ours. `<input type="date">` was the first
  answer and is the better one on paper - it knows about locales, keyboards and screen
  readers, and costs nothing - but two things ruled it out. Its face cannot be told to
  print `28th May, 2026`, which is how a diary writes a date and no locale does; and
  the popup it opens is the browser's, which on a page of kraft arrives looking like a
  different application. What was kept is what mattered: a real button, real keys, and
  a labelled dialog.

  Both fields fought the app's own form styling, which is worth writing down because
  the same trap is one line away anywhere else on this surface: turning a border off
  does not turn off `input:focus`'s ring, which is a `box-shadow`, and resetting a
  button's resting state leaves `button:hover` free to paint a full-width bar of
  app-coloured surface across the page. On this surface every state has to be stated.

  Where the writing sits on its line was measured rather than eyeballed: an `<input>`
  centres its text in its content box and a `<button>` bottom-aligns its span, which
  put the date 13.3px above its line while the subject sat 1.3px above its. The
  correction is the difference between those two numbers.

- **The first line clears the toolbar.** A page whose writing opens under the chrome
  reads as clipped. The air above the first rule is now two numbers rather than one -
  the header is stationery, the margin over it is about the app - so changing the
  toolbar moves one of them and not the other.

- **Ctrl and the wheel zoom a lea**, between half and twice its set size. The zoom used
  to be pinned at 1, on the reasoning that a zoom control over a column of text is a
  font-size control wearing a magnifying glass. True, and beside the point: a page you
  cannot zoom is a page somebody with tired eyes cannot read. The band is narrow so the
  measure the surface is built around still means something.

- **The writing sits a unit clear of its rule** rather than resting exactly on it.
  A baseline on the line is the typographically correct answer and it reads a shade
  high: a letter's optical weight sits above its baseline, and the eye puts the word
  where the weight is. Three was enough for the rule to visibly cross the feet of the
  letters, and it walked back from there through zero - a baseline exactly on the line -
  to a hair of daylight underneath. One constant, `WRITING_DROP`, negative for lift.

- **Up and Down move between the rules of a lea.** Every rule is its own object, so
  Down at the end of a line was a key that did nothing; now it steps to the next rule,
  making it if nobody has written there yet, and Up steps back. Up from the first rule
  stays put, because the page has a top. Writing that has wrapped over several rules is
  stepped through line by line first, so the keys behave like a caret inside a
  paragraph and like a cursor between cells at its edges. The neighbour is worked out
  from the band rather than from any ordering in the document, so a row a peer wrote
  between two of yours is stepped through like any other.

- **No text tool on a lea.** On a ruled page you click a rule and write on it; a button
  that places a text box is a second way to do the same thing, and it puts the writing
  somewhere the rules are not.

- **No connector dots on a lea.** Four blue dots followed the pointer around the page,
  offering to start an arrow from whatever it was over. There is no arrow tool on a
  diary, so nothing was behind the offer. They are gated on the surface offering arrows
  at all rather than on the kind, so a surface that adds them back gets them back.

- **The page's side margins are narrower**, 36 world units either side of the writing
  rather than 56.

- **A lea's rows are set in the page's type, not the type they were written in.** The
  metrics are still written onto each row, so a client that has never heard of this
  kind still renders one sensibly, but the surface overrides them when it draws. Two
  copies of a number that has to agree, and the rules are drawn from one of them, so
  it cannot be the copy frozen into a row somebody typed a year ago. Without this,
  changing the page's type left every existing lea with its old writing stranded
  between the new lines.

- **Fixed: text changed colour the moment you stopped typing.** The idle text layer
  falls back to the surface's ink for an object whose document names no colour; the
  editor did not, and took the schema's default instead. On a lea that is navy ink on
  brown paper and impossible to miss. It was there on a dark glade all along and simply
  looked like the caret being a different shade. `EngineHost.beginEdit` now takes the
  ink, so both paths apply the same rule with the same limit: an object that names a
  colour keeps it.
- Board list rebuilt around the kind registry in `features/boards/kinds.ts`. The
  sidebar's Kinds group, the create composer, the card badges, the card previews, the
  tool rail and the page geometry all read off that one array, so a third kind of glade
  is one entry there plus one value in `board_kinds.py`.

  Every control now appears only where it has an answer. Ownership left the sidebar for
  a header dropdown, because "owned by me" is a question about the list you are looking
  at rather than a place to go, and it was taking the same weight as a whole kind of
  board. Creating happens on a kind's own page and nowhere else: the composer there
  already knows what it is making, and any control on the mixed views would be the one
  place that has to ask an extra question first. Kind badges appear only on the mixed
  views, since under a heading that says Leas a Lea badge per row is the heading
  repeated once per card. Coming back from a board returns you to the view you left
  rather than to Everything.
- The two header filters are real dropdowns rather than native `<select>`s. The closed
  control was never the problem; the options list is drawn by the operating system with
  square corners and its own typography, and no CSS reaches inside it, so on a page made
  of soft-edged cards the one control with a list behind it looked imported. Rebuilding
  it also freed the chevron, which a browser jams against the right border.
- Boards are renamed on their own header rather than named before they exist. Creating
  from the New menu does not ask for a name at all: a form standing between you and the
  thing you came to do is a toll, and the title is one click away in the place you are
  looking when you decide what the board is.
- Theme moved out of the chrome and into Profile, under Appearance, as three visible
  options rather than one button cycling through three states. Cycling is right in a
  toolbar with room for one control and wrong on a settings page, where the question is
  what the options are and a button that answers only by being pressed twice is a
  puzzle. `boards.kind` previews follow the same principle: a lea shows its mark rather
  than a capture, because a page of body text at card size is a grey smudge and every
  page's smudge is identical.
- `Camera.setFence`, `CanvasEngine.setColumn` and `CanvasEngine.setAvailableTools`. The
  last of those exists because hiding a tool button does not unbind its shortcut: a lea
  with no rectangle in the rail still drew rectangles on R until the engine, rather than
  the toolbar, was the thing that knew.
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
- The whole app runs in Docker with hot reload, from
  `docker compose -f docker-compose.local.yml up -d`. uvicorn reloads on a Python edit,
  vite hot-reloads on a TypeScript one, and watchfiles restarts the arq worker.
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
  nobody holds the input to. (Both halves of that were later revised: see Reversed
  below. No new account can be passwordless, and the refusal for one that already is
  now says so rather than imitating a wrong password.)
- **A profile page**, at `#/profile` from the account chip in the sidebar. Display name,
  the picture (the GitHub one or initials, both shown as previews rather than described
  by a switch), and a read-only record of how this account signs in. The email is shown
  and not editable, with the reason in a sentence rather than as a greyed-out box:
  changing it is an account-merge question, not a profile field. Avatars became one
  component, `ui/Avatar.tsx`, replacing three copies of the same `initials()`: a remote
  avatar URL can 404 after a rename or be blocked, so a failed load falls back to
  initials instead of leaving the broken-image glyph. Remote wanderers on the canvas
  still draw as initials in WebGL, which is untouched.
- **Sign in with Google, next to GitHub**, and one implementation behind both. Adding
  the second provider was mostly the work of making the first one stop being about
  GitHub: a provider module now answers exactly one question - who is behind this
  authorization code, and is their email verified - and everything carrying a security
  decision is shared. State, its single use, the provider it was minted for, the order
  of the checks, the open-redirect reduction, and how a profile resolves to an account
  are one copy each, and `app/api/v1/oauth.py` builds the same pair of routes for every
  entry in the provider registry. A check that held for GitHub and quietly did not hold
  for Google is the failure this shape is meant to make unwritable.
  **Both providers on one verified email are one account**, which is the same rule as
  before and now has something to prove itself against: sign in with Google, then with
  GitHub on the same address, and there is one account with two linked identities, one
  workspace, and the name the person already had. Matching is on Google's `sub` rather
  than the email, so a Workspace address change over there is a refreshed row here.
  Google's profile is read from the OpenID `userinfo` endpoint rather than by decoding
  the `id_token`: both are authoritative, but a JWT is worth what its signature check is
  worth, and a TLS call carrying a token Google just issued needs no JWKS handling at
  all. `email_verified` is checked against the boolean and the string form, because
  `"false"` is truthy if read carelessly. The authorize request asks for
  `access_type=online`, so Google issues no refresh token to not-store.
  The profile page grew with it rather than gaining a second column of the same thing:
  the picture is chosen from every linked account that has one plus initials, and
  `avatar_source` names a provider, so a Google picture is not replaced by linking
  GitHub later. Each unconnected provider carries its own Connect button in its own row,
  because a stack of buttons under a list has to repeat the provider's name to say what
  it acts on. Each provider is independent in configuration too - either, both or
  neither, with an unconfigured one hidden rather than offered as a button that 404s.
  One fix worth naming: a Google avatar loaded as a broken image while GitHub's was
  fine. `lh3.googleusercontent.com` answers 403 to a cross-origin request carrying a
  Referer, and the site sends one by default, so the `<img>` now sets
  `referrerpolicy="no-referrer"`. Nothing needs a referrer sent to a third-party CDN.
- **The splash video greets a new account only.** It played on every login, which makes
  a welcome into a toll. Now it plays once, when the activation link opens the account,
  which is the moment a registration actually finishes.
- **Registering now confirms the address.** Every door - the password form, GitHub,
  Google - writes the account and stops there. The row holds the email so nobody else
  can claim it, and no method signs in to it until the link in the activation mail is
  followed. `POST /auth/register` answers 202 with no session, because a session for an
  account every other endpoint refuses is a lie the client would have to unpick;
  `/auth/activate` spends the link and issues the session there, since the click is what
  proves the address is theirs. The link is 256 bits, stored as a sha256 digest, single
  use, and expires in a day, exactly like a refresh token and for the same reasons.
  Asking for a new one retires the old, so two working keys never sit in one inbox.
  The mail is `multipart/alternative` and its own design: the app's light palette as hex,
  Inter with real fallbacks, table layout and inline styles because Gmail strips a
  `<style>` block and Outlook renders with Word, and the destination printed as text
  under the button - a button whose target cannot be read is what a phishing mail looks
  like. Sending is stdlib `smtplib` on a worker thread rather than another dependency.
  A relay that refuses does not lose the registration: the account stays, unactivated,
  and the screen offers to send the link again. With `MEADOW_SMTP_HOST` blank the
  account is opened immediately and the API warns about it on every registration, which
  keeps a development machine working and is a misconfiguration anywhere else.
- **Forgotten passwords, and first passwords.** "Forgot password?" sits at the end of the
  password field's own label on the login form, because that is where the thought occurs,
  and the profile page has the same thing as "Set a password" for an account opened
  through GitHub or Google that has none. They are one request: adding a first password
  and replacing a lost one both mean "prove you read mail at this address, then choose
  one", and only the wording of the mail differs. The link runs on the activation
  machinery - `email_verifications` grew a `purpose` rather than a near-identical sibling
  table - and neither kind can be spent at the other's endpoint. It lasts an hour rather
  than a day, and spending it revokes every refresh family on the account including the
  browser doing the resetting: somebody resetting a password they did not lose thinks
  another person has it, and leaving that person's session alive would make the reset
  decorative. The reset form is its own screen at `#/reset/<token>`, with the token in
  the fragment so it never lands in a server or proxy log, and it renders before the
  session check because whoever holds the link is proving the account is theirs.
- **Registering, signing in, and connecting are told apart, through every door.** The
  OAuth flow now carries an intent: `?intent=register` from the Register tab, `login`
  from the other one, `link` from the profile page, stored in the state rather than in
  the callback URL, because everything in that URL is attacker-supplied by the time it
  returns. Registering an address that already has an account is refused and points at
  Log in; signing in with an address that has none is refused and points at Register.
  Both messages name what to do next, which the old generic refusals could not.
- **Fixed: Connect could sign you in as somebody else.** Signed in as `a@example.com`,
  pressing Connect and authorising a provider account whose verified address is
  `b@example.com` swapped the session to whichever account held `b@` - the flow had no
  idea it was a connect attempt, so it fell through to the ordinary "same email, same
  person" match. It is now its own intent: the account being connected is fixed from the
  session before leaving the site and travels in the state, the callback attaches the
  provider to that account or refuses with `email_mismatch`, and no session is issued on
  that path at all. Connecting also returns to the profile page rather than the login
  screen, since the person was never logged out.

### Reversed
- **The stock a lea is printed on is the diary's, not the page's.** It was a page value,
  decided in the same unreleased block above: stationery travels with the page, so
  everyone who opens it sees the same paper. That was right while a lea was one page.
  With several, turning from kraft to dark halfway through a notebook reads as a bug
  rather than as a choice, because a real notebook is bound with one stock. The control
  is in the same place, does the same thing, and now does it to the whole lea. The key
  in `meta` is unchanged, so no page written before this loses its paper. Ruling,
  length, subject and date stay per page, which is the line that matters: the paper is
  the book, the writing is the page.
- **The lea's spiral binding is gone.** A fixed strip down the left of the viewport with
  tiled CSS coils and punched holes, and the tool rail pushed clear of it. It read as
  hatching rather than as a binding at the size it actually appeared, and the version
  that read correctly at a crop read as decoration at full size. The page is better
  without it and the rail is back where it was on every other board.
- **The lea's first paper was cream with pale blue rules**, two shades off the app's own
  surface. That is an exercise book. It went to kraft stock with thin dark rules, and in
  the process the whole lea palette moved outside `light-dark()`: a sheet of paper does
  not invert at night. The desk it lies on is themed instead, which is the part of the
  picture that is a room rather than a thing.
- **The create composer's kind picker is gone**, one commit after it was added. A row of
  pills choosing what to make, sitting under a sidebar heading that had already chosen,
  is two controls disagreeing in front of the user. The sidebar's Kinds group is the
  switch; the composer states what it will make and does not offer to change it.
- **A provider sign-in no longer creates an account by accident.** The first GitHub or
  Google sign-in used to register one silently. What that cost was an account nobody
  meant to open: pick the wrong account at a consent screen, or sign in with a work
  address when the real account is on a personal one, and Meadow made a second empty
  account and put you in it. Signing up with a provider is still possible and is now
  something you ask for - the Register tab sends `intent=register` - while pressing Log
  in with an unknown address is refused with `no_account`. (This landed in two steps: it
  was first removed outright, making registration password-only, and then brought back
  behind the intent. The intermediate state is not in any release; the reasoning is kept
  because the second version only makes sense as an answer to the first.)
- **Login and registration name their refusals.** Both used to answer every failure with
  one message so that neither could be used to enumerate accounts. The protected fact
  was worth little; the cost was that the two cases a real person hits - an address that
  never registered, and one that registered through another door - were told only "no",
  which reads as the app being broken rather than as an instruction. Now `/login`
  distinguishes an unregistered email, an account with no password, and a wrong
  password, and `/register` says an email is already registered. The trade is accepted
  deliberately: account existence is probeable, with only the rate limits (5/min login,
  3/hour register, per IP) holding it down, and nothing past existence is revealed. The
  test that pinned the old behaviour is rewritten to pin the new one, including why.
  One exception stayed quiet: `/auth/activation/resend` says nothing either way, because
  it posts mail to an address the caller chose and a caller who can tell hits from
  misses can use it to find live addresses.

### Changed
- **The four shapes share one button on the rail.** The rail had ten buttons and four
  of them were the same decision asked four times, which is what made a column of tools
  read as a list of things to consider. They collapse the way the connector's three
  routings already do: one button, and the family behind it, with a folded corner
  saying there is more in there.

  The button says which shape it is holding. While a shape is armed it wears that
  shape's own icon and the rail's active colour, so what the next drag will draw is
  readable without opening anything; once the shape has been used the tool hands back
  to select and the button goes back to the family's mark, because a button still lit
  for a tool that is no longer in your hand is a button that is lying. The keyboard
  moves it too - `R`, `O`, `D` and `G` still arm a shape directly, and the rail follows.

- **The board list stopped wearing the diary's paper.** A lea's card preview and its
  kind badge were printed in kraft, and the composer's pill with them, so that the grid
  said what a thing was before you had read a word of it. Wrong surface for it: the
  boards page is the app talking about a diary rather than the diary itself, and a
  swatch of kraft was the one thing on a dark screen that did not follow the theme. The
  preview keeps its ruling, drawn in the theme's own line colour on the theme's own
  surface; the mark and the word Lea carry the kind, which is what they were for.
- **Light, dark and match-theme are plain sheets now.** Colour and ruling, and nothing
  else: no fibre, no pulp, no mottling, no aged edges. Those layers are what make kraft
  read as paper rather than as a brown rectangle, and on a white or a near-black sheet
  the same noise has nothing to be the grain of - it reads as a wash of damp across the
  page. Vintage keeps every layer it had, which is what the texture was built for.
- **The dark stock is the app's own dark surface, `#171c23`.** It was a warm near-black
  of its own, which is what a kraft page looks like with the lights turned off. This is
  a dark page rather than a dimmed one, so it takes the colour every other dark surface
  in the app is drawn from, and the desk under it takes a step further down. The ink
  stays warm: white on near-black is a terminal, not a diary, and cream on navy is a
  combination paper has actually been printed in. Match-theme's dark half is the same
  values, because it is the two stocks and never a palette of its own.

  The desk also had to move for a second reason. It was a step *lighter* than the sheet
  in the light theme, which makes the page read as a hole cut in the desk rather than
  something lying on it - invisible while a texture painted over the difference, and
  obvious the moment the sheet went flat.
- **Running the app locally no longer takes a flag.** `api`, `worker`, `web` and
  `migrate` sat behind `--profile app`, so that they did not hold `API_PORT` and
  `WEB_PORT` for anyone running those two servers on the host. The protection was worth
  less than it cost: it put the flag on the ordinary case, which is to run the app, and
  the ports it defended are wanted only when you have deliberately chosen the other
  arrangement. A plain `up -d` is the whole stack now, and the host flow asks for
  `postgres redis pgadmin` by name. `pnpm local`, `pnpm local:data` and `pnpm local:down`
  are the three commands without a file path to remember.

  The M0 gate was the one thing that genuinely needed the port, because it starts an API
  and restarts it mid-run to prove persistence against a cold process. It has a port of
  its own now, 8013, the same way `board-e2e` and `presence-e2e` already had 8014 and
  8016. Nothing in the repo has to be stopped before running any of the three.
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
- **A preference changed in one tab never reached the others.** The diary paper and the
  theme are settings of this browser: they live in `localStorage`, which every tab
  shares, and they are announced with a `CustomEvent`, which no other tab hears. So a
  lea open in one window kept the stock it had read at mount while the profile in
  another window had already changed it, and the profile's own radios sat on a stale
  answer for the same reason. `storage` is the browser's answer to exactly this - it
  fires in every tab except the one that wrote, which is the half that was missing,
  because the writer already announced it itself. It is translated into the same event
  a local change fires, so nothing downstream has to know there are two ways a
  preference can move. A page that chose its own stock still ignores the default: that
  was never the reader's question to answer.
- **A stock's own colours never reached its paper.** The ruling and the pulp are
  composite layers built out of the stock's variables, and both were declared on
  `:root`. A custom property is substituted on the element that declares it, so their
  inner `var(--lea-rule)` and `var(--lea-mottle)` resolved against the kraft defaults
  sitting there, and what inherited down to the page was already final. Every stock got
  kraft's rules and kraft's brown mottling however it had been defined: the light sheet
  wore a brown wash, and the dark sheet was ruled in a dark brown that cannot be seen
  against it, which read as the dark paper simply having no lines. The two layers are
  declared on the canvas host now, beside the `[data-paper]` blocks that set the
  colours, so a stock's own values are the ones substituted. Adding a stock works the
  way the comment above it always claimed.
- **The paper picker opened behind the page list.** The board bar carried the same
  `z-index` as the body under it, and `z-index` on a flex item makes a stacking
  context: the menu's own place in the order counted only inside the bar, and equal
  numbers are settled by which came later in the markup. The bar sits above the body
  now, which is what a bar with menus hanging off it has to be.

- **The canvas kept its old size when something beside it changed width.**
  Pixi sizes its drawing buffer from the window, which covered every way the canvas
  could change size until the page list became the first thing in this app to take a
  column out of the board while the window stood still. The buffer stayed the old
  width and a fenced page stayed where it had been, until some later window resize
  corrected both. The render loop now checks the host's own size, which is where the
  camera already learns that its viewport moved. A `ResizeObserver` is wired up as
  well and is not enough on its own: it is delivered on a frame the browser chooses
  to run, and a page whose only change is a sidebar appearing can go several frames
  without one.

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

### Fixed
- **Every check script runs again.** All four read a session off the registration
  response, which was right until activation shipped earlier in this milestone and has
  been `undefined` since: `POST /register` answers 202 and deliberately signs nobody in,
  because until the address answers every other endpoint refuses the account. So
  `e2e:board` died twenty seconds later at a board list with no board in it, pointing
  the finger at the browser rather than at four lines of setup, and `check:stack` ran
  its whole websocket phase unauthenticated.

  They now log in for the token. The three that start their own API also start it with
  blank SMTP, the documented off switch, so their throwaway accounts are opened rather
  than left waiting on a link nobody is going to click; that has to be explicit because
  the repo's own `.env` usually configures a relay.

  `check:stack` is the exception and stays honest about it. It drives a real deployment
  through nginx, where the relay is real, so it takes `STACK_CHECK_EMAIL` and
  `STACK_CHECK_PASSWORD` for an account that is already activated and says so plainly
  when a fresh registration cannot log in. It deliberately has no path into the
  database to activate a row itself: reaching around the stack would make the check
  pass against a deployment whose activation is broken.
- **A scribble is a scribble again, not a solid block.** Ink that crossed itself was
  filling in: a loop came out as a filled disc, a crossing-out covered the thing it was
  meant to cross out, and a fast scribble landed as a grey slab with straight edges
  across the drawing. The mark was being handed to the triangulator as one closed
  outline, and the outline of a stroke that crosses itself crosses itself too, which is
  a shape a triangulator is entitled to make nonsense of. It now goes over as convex
  pieces that meet edge to edge, which is a shape it cannot get wrong. Where a stroke
  really does cross itself the ink overlaps, which for the highlighter means it darkens,
  the way it does on paper.

### Known limitations
- **A stroke is only visible to other people once it is finished.** Ink is committed on
  pointer up rather than streamed, so a peer watching sees the cursor move and then the
  whole stroke appear. Deliberate, and the reasoning is in `docs/core/ARCHITECTURE.md`
  section 5.
- **A drawn stroke cannot be restyled afterwards.** The nib is chosen before the stroke
  and recorded on it. Changing a finished stroke's colour or width means drawing it
  again, and there is no eraser: removing ink is selecting it and pressing Delete.
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
