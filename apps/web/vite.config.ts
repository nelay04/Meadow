import { fileURLToPath } from 'node:url'

import { defineConfig, loadEnv } from 'vite'

// Ports live in the repo-root .env alongside the compose and API settings, so there
// is one place to change them.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '')
  const apiPort = env.API_PORT ?? '8012'
  const webPort = env.WEB_PORT ?? '3012'

  return {
    envDir: repoRoot,
    server: {
      port: Number(webPort),
      strictPort: true,
      proxy: {
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
        '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
      },
    },
  }
})
