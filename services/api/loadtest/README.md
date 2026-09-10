# Load and performance harness

`docs/DECISIONS.md` has a table called **Measured, and not**, and three of its rows
said *not measured*:

> Concurrent editors, cursor latency, compaction throughput — **not measured.**
> Correctness is covered by the suites; the numbers are not.

This is the thing that measures them.

```bash
loadtest/target.sh start          # an API of its own, on :8099
PYTHONPATH=. .venv/bin/python -m loadtest.run --suite full
loadtest/target.sh stop
```

Results land in `loadtest/results/` as a JSON file (for diffing runs) and a Markdown
report (for reading). `--suite quick` is the same shape in about a fifth of the time,
and `--suite editors` (or `rest`, `cursors`, `compaction`, `resilience`) re-asks one
question while tuning.

## Why it is not in `tests/`

`pytest` should mean one thing. The suites in `tests/` assert correctness, run in
seconds, and either pass or fail. A load run takes twenty minutes, needs a server of
its own on a real socket, and produces numbers that need a human to interpret — a p95
of 3ms is not "passing", it is a fact about this machine on this day.

They also need different servers. `tests/` uses Starlette's `TestClient`, which runs
the app in-process on a portal thread: perfect for asserting a close code, useless for
measuring an event loop under fifty concurrent sockets, because there is no socket and
no event loop of the kind production has. Everything here goes over TCP to a real
uvicorn.

## Running it somewhere else

`--base-url` points the harness at any target, so a VPS run is:

```bash
loadtest/target.sh start                     # on the VPS
python -m loadtest.run --base-url http://127.0.0.1:8099 --suite full
```

**Point it at a load target, never at production.** A run opens thousands of real
accounts, boards and update rows, and it deliberately runs with rate limiting off - so
against a live deployment it is indistinguishable from an attack, and it would leave
its wreckage in the real database. `target.sh` exists so there is always a throwaway to
aim at.

Running it over the internet rather than over loopback measures something different and
also useful: every latency here then includes the real network path, and the difference
between the two runs is the part the network owns.

## Why the target is not the dev stack

`loadtest/target.sh` starts a *separate* API on port 8099 with its own database
(`meadow_load`), its own Redis db, and **rate limiting off**. All three matter:

- The dev API enforces the real ARCHITECTURE 7 limits — 5 logins a minute, 3
  registrations an hour, 30 ws-tokens a minute. A load generator trips every one of
  them within a second, so the run would be measuring the rate limiter. Those limits
  are correct, and `tests/test_auth.py` asserts them; they are off here because this
  harness measures what is *behind* them.
- A run creates thousands of accounts, boards and update rows. That belongs in a
  scratch database.
- Rooms are in-process state, so the API deliberately runs **one uvicorn worker**.
  Every throughput number here is therefore a per-process ceiling, not a per-machine
  one, and that is a property of the design rather than of the test.

## The one methodological trap, and how it is handled

A websocket `send()` returns when the frame is in the *local* buffer, not when the
server has applied it. An unpaced writer therefore runs thousands of updates ahead of
the room, and if the socket is closed at the end of the load phase that backlog is
discarded.

The first saturation run here reported **42,290 lost updates out of 53,210** and a
document that had not converged. That is not what a dropped update looks like — it is
what closing a socket over a full send buffer looks like. Adding a settle phase (stop
writing, hold every socket open, drain until the server's own document stops growing)
turned the same run into **44,810 writes, 0 lost, converged**, with a 17-second drain.

So the harness reports two rates and never one:

| | |
|---|---|
| `offered_writes_per_s` | what the client pushed into its sockets — under saturation this is the client's fill rate, and it means very little |
| `ingest_writes_per_s` | what the server actually absorbed, over the write phase *plus* the drain — this is the number worth quoting |

A load test that measured only throughput would have reported the broken run as the
*faster* one. That is the whole reason `run_editors` reads the board back from a fresh
client at the end and counts the objects: under load, correctness has to be part of
the measurement, or the measurement rewards losing data.

## What each scenario answers

| module | question |
|---|---|
| `scenarios/rest.py` | request throughput and p50/p95/p99 at 8 → 64 concurrent signed-in clients; login separately, because argon2id dominates it and averaging it in would hide both numbers |
| `scenarios/editors.py` | how many sockets a room holds and whether the 51st is really refused; sustained edit rate at a human pace; the ingest ceiling unpaced; and whether the document still converges under all of it |
| `scenarios/cursors.py` | cursor propagation p50/p95 — awareness only, which is the fan-out path with no update log underneath it |
| `scenarios/compaction.py` | fold rate, row reduction, byte compression, and idempotence, in both regimes (every write a new object, versus writes churning a small set) |
| `scenarios/resilience.py` | the reconnect storm that `_evict` causes by design, and whether forged, expired and wrong-board tokens are still refused while it is happening |
| `scenarios/capacity.py` | the escalating sweeps: concurrent sockets, editors in one room, REST concurrency - each run until it breaks, reporting where and why. Not part of `--suite full`; ask for `--suite capacity` |

`metrics.py` keeps raw samples rather than a running summary, because tail percentiles
cannot be recovered from a mean and a count. Percentiles are nearest-rank on sorted
samples — no interpolation, so there is no question of which of the nine definitions
was used.

## Reading the numbers honestly

The load generator and the server share one machine and compete for the same cores. So
latencies here are **pessimistic** and throughput is a **floor**. A number taken this
way is not the number a dedicated box would give, and the report says so at the top of
every run — the same discipline the architecture doc already applies to the renderer
benchmarks it refuses to quote from software rasterisation.

## What it found

### The machine these came from

A **4-core, 4.9 GB WSL2 box**, with the load generator and the server sharing those
four cores and that memory. During the capacity sweeps the box ran with ~1.5 GB free,
and two dev containers were stopped to get that.

That matters in three specific ways, so none of it is a general disclaimer:

- **Latencies are pessimistic.** The generator is competing with the server for CPU.
- **Throughputs are floors,** for the same reason.
- **The socket ceiling is not the server's.** 15,000 sockets was the sweep's own
  configured limit, reached with zero failures and ~1.4 GB of server RSS. Memory was
  going to bind first, and on this box that would have been somewhere past 30,000.

`results/latest.md` and `results/capacity/latest.md` are the full reports.

| | |
|---|---|
| Concurrent websockets, one process | **15,000**, zero failures, ~89 KB server RSS each - the sweep hit *its own* limit, not the server's |
| Writing editors in one room, losslessly | **400**, zero updates lost, converged - after 144 s of drain |
| Editors that stay *current* | **~100-124.** Drain goes 0.27 s (100) -> 24 s (200) -> 144 s (400). Correct at every size; badly behind at the top of it |
| Fan-out, one room | **~15,000-17,000 frames/s achieved.** 400 editors *offer* 158,000/s and get a tenth |
| Cursor propagation | p50 **1.9 ms** / p95 2.5 ms at 5 peers, p50 **6.3 ms** / p95 8.1 ms at 50, 100% delivery throughout |
| Compaction | **3,300-15,700 updates/s**, N rows -> 1 snapshot, idempotent, but only **1.15x-1.32x** on bytes |
| REST reads | peak **235-247 req/s**, knee at 64-128, then collapse to **~105/s at 256** with p95 ~6.9 s and the suite's only errors |
| Login | **9.3/s, p50 1.6 s** at 16 concurrent - argon2id, working as intended |
| Room cap, handshake refusal | 50 accepted / 51st refused 4429; every forged, empty, tampered and wrong-board token refused under load, with 4401 and 4403 used correctly |

Three of those are worth more than their numbers:

**The room cap is a setting, not a capacity.** Measuring 50 only proves the setting
works. The room holds 400 writing editors, and knowing both is the difference between
"we support 50" and "we chose 50".

**Idle connections are nearly free; fan-out is not.** 400 held sockets moved REST p95 by
4%. 400 *writing* peers put the room two minutes behind. The cost is O(peers) per edit,
which is why the socket ceiling and the room ceiling are two thousand apart.

**Offered load is not throughput, and it bites twice.** The first version of the
saturation run reported 42,290 "lost" updates that were really an unflushed send
buffer. The second version of the *room* run reported "158,000 fan-out frames/s", which
was the demand the writers created, not what the server delivered - the achieved figure
is ~15,300/s. The same mistake, one level up, and the harness now computes both and
labels them, because the flattering number is the one that comes out by default.

Demand in a room follows `E x (E - 1) x r` frames/s, which the data matches to 0.05%.
So the sustainable room size is `sqrt(F / r)` - **hardware buys room size as a square
root**, and an 8x faster core would buy about 2.8x the room. `docs/DECISIONS.md` has
the projection table and the reason more *cores* do not help one room at all.

**Compaction buys rows, not disk.** Yjs keeps a tombstone per superseded item, so a log
churning 50 objects forty times over does not fold down to the size of 50 objects. The
win is the row count and the read amplification at room load - which is still the win
worth having, but it is not the one the name suggests.
