# Meadow API image. One image, three entrypoints: the web process, the arq worker, and
# the one-shot migrator. They share a codebase and a dependency set, so building them
# separately would mean three builds and three chances for the worker to run against a
# schema the API was not built for.
#
# Build context is `services/api`.
#
# NOTE: the `dev` stage is last in this file, and `docker build` with no
# --target builds the last stage. Every production build must pass
# `target: runtime` or it ships the reload supervisor.

# Plain Dockerfile syntax on purpose: no `RUN --mount=type=cache`, no heredocs. Those
# need BuildKit, and this has to build on whatever docker the VPS happens to have as
# well as in CI. Layer ordering does the caching instead.

FROM python:3.13-slim-bookworm AS build

# Pinned to the version that resolved uv.lock. The lock carries a revision number and
# an older uv refuses to read a newer one, which surfaces as a build failure that
# reads like a dependency problem.
RUN pip install --no-cache-dir uv==0.12.1

# The venv records this path in its console scripts, so build and runtime must agree
# on it.
WORKDIR /srv/meadow/api

ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/srv/meadow/api/.venv

# Dependencies first, and without the project, so editing app code does not reinstall
# asyncpg and pycrdt on every build.
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./
RUN uv sync --frozen --no-dev


FROM python:3.13-slim-bookworm AS runtime

# Unbuffered, or nothing the process logs reaches `docker logs` until it exits.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PATH=/srv/meadow/api/.venv/bin:$PATH

RUN useradd --create-home --uid 10001 meadow

WORKDIR /srv/meadow/api
COPY --from=build --chown=meadow:meadow /srv/meadow/api /srv/meadow/api

USER meadow
EXPOSE 8000

# No curl in a slim image, and installing one to run a healthcheck is a package with a
# CVE feed attached for the sake of a single GET.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
    CMD ["python", "-c", "import urllib.request as r; r.urlopen('http://127.0.0.1:8000/healthz', timeout=4).read()"]

# `--proxy-headers` without a trust list is not a flag, it is a vulnerability.
# X-Forwarded-For is client-supplied, and uvicorn's `*` mode takes the leftmost entry,
# so anyone could pick their own rate-limit bucket and their own audit-log IP by
# sending the header themselves. The list of who may set it comes from
# FORWARDED_ALLOW_IPS, which uvicorn reads natively; the compose file pins it to the
# proxy's address on a fixed subnet. The default here is uvicorn's own, which trusts
# nothing but loopback, so an image run with no configuration cannot be spoofed.
ENV FORWARDED_ALLOW_IPS=127.0.0.1

# Single worker on purpose. Rooms are in-process state: two uvicorn workers would each
# hold their own YRoom for the same board, and the two halves of the room would only
# ever see each other's edits through the Postgres update log. Scaling out means a
# Redis-backed room registry, which is not v1.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", \
     "--proxy-headers"]


# --- development ---------------------------------------------------------------
#
# `docker compose -f docker-compose.local.yml --profile app up`. Source is bind-mounted
# over /srv/meadow/api/app and uvicorn watches it, so an edit on the host restarts the
# process in about a second.
#
# A separate stage rather than a flag on the runtime one: --reload pulls in a file
# watcher, runs as a supervisor with a child process, and re-executes arbitrary code
# from a writable mount. None of that belongs in the image that faces the internet.
FROM build AS dev

# The dev group brings pytest, ruff and mypy, so the same container can run the checks
# instead of needing a second Python toolchain on the host.
RUN uv sync --frozen

ENV PYTHONUNBUFFERED=1 \
    PATH=/srv/meadow/api/.venv/bin:$PATH

EXPOSE 8000

# Runs as root, unlike the runtime stage. The bind-mounted source is owned by the host
# user, and matching that uid inside the image would mean rebuilding it per developer.
# It is a local container on a local network; the tradeoff is the other way round here.
#
# --reload-dir is explicit. Left to itself uvicorn watches the whole working directory,
# which includes .venv, and every reload rescans thousands of files.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", \
     "--reload", "--reload-dir", "/srv/meadow/api/app"]
