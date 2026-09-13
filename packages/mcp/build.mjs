// One file, dependencies bundled, so `npx`/`node dist/meadow-mcp.js` works without the
// monorepo. The web app's doc modules and the schema package are TypeScript source and
// are compiled in here; nothing outside this package is published.
import { build } from 'esbuild'

await build({
  entryPoints: ['src/cli.ts'],
  outfile: 'dist/meadow-mcp.js',
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // ws has optional native addons it loads in a try/catch; left external they simply are
  // not found, which is the pure-JS path ws is built to fall back to.
  external: ['bufferutil', 'utf-8-validate'],
  banner: {
    // esbuild's ESM output has no `require`; y-websocket's CommonJS dependencies need one.
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  legalComments: 'none',
  logLevel: 'info',
})
