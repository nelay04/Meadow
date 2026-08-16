# Meadow web image: the built SPA baked into nginx, which also terminates /api and /ws.
#
# The bundle is static and same-origin. `lib/api.ts` calls `/api/v1/...` and
# `sync/provider.ts` derives its socket URL from `location`, so there is no API base
# URL to bake in at build time and no per-environment rebuild.
#
# Build context is the repo root: the web app is a pnpm workspace member and depends on
# `packages/schema` through `workspace:*`.
#
# NOTE: the `dev` stage is last in this file, and `docker build` with no
# --target builds the last stage. Every production build must pass
# `target: runtime` or it ships the vite dev server.

# Plain Dockerfile syntax, no BuildKit cache mounts, for the same reason as the API
# image: this has to build on whatever docker the VPS has.

# Debian rather than alpine. pnpm resolves the platform-specific optional deps at
# install time and the lockfile was resolved on glibc, so a musl image either picks a
# different esbuild binary than the lock pinned or fails --frozen-lockfile outright.
# The build stage is discarded anyway; only the nginx layer ships.
FROM node:22-bookworm-slim AS deps

RUN corepack enable

WORKDIR /build

# Manifests and the lockfile only. Anything below this that changes app source but not
# dependencies reuses the install layer, and the dev stage shares it.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/
COPY packages/schema/package.json packages/schema/
RUN pnpm install --frozen-lockfile


FROM deps AS build

COPY packages packages
COPY apps/web apps/web

# `build` is `tsc --noEmit && vite build`, so a type error fails the image rather than
# shipping a bundle that only fails in CI later.
RUN pnpm --filter web build


FROM nginx:1.27-alpine AS runtime

COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
# The image entrypoint runs envsubst over templates/ into conf.d/ at container start.
COPY docker/nginx/meadow.conf.template /etc/nginx/templates/meadow.conf.template
COPY --from=build /build/apps/web/dist /usr/share/nginx/html

# Only MEADOW_-prefixed variables are substituted. Without the filter, envsubst would
# also replace nginx's own $host, $remote_addr and $uri with empty strings, and the
# resulting config fails in ways that look like an nginx bug.
ENV NGINX_ENVSUBST_FILTER=MEADOW_ \
    MEADOW_API_UPSTREAM=api:8000 \
    MEADOW_TRUSTED_PROXY_CIDR=127.0.0.1

EXPOSE 80

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
    CMD ["wget", "--quiet", "--tries=1", "--spider", "http://127.0.0.1/nginx-healthz"]


# --- development ---------------------------------------------------------------
#
# `docker compose -f docker-compose.local.yml --profile app up`. The vite dev server
# with source bind-mounted from the host, so an edit hot-reloads in the browser.
#
# It inherits `deps`, not `build`: dependencies are installed into the image, and only
# source is mounted over the top. Bind-mounting the whole repo instead would shadow
# /build/node_modules with the host's, which is the usual way this setup breaks - the
# host tree is installed for the host platform and pnpm's symlinked layout does not
# survive being half-replaced.
FROM deps AS dev

# Source, config, and the workspace package the app imports. Everything else the image
# already has. These are the paths docker-compose.local.yml mounts over.
COPY packages packages
COPY apps/web apps/web

EXPOSE 3012

# --host comes from MEADOW_WEB_HOST in the compose file rather than the command line,
# so vite.config.ts stays the single place that decides how the server binds.
CMD ["pnpm", "--filter", "web", "dev"]
