import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import type { Connect, Plugin } from 'vite'
import { defineConfig, loadEnv, transformWithEsbuild } from 'vite'

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
 * The static /faq/ and /source/ pages need the same for their slashless spelling. Vite
 * finds `faq/index.html` for /faq/ on its own, but /faq falls through to the html
 * fallback and renders the landing page under the wrong address.
 *
 * One difference from production remains, and it is Vite's own and not this plugin's:
 * /app/anything still gets the html fallback here - the landing page - where nginx would
 * answer 404. Worth knowing when a stale link is being chased, because in dev it renders
 * a page instead of failing. Not worth a second middleware to paper over, since nothing
 * in the app produces such a URL.
 */
const DOCUMENTS: Record<string, string> = {
  '/app': '/app/index.html',
  '/app/': '/app/index.html',
  '/features': '/features/index.html',
  '/features/': '/features/index.html',
  '/collaboration': '/collaboration/index.html',
  '/collaboration/': '/collaboration/index.html',
  '/faq': '/faq/index.html',
  '/faq/': '/faq/index.html',
  '/source': '/source/index.html',
  '/source/': '/source/index.html',
}

function appEntry(): Plugin {
  const rewrite: Connect.NextHandleFunction = (request, _response, next) => {
    const url = request.url ?? '/'
    // Split rather than parsed: the query has to survive, because a share link arrives
    // as /app?k=<token> and dropping it turns a visitor with a link into one without.
    const [path, query] = url.split(/(?=\?)/, 2)
    const target = DOCUMENTS[path]
    if (target !== undefined) {
      request.url = `${target}${query ?? ''}`
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

/**
 * The shared head, header, footer and icon sprite of the static pages: /, /faq/ and
 * /source/.
 *
 * Each page is a hand-written HTML file with a few markers in it, and this swaps each
 * marker for the file of the same name in site/. The output is still one static
 * document per page with its CSS inline and nothing to fetch, which is the property the
 * landing page was written for; the partials only stop three copies of the same chrome
 * from drifting apart.
 *
 * The word after `header` names the page, and the nav link carrying that `data-page`
 * gets `aria-current`. The files are read on every transform, so in dev an edit to a
 * partial shows on the next reload. The app's own index.html has no markers and passes
 * through untouched.
 */
function sitePartials(): Plugin {
  const dir = fileURLToPath(new URL('./site/', import.meta.url))
  const read = (name: string) => readFileSync(`${dir}${name}`, 'utf8')
  const marker = /<!--\s*site:(head|sprite|header|footer)(?:\s+([a-z]+))?\s*-->/g
  const symbol = /[ \t]*<symbol id="(i-[a-z-]+)"[\s\S]*?<\/symbol>\n?/g
  let building = false

  /**
   * Only the icons this page names.
   *
   * sprite.html holds every icon the site owns, and no page uses more than a third of
   * them. The unused ones are not free: they are bytes in the document and nodes in the
   * DOM of a page that never draws them.
   */
  const trimSprite = (sprite: string, used: Set<string>) =>
    sprite.replace(symbol, (whole, id: string) => (used.has(id) ? whole : ''))

  /**
   * What the browser needs, without what the author needs.
   *
   * These pages carry their CSS and their script inline, comments and all, and those
   * comments are most of both files. They are worth keeping in site/ and worth leaving
   * out of what every visitor downloads and parses, so they are stripped here rather
   * than there, and only for a build: `pnpm dev` still serves the readable copy.
   *
   * JSON-LD is left alone. It is a script element but it is not script, and esbuild's
   * JavaScript loader would make nonsense of it.
   */
  const squeeze = async (html: string) => {
    const styles = [...html.matchAll(/<style>([\s\S]*?)<\/style>/g)]
    for (const [whole, css] of styles) {
      const { code } = await transformWithEsbuild(css, 'inline.css', { minify: true, charset: 'utf8' })
      html = html.replace(whole, `<style>${code.trim()}</style>`)
    }
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
    for (const [whole, js] of scripts) {
      const { code } = await transformWithEsbuild(js, 'inline.js', { minify: true, charset: 'utf8' })
      html = html.replace(whole, `<script>${code.trim()}</script>`)
    }
    return html.replace(/\n?[ \t]*<!--[\s\S]*?-->/g, '')
  }

  return {
    name: 'meadow-site-partials',
    configResolved: (config) => {
      building = config.command === 'build'
    },
    transformIndexHtml: {
      order: 'pre',
      handler: async (html) => {
        // The header and footer name icons of their own, and they are not in the page
        // yet when the sprite marker is reached.
        const named = `${html}${read('header.html')}${read('footer.html')}`
        const used = new Set([...named.matchAll(/href="#(i-[a-z-]+)"/g)].map((m) => m[1]))
        const out = html.replace(marker, (_match, part: string, page: string | undefined) => {
          if (part === 'head') {
            // A function, so a `$` in the CSS is never read as a replacement pattern.
            return read('head.html').replace('<!-- site:style -->', () => `<style>\n${read('site.css')}</style>`)
          }
          if (part === 'sprite') {
            return trimSprite(read('sprite.html'), used)
          }
          if (part === 'header' && page !== undefined) {
            return read('header.html').replace(
              new RegExp(`data-page="${page}"`, 'g'),
              `data-page="${page}" aria-current="page"`,
            )
          }
          return read(`${part}.html`)
        })
        return building ? await squeeze(out) : out
      },
    },
  }
}

/**
 * Emit /sw.js from pwa/sw.js, with the build's own bundle names to precache.
 *
 * Build only. The names are content hashes, so they are only known once rollup has
 * written the bundle, and that is the reason this is a plugin rather than a file in
 * public/. Everything under assets/ is taken: the landing page is static HTML with no
 * bundle of its own, so what is there is the app.
 *
 * The version is a hash of the list and the template, so a deploy that changes no
 * bundle leaves the worker byte-identical and the browser does not reinstall it.
 */
function serviceWorker(): Plugin {
  const template = fileURLToPath(new URL('./pwa/sw.js', import.meta.url))

  return {
    name: 'meadow-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const source = readFileSync(template, 'utf8')
      const precache = [
        ...Object.keys(bundle)
          .filter((name) => name.startsWith('assets/'))
          .sort()
          .map((name) => `/${name}`),
        '/site.webmanifest',
        '/brand/icon-192.png',
        '/brand/icon-512.png',
        '/brand/icon-maskable-512.png',
      ]
      const version = createHash('sha256')
        .update(source)
        .update(precache.join('\n'))
        .digest('hex')
        .slice(0, 12)

      this.emitFile({
        type: 'asset',
        fileName: 'sw.js',
        source: source
          .replace('__MEADOW_SW_VERSION__', version)
          .replace('/* __MEADOW_SW_PRECACHE__ */ []', JSON.stringify(precache)),
      })
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
    plugins: [react(), appEntry(), sitePartials(), serviceWorker()],
    envDir: repoRoot,
    build: {
      rollupOptions: {
        /*
         * Six documents, not one.
         *
         * `index.html` and the four pages under it are hand-written static pages and the
         * only things at this origin a search engine can read: the app renders into an
         * empty div behind a sign-in form, so a crawler that got the SPA got nothing.
         * `app/index.html` is that SPA, moved down a path and marked noindex, and vite
         * emits it to dist/app/index.html so nginx can serve it at /app. The static five
         * share their chrome through sitePartials() above.
         *
         * Old links to /#/glade/<uuid> still land on the landing page, which forwards
         * the fragment to /app - see the script at the top of index.html.
         */
        input: {
          landing: fileURLToPath(new URL('./index.html', import.meta.url)),
          features: fileURLToPath(new URL('./features/index.html', import.meta.url)),
          collaboration: fileURLToPath(new URL('./collaboration/index.html', import.meta.url)),
          faq: fileURLToPath(new URL('./faq/index.html', import.meta.url)),
          source: fileURLToPath(new URL('./source/index.html', import.meta.url)),
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
