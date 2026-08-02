import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig, loadEnv } from 'vite'

// Ports live in the repo-root .env alongside the compose and API settings, so there
// is one place to change them.
const repoRoot = fileURLToPath(new URL('../../', import.meta.url))

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '')
  const apiPort = env.API_PORT ?? '8012'
  const webPort = env.WEB_PORT ?? '3012'

  return {
    plugins: [react()],
    envDir: repoRoot,
    server: {
      port: Number(webPort),
      strictPort: true,
      proxy: {
        // Same-origin in dev, so the httpOnly refresh cookie is sent without CORS
        // credentials handling or a SameSite=None relaxation.
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
        '/ws': { target: `ws://localhost:${apiPort}`, ws: true },
      },
    },
  }
})
