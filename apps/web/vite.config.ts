import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

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

  return {
    plugins: [react()],
    envDir: repoRoot,
    server: {
      port: Number(webPort),
      strictPort: true,
      // Bind to every interface when asked. A dev server listening on 127.0.0.1 inside
      // a container is unreachable from the host, and the failure looks like a port
      // mapping problem rather than a bind address one.
      host: env.MEADOW_WEB_HOST ?? 'localhost',
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
