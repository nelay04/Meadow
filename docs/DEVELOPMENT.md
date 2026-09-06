# Running Meadow locally

Everything the README leaves out: how to bring the stack up, where the ports are, and
which check proves what.

`docker-compose.yml` is production and `docker-compose.local.yml` is development, which
is the reverse of the usual arrangement. The file that runs unattended on a server is
the one that should not need a flag to select, so **the `-f` is not optional** here: a
bare `docker compose up -d` starts the production stack.

---

## Everything in Docker

Requires Docker. No host Python and no host Node.

```bash
cp .env.example .env                                # ports and credentials live here
docker compose -f docker-compose.local.yml up -d    # or: pnpm local
```

That is postgres, redis, pgAdmin, a one-shot `migrate`, the API, the arq worker and the
web app, with the working tree bind-mounted into them. Edits reload in place: uvicorn
restarts the API on a Python change, vite hot-reloads the browser on a TypeScript one,
and watchfiles restarts the worker. Nothing needs a rebuild until a dependency changes.

`migrate` is a one-shot. It runs `alembic upgrade head`, exits, and the API waits for it
to have succeeded. Seeing `meadow-migrate-1 ... Exited (0)` in `docker ps -a` is the
healthy state, not a failure.

| Service | URL |
|---|---|
| Web app | http://localhost:3012 |
| API | http://localhost:8012 |
| API docs | http://localhost:8012/docs |
| pgAdmin | http://localhost:5051 |
| Postgres | localhost:5435 (`meadow`, and `meadow_test` for the suite) |
| Redis | localhost:6382 (db 0 dev, db 1 tests) |

Two things are worth knowing, because getting either wrong produces a confusing failure.

- **`node_modules` is the image's, never the host's.** The bind mount covers `apps/web`,
  and two anonymous volumes sit on top of the `node_modules` directories to keep the
  container's copy. The host tree is installed for the host platform, and pnpm's
  symlinked layout does not survive being half-overlaid; the symptom reads like a vite
  bug rather than a mount problem.
- **File watching may need polling.** Bind mounts on WSL and on docker-for-mac often do
  not deliver inotify events into the container. If an edit does not trigger a reload,
  set `MEADOW_WATCH_POLL=true` in `.env`. It is off by default because on a native
  filesystem it is wasted CPU forever.

The checks run inside the containers too, if you would rather not install the toolchains:

```bash
docker compose -f docker-compose.local.yml exec api pytest -q
docker compose -f docker-compose.local.yml exec api ruff check .
docker compose -f docker-compose.local.yml exec web pnpm --filter web test
```

---

## Or on the host

For a debugger on the API, or the two-terminal flow. Start the data services by name so
nothing holds `API_PORT` and `WEB_PORT`, and install Node 22+, pnpm, Python 3.13 and uv.

```bash
docker compose -f docker-compose.local.yml up -d postgres redis pgadmin   # or: pnpm local:data

cd services/api
uv venv --python 3.13
uv pip install -e . --group dev
.venv/bin/alembic upgrade head            # Alembic owns the schema
cd ../..

pnpm install
```

Then two terminals:

```bash
cd services/api && .venv/bin/python -m uvicorn app.main:app --port 8012
pnpm --filter web dev
```

Run the Python tools through `services/api/.venv/bin/` rather than a bare `uv run`: the
venv is where the project is installed editable.

### Ports

Ports are read from `.env` by `docker-compose.local.yml`, by the API through
pydantic-settings, and by Vite alike, so there is one place to change them. Postgres sits
on 5435 and Redis on 6382 to avoid colliding with native instances already on the default
ports, and with other compose stacks, which reach for 6380 as the obvious second choice.
Both bind to 127.0.0.1 rather than every interface.

Those host ports exist for what runs outside the compose network: pytest, the gate, and
the e2e scripts. The api and worker containers reach both by service name and need no
host port at all; the production stack publishes neither.

Scripts that start servers of their own never collide with either arrangement: the M0
gate takes 8013, `board-e2e` 8014/3094, `presence-e2e` 8016/3097.

### Seeing it work

Register an account, create a glade, and open it. To see convergence, open the same glade
in two browsers. Two tabs of one browser also work, but they sync through a
`BroadcastChannel` as well as the server, so a tab pair cannot tell you whether the server
is doing its job. To see persistence, stop the API, restart it, and reload.

---

## Tests and checks

```bash
cd services/api
.venv/bin/python -m pytest                 # against real Postgres and Redis
.venv/bin/ruff check . && .venv/bin/mypy app/
.venv/bin/alembic check                    # fails if the models drifted from migrations

pnpm --filter web lint                     # tsc
pnpm --filter web test                     # vitest

./scripts/m0-gate.sh                       # end-to-end, restarts the server mid-run
pnpm smoke:canvas                          # engine against a local Y.Doc
pnpm smoke:overlay                         # overlay drift, measured on pixels
pnpm e2e:board                             # auth -> draw -> type -> reload
pnpm e2e:presence                          # two real browsers on one board
pnpm e2e:sessions                          # a session terminated from another device
pnpm e2e:bengali                           # phonetic input, end to end
pnpm check:stack                           # the production stack, through nginx

pnpm hooks:run                             # the pre-commit hook, on what is staged now
```

**The suites are split by what they can actually prove.** Unit tests and the vitest suite
run against a local `Y.Doc`. The pytest suite runs against a real Postgres and a real
Redis, because the things it has to get right - citext, native enums, advisory locks,
`SET NX` replay protection - are exactly what an in-memory substitute papers over. The
e2e scripts drive real browsers. And `check:stack` drives the deployed artefact, because
everything above it talks to a uvicorn on the host and would pass against a proxy config
that drops the websocket upgrade.

The test suite creates and migrates a `meadow_test` database and uses Redis db 1, so it
never touches dev data.

### The pre-commit hook

A hook runs the fast half of that list on every commit, chosen by what is staged: repo
rules always, `tsc` and vitest when `apps/web` or `packages/schema` is involved, ruff and
mypy when `services/api` is. It lives in `.githooks/`, which `pnpm install` points git at
through `core.hooksPath`, so it is versioned with the repo rather than copied into each
clone by hand. Nothing in it needs a container, a database or a browser: a check you
cannot run because Postgres is down is a check people learn to skip.

The repo rules are the project's non-negotiables that no linter knows about, read off the
added lines only. `src/canvas/` importing from `src/features/`, a `Y.transact` outside
`src/doc/`, a second `resolve_role`, an `any`, a staged `.env`. Style preferences print as
notes and never block, because a hook that blocks on a judgement call teaches people to
pass `--no-verify`, and after that the real checks stop running too.

---

## The screenshots

`scripts/readme-shots.mjs` regenerates every image in the README. It starts its own API
and vite on 8018/3098, registers two accounts, draws the diagrams with the real tools over
a real websocket, and writes to `docs/media/`. It needs postgres and redis up, and nothing
else.

```bash
docker compose -f docker-compose.local.yml up -d postgres redis
node scripts/readme-shots.mjs
node scripts/shrink-shots.mjs      # 2x capture down to a README column, before committing
```

The capture runs at twice the display scale so the text stays crisp, which leaves the
diary page - a paper texture across the whole frame - at about four megabytes. The second
script halves every image to 1920px wide, keeps the result only when it is actually
smaller, and re-encodes anything still over a megabyte as JPEG, since a file that large
after PNG is a photograph rather than flat UI. That takes the six from 3.7MB to 1.3MB.
