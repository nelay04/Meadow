# Meadow MCP image: the `meadow-mcp` bundle serving Streamable HTTP, behind nginx at /mcp.
#
# Build context is the repo root, for the same reason as the web image: the server
# compiles in `packages/schema` and `packages/document-core`, so it needs the workspace
# to build. The bundled file and its snapshot assets are all that ship.
#
# It no longer needs any of `apps/web` but the fonts. Until 1.26.0 the write path lived
# in `apps/web/src/doc` and this image copied that directory and `src/lib/api.ts` in to
# get it; both moved to `packages/document-core`.
#
# Debian for the build stage for the web image's reason (the lockfile was resolved on
# glibc). The runtime is the same base so nothing native differs between the two.
FROM node:22-bookworm-slim AS build

RUN corepack enable

WORKDIR /build

# Every workspace member in the filter's closure needs its manifest here, or
# --frozen-lockfile fails on a lockfile naming a package that is not present.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY packages/document-core/package.json packages/document-core/
COPY packages/mcp/package.json packages/mcp/
RUN pnpm install --frozen-lockfile --filter @meadow/mcp...

COPY packages packages
# The fonts a snapshot is drawn with, decompressed to TrueType by the build.
COPY apps/web/public/fonts apps/web/public/fonts

# Typecheck, then bundle: a type error fails the image rather than a tool call later. The
# build also writes dist/assets, the snapshot renderer's WebAssembly and fonts.
RUN pnpm --filter @meadow/mcp lint && pnpm --filter @meadow/mcp build


FROM node:22-bookworm-slim AS runtime

WORKDIR /app
COPY --from=build /build/packages/mcp/dist/meadow-mcp.js /app/meadow-mcp.js
COPY --from=build /build/packages/mcp/dist/assets /app/assets

USER node
ENV NODE_ENV=production
EXPOSE 8765

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8765/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# Bound to every interface inside the container; the port is not published, so nginx on
# the compose network is the only thing that can reach it.
CMD ["node", "/app/meadow-mcp.js", "--http", "--host", "0.0.0.0", "--port", "8765"]
