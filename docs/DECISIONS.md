# Decisions worth knowing

The expensive-to-reverse ones, settled before the code that depends on them was written.
`docs/core/ARCHITECTURE.md` is the full design record; this is the short account of why
the shape of the thing is the shape it is.

---

## CRDTs, not operational transformation

Operational transformation is the older and, on paper, the more efficient answer: compact
operations, no per-character metadata. It also requires a central server that serialises
every operation and transforms each one against everything it missed, and the transform
functions have to be correct for every pair of operation types. That is a well-known
source of subtle, data-losing bugs, and adding an operation type means revisiting every
pair.

Three things about this project push the trade the other way. It has to work offline, and
a client disconnected for an hour has to be transformed back in against an hour of history
while a CRDT just merges. It has two very different data shapes, a flat map of object
properties and rich text inside those objects, and one library covers both with the same
merge rules rather than two transformation matrices. And it is a solo project, where "the
library is responsible for convergence" is worth paying real bytes for.

The cost is real and shows up twice. Deleted content leaves tombstones, which is why
snapshot compaction exists at all. And concurrent edits converge to *a* consistent answer
rather than the one a human would have picked: last-writer-wins on a contended field, and
an undo that can resurrect an object a peer deleted. Both are pinned by tests rather than
hoped about, in `services/api/tests/test_concurrency.py` and
`apps/web/src/doc/convergence.test.ts`.

## A flat `objects` map with `parentId` pointers, not a nested tree

Nested trees make reparenting - dragging a shape into a frame - a delete-and-recreate,
which loses concurrent edits to the thing being moved. A flat map makes it a single field
write.

## Rich text is a fragment, not a string

Two people typing in one text object merge character by character. A plain string field
would last-write-wins and drop keystrokes.

## The websocket handshake is the security boundary

Validate the token, resolve the board role, reject before joining the room. REST
permission checks are decorative if this is wrong, which is why its rejection paths were
the first tests written.

Effective role is resolved live from the database on every request and every connect, by
exactly one function, `app/services/permissions.py::resolve_role`. If a second place
starts computing a role, that is a bug.

## Tokens carry identity, never authorisation

The access token does not contain workspace ids and the ws-token does not contain a role,
both departures from the original spec. Memberships in a bearer token are authorisation
data that is stale by design: somebody removed from a workspace would keep access until
their token expired. The ws-token does carry its parent access token's expiry, so a
connection can never outlive the session that authorised it.

## The board lock is not a permission, deliberately

A client can lock a glade so it stops accepting edits. That is a guard against your own
hands while presenting, not a grant, so it lives entirely in `apps/web/src/doc/mutations.ts`
where it folds into the one `canWrite` boolean every mutation already passes through. It is
per-tab, never written to the document, never sent to the server, and unlocking grants
nothing: the role half of the check is untouched, and the server remains the only authority
on what a client may do.

## One draw call for every primitive, via a signed distance field

A container plus a graphics object per shape is the structure everyone reaches for, and it
issues a draw call per object: about 2,670 of them at five thousand shapes. The instanced
SDF batch issues one.

The SDF also solves a problem the alternatives cannot. A texture atlas or scaled geometry
distorts stroke width and corner radius as a shape grows, while a distance function
evaluated in world units keeps both exact at any size and any zoom. Adding a shape type
means adding a branch to the distance function, not adding a graphics object.

## Two layers, one camera

Rich text cannot be edited inside WebGL, so text objects live in a DOM overlay driven by
the same camera as the canvas. The two must not drift apart by so much as a pixel at any
zoom, and that is measured by sampling pixels out of screenshots rather than by comparing
the two transforms in code - because the failure mode being tested *is* the browser and
the GPU rounding the same arithmetic differently. A test that computes both sides itself
agrees with itself and proves nothing.

## Document state never lives in React

The engine keeps a cache built from document observers, and a tool's write goes to the
document first, with the observer feeding the cache afterwards. A local drag takes exactly
the same path as a remote peer's edit, so there is no second code path to keep correct.
React re-renders the chrome, never the canvas.

## Ink is width from speed, not from pressure

A stylus reports what it is being leant on. A mouse reports a constant, and browsers do not
agree on which constant. A constant run through a pressure curve is a line of uniform
width, which is the flattest a stroke can look, so when the pointer is not a pen the width
comes from speed instead: fast is thin, slow is thick, which is what a real nib does
because a hand moving fast has less time to press.

The five nibs are not five branches. Every one is the region swept by a shape dragged along
the path, and two shapes cover all five: a disc offset along the path's normal, and a blade
held at a fixed angle. Calligraphy falls out of the construction rather than being faked
with a direction test.

## Compaction never derives its read set from a watermark

Postgres sequences are non-transactional, so a row holding `id=98` can commit after one
holding `id=99`. A compaction that folds everything `<= max(id)` and records that as a
high-water mark strands the late row permanently, and a room load filtering on it never
sees the row again. Instead compaction deletes exactly the rows it folded, and room load
reads every surviving row with no id filter. Updates are commutative and idempotent, so a
duplicate re-apply is harmless while a lost update is not.

Compaction takes a Postgres advisory lock rather than a Redis one. `pg_advisory_xact_lock`
releases on commit or rollback, so a worker killed mid-run cannot strand a board behind a
TTL, and the lock lives in the same transaction as the work it guards.

## Single-use ws-tokens require driving reconnection by hand

The stock provider composes its URL once and retries on its own schedule, so its built-in
reconnect would replay a spent token forever. `apps/web/src/sync/provider.ts` disables
autoconnect and mints a fresh token per attempt with capped backoff.

---

# Measured, and not

Numbers taken under software rasterisation are not the numbers the target is about, so they
are reported separately rather than rounded into the good column.

| | |
|---|---|
| Draw calls at 5,000 objects | **1**, measured |
| CPU frame cost at 5,000 objects | **3.5 ms median**, `pnpm bench:canvas` |
| Overlay drift, zoom 0.33 to 2.5, dpr 1 and 2 | **within 1 CSS pixel**, `pnpm smoke:overlay` |
| Arrow pass, per arrow | **10.9 µs**, `pnpm bench:arrows`. 2.2 ms at 200 arrows |
| 60fps at 5,000 objects | **not verified.** Every run so far rasterised in software, where the render call returns before rasterisation finishes, so it measures CPU work only. Needs real hardware |
| 20,000 objects | **never measured.** The dev machine OOM-kills the run at that size |
| Concurrent editors per board | **50 accepted, the 51st refused with 4429**, measured. That is `max_clients_per_room` doing its job, not a capacity limit - with the cap raised, one room sustained **400 writing editors losslessly**. See below |
| Cursor propagation | **p50 1.9 ms / p95 2.5 ms** in a 5-peer room, **p50 6.3 ms / p95 8.1 ms** at 50 peers, 100% delivery at every size, `--suite cursors` |
| Compaction throughput | **3,300-15,700 updates/s** folded, log rows N -> 0, idempotent. Bytes only **1.15x-1.32x** though - see "what compaction is actually for" below |
| Update ingest, one room | **~590 updates/s** absorbed losslessly with 10 writers going flat out, `--suite editors` |
| Login | **9.3/s, p50 1.6 s** at 16 concurrent. That is argon2id, and it is the intended cost of the hash rather than a bottleneck to remove |
| REST reads | **peak 235-247 req/s**, zero errors, with the knee somewhere between 64 and 128 concurrent depending on what else the box is doing. Past it the curve *collapses* rather than plateaus: **~105 req/s at 256**, p95 ~6.9 s, and the first errors of the whole suite. One worker, and past the knee more load costs throughput as well as latency |

Taken by `services/api/loadtest` on a 4-core WSL2 machine where the load generator and
the server share the cores, so the latencies are pessimistic and the throughputs are
floors. `services/api/loadtest/README.md` says how to reproduce them.

## Where it actually stops

`max_clients_per_room = 50` is a *setting*, and measuring it only tells you what the
setting says. Run against a target with that cap raised, the ceilings are:

| | |
|---|---|
| Concurrent websockets, one process | **15,000**, zero failures, ~95 KB of server RSS each. The sweep stopped because it hit its own configured limit, not because the server did |
| Writing editors in **one** room, losslessly | **400.** 6,000 writes, **zero lost**, converged - but it takes 132 s of drain after 15 s of typing to get there |
| Writing editors that stay **current** | **~100-130.** At 100 the room drains in 0.3 s; at 200 it is 20 s behind and at 400 it is 132 s behind. Correct and current are different ceilings, and the second is the one a user feels |
| Fan-out throughput, one room | **~15,000-17,000 frames/s achieved** across runs. Note the trap: 400 editors *offer* 158,000 frames/s, and the room delivers a tenth of that. The offered figure is demand, not throughput |
| REST concurrency knee | **64.** Beyond it throughput falls rather than plateaus - the queue in front of one worker grows faster than it drains |

An idle socket, by contrast, costs the event loop nothing measurable: with 400 held
open, REST p95 moved by 4% and throughput by 2%. It is the fan-out that fills the loop,
not the connection count - which is why the room ceiling and the socket ceiling are
two thousand apart.

The gap between the lossless ceiling and the real-time one is the useful part. Fan-out
is O(peers) per edit, so one edit in a 400-person room is 399 frames; the server accepts
all of it and loses none of it, but it finishes long after the editing stopped.

### The scaling law, and why a bigger box helps less than you would think

Fan-out demand in a room of `E` editors each writing `r` times a second is

    frames/s = E x (E - 1) x r

which the measurements match to within 0.05% (E=400, r=1: model 158,204/s, measured
158,187/s). It is **quadratic in room size** - doubling the people quadruples the work.

A room stays current while that demand is under the achieved ceiling `F`, so the
sustainable room size is `E ~ sqrt(F / r)`. With the measured F = 15,300 frames/s:

| edit rate per user | real-time room size |
|---|---|
| 0.5 /s | ~175 |
| 1 /s | ~124 |
| 2 /s | ~88 |

Measured against that: 100 editors kept up (0.27 s drain), 200 did not (23.9 s). The
boundary sits between them, which is where `E ~ 124` puts it.

And because it is a square root, **hardware buys room size very slowly**. If a
dedicated, faster core delivered `k` times the fan-out:

| k | fan-out | real-time room at 1 edit/s |
|---|---|---|
| 1x (measured here) | 15,300/s | 124 |
| 2x | 30,600/s | 175 |
| 4x | 61,200/s | 248 |
| 8x | 122,400/s | 350 |

An eight-fold faster machine buys under three times the room. These are projections
from the measured law, not measurements - the only measured column is the first.

The other half of the answer is that **more cores do not help a single room at all.**
Rooms are in-process state, so the API runs one uvicorn worker and one event loop, and
a room's fan-out is bound to one core no matter how many the box has (see "known sharp
edges"). Extra cores raise total *sockets* and total *boards*; they do not raise the
ceiling for one board. Getting past that is a redesign - rooms behind a shared bus -
not a bigger instance.

### What a larger machine would give

Extrapolated from the measured per-unit costs, and to be treated as arithmetic rather
than as results:

| | measured here | the constraint |
|---|---|---|
| Server memory per idle socket | **~89 KB** (80 MB -> 1,423 MB over 15,000 sockets) | roughly linear, so ~12 GB of headroom implies O(100k) sockets before memory bites |
| Concurrent sockets | **15,000** on a 4.9 GB box, zero failures | the sweep hit its own limit; memory, file descriptors and ephemeral ports are the next walls, not the server |
| Fan-out per room | **~15,300 frames/s** on a contended core | one event loop, one core. Scales with single-core speed, not core count |
| REST reads | **235-247 req/s, knee at 64-128** | one worker. This one *would* scale with workers, if rooms did not forbid them |

## What compaction is actually for

The fold reclaims **rows, not bytes**: N update rows become one snapshot, but the
snapshot is only 1.15x-1.32x smaller than the log it replaced. Yjs keeps a tombstone
for every superseded item, so even a board whose writes churn 50 objects 40 times over
does not collapse to the size of 50 objects.

That is not compaction failing. Room load reads every row for a board, so turning 5,000
rows into 1 is the win - the read amplification, and the row count that would otherwise
grow without bound. It is worth writing down because "compaction saves disk" is the
obvious reading of it, and the measurement says otherwise.

---

# Known sharp edges

- **Local undo can resurrect an object a remote user deleted.** Inherent to the undo
  manager, and the same thing happens in every tool built this way. Accepted and
  documented rather than worked around.
- **A stroke is only visible to other people once it is finished.** Ink is committed on
  pointer-up, so a long stroke appears at its author's hand and at everyone else's a moment
  later.
- **A drawn stroke cannot be restyled afterwards.** The nib is chosen before the stroke,
  not after it.
- **The API runs one uvicorn worker, and that is a ceiling rather than a default.** Rooms
  are in-process state, so two workers would each hold their own room for the same board
  and the halves would see each other only through the update log. Going past one process
  needs a shared room registry, which is v2 scope.
- **Backups are on the same disk as the database.** Nightly, verified with a restore
  listing, seven days retained, no offsite copy. That covers a bad migration and does not
  cover losing the VPS.
- **Two tabs of one browser sync through a broadcast channel as well as the server**, so a
  tab pair cannot verify server behaviour. Use two browsers.
- The realtime library dropped its server-level store argument in 0.16, so persistence is
  attached per room: `MeadowWebsocketServer.get_room` attaches the store and loads state
  before the room starts.
- **Stopping a room cancels in-flight store writes.** It cancels the task group the write
  was spawned on without waiting, and with auto-cleaning rooms the last client leaving
  stops the room - so an update that arrived moments earlier races its own persistence and
  loses: type, close the tab, edit gone. `PostgresYStore.write` shields its transaction
  from cancellation.
- **Room deletion is not idempotent upstream**, and the serve loop calls it whenever the
  client it was serving was the last one out. Two clients disconnecting together both
  observe an empty client set, and the second raises out of the teardown path of an
  ordinary disconnect. `MeadowWebsocketServer` overrides it.
- The renderer supplies its global and mesh-local uniforms individually rather than as
  interface blocks, and looks up a location for every uniform it declares, so a custom
  shader must declare them plainly and reference all of them - the compiler strips unused
  ones and the lookup then reads off `undefined`.
- Container bounds are derived from geometry, and an instanced batch is one unit quad no
  matter how many objects it draws, so `ShapeBatch` sets its bounds explicitly. Without
  that it reports itself as 1x1 and anything reading bounds, extraction included, silently
  sees almost nothing.
