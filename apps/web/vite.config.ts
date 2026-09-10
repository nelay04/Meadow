import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import type { Connect, Plugin } from 'vite'
import { defineConfig, loadEnv } from 'vite'

/**
 * Serve the SPA at /app on the dev and preview servers, the way nginx does in production.
 *
 * Without this, /app is not a file the server knows, so Vite's html fallback answers it
 * with the root `index.html` - which since the split is the *landing page*. It looks like
 * it worked, because a page renders; what actually happens is that the landing page's own
 * "Open Meadow" buttons point at /app and land back on the landing page, so they read as
 * dead buttons rather than as a routing fault.
 *
 * `/app/` happened to work already: it resolves to a real directory containing an
 * index.html. That is what made this look like a UI bug - one of the two spellings was
 * fine - and it is why the fix maps both.
 *
 * Deliberately no wildcard under /app: nginx matches `= /app` and `= /app/` exactly, and
 * the app is hash-routed, so there is no route below /app to catch.
 *
 * One difference from production remains, and it is Vite's own and not this plugin's:
 * /app/anything still gets the html fallback here - the landing page - where nginx would
 * answer 404. Worth knowing when a stale link is being chased, because in dev it renders
 * a page instead of failing. Not worth a second middleware to paper over, since nothing
 * in the app produces such a URL.
 */
function appEntry(): Plugin {
  const rewrite: Connect.NextHandleFunction = (request, _response, next) => {
    const url = request.url ?? '/'
    // Split rather than parsed: the query has to survive, because a share link arrives
    // as /app?k=<token> and dropping it turns a visitor with a link into one without.
    const [path, query] = url.split(/(?=\?)/, 2)
    if (path === '/app' || path === '/app/') {
      request.url = `/app/index.html${query ?? ''}`
    }
    next()
  }

  return {
    name: 'meadow-app-entry',
    // Installed directly rather than from a returned function. A returned one runs
    // *after* Vite's internal middlewares, and the internal middleware in question is
    // the html fallback already answering these - so the post hook would rewrite a
    // request that had been served three middlewares ago.
    configureServer: (server) => {
      server.middlewares.use(rewrite)
    },
    configurePreviewServer: (server) => {
      server.middlewares.use(rewrite)
    },
  }
}

// Ports live in the repo-root .env alongside the compose and API settings, so there
// is one place to change them.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig(({ mode }) => {
  // Prefix '' means real environment variables are merged in as well as .env, which is
  // how the container overrides the host defaults below without a second config file.
  const env = loadEnv(mode, repoRoot, '')
  const apiPort = env.API_PORT ?? '8012'
  const webPort = env.WEB_PORT ?? '3012'

  // On the host the API is a uvicorn on localhost. Inside docker-compose.local.yml's
  // `app` profile it is a container reachable by service name, and localhost there is
  // the web container itself.
  const apiOrigin = env.MEADOW_API_ORIGIN ?? `http://localhost:${apiPort}`
  const wsOrigin = apiOrigin.replace(/^http/, 'ws')

  // Hostnames a tunnel (ngrok, cloudflared) presents the dev server under. Vite rejects
  // any Host header it does not know, so a tunnel is a blank page until it is listed.
  const allowedHosts = (env.MEADOW_WEB_ALLOWED_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean)

  return {
    plugins: [react(), appEntry()],
    envDir: repoRoot,
    build: {
      rollupOptions: {
        /*
         * Two documents, not one.
         *
         * `index.html` is a hand-written static landing page and the only thing at this
         * origin a search engine can read: the app renders into an empty div behind a
         * sign-in form, so a crawler that got the SPA got nothing. `app/index.html` is
         * that SPA, moved down a path and marked noindex, and vite emits it to
         * dist/app/index.html so nginx can serve it at /app.
         *
         * Old links to /#/glade/<uuid> still land on the landing page, which forwards
         * the fragment to /app - see the script at the top of index.html.
         */
        input: {
          landing: fileURLToPath(new URL('./index.html', import.meta.url)),
          app: fileURLToPath(new URL('./app/index.html', import.meta.url)),
        },
      },
    },
    server: {
      port: Number(webPort),
      strictPort: true,
      // Bind to every interface when asked. A dev server listening on 127.0.0.1 inside
      // a container is unreachable from the host, and the failure looks like a port
      // mapping problem rather than a bind address one.
      host: env.MEADOW_WEB_HOST ?? 'localhost',
      ...(allowedHosts.length > 0 ? { allowedHosts } : {}),
      // Bind mounts on some filesystems, WSL and docker-on-mac included, do not deliver
      // inotify events to the container. Polling is slower and always works; it stays
      // off unless asked for, because on a native filesystem it is pure wasted CPU.
      watch: env.MEADOW_WATCH_POLL === 'true' ? { usePolling: true, interval: 300 } : undefined,
      proxy: {
        // Same-origin in dev, so the httpOnly refresh cookie is sent without CORS
        // credentials handling or a SameSite=None relaxation.
        '/api': { target: apiOrigin, changeOrigin: true },
        '/ws': { target: wsOrigin, ws: true },
      },
    },
  }
})
