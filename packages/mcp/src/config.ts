/**
 * Where the server finds Meadow, and what it signs in with.
 *
 * Flags win over the environment, so a client config can pin one value without the
 * rest of the machine's settings leaking in, and the environment exists at all because
 * most MCP clients pass secrets that way and keep them out of the process list.
 */

export type Transport = 'stdio' | 'http'

export type Config = {
  /** The web origin, e.g. https://meadow.example.com. The API is under /api/v1. */
  api: string
  /** A personal access token. Required for stdio; per request for http. */
  token: string | null
  transport: Transport
  /** For http: where to listen. */
  host: string
  port: number
  /** How long an idle board connection is kept open, in milliseconds. */
  idleMs: number
}

export class ConfigError extends Error {}

const USAGE = `meadow-mcp: the Meadow MCP server

  --api <url>        Meadow's address (env MEADOW_API_URL), e.g. https://meadow.example.com
  --token <token>    a personal access token, mdw_... (env MEADOW_TOKEN)
  --http             serve Streamable HTTP instead of stdio; each request brings its own
                     token as "Authorization: Bearer mdw_..."
  --host <host>      http only, default 127.0.0.1 (env MEADOW_MCP_HOST)
  --port <port>      http only, default 8765 (env MEADOW_MCP_PORT)

Create a token under Profile > Access tokens.`

export function parseConfig(argv: readonly string[], env: NodeJS.ProcessEnv): Config {
  const flags = new Map<string, string | true>()
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') throw new ConfigError(USAGE)
    if (!arg.startsWith('--')) throw new ConfigError(`unexpected argument ${arg}\n\n${USAGE}`)
    const [name, inline] = arg.slice(2).split('=', 2)
    if (name === 'http') {
      flags.set(name, true)
      continue
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined || (inline === undefined && value.startsWith('--'))) {
      throw new ConfigError(`--${name} needs a value\n\n${USAGE}`)
    }
    if (inline === undefined) index += 1
    flags.set(name, value)
  }

  const text = (flag: string, variable: string): string | undefined => {
    const value = flags.get(flag)
    return typeof value === 'string' ? value : env[variable]
  }

  const api = text('api', 'MEADOW_API_URL')
  if (api === undefined || api === '') throw new ConfigError(`--api is required\n\n${USAGE}`)
  let origin: URL
  try {
    origin = new URL(api)
  } catch {
    throw new ConfigError(`--api is not a URL: ${api}`)
  }

  const transport: Transport = flags.get('http') === true ? 'http' : 'stdio'
  const token = text('token', 'MEADOW_TOKEN') ?? null
  if (transport === 'stdio' && (token === null || token === '')) {
    throw new ConfigError(`--token is required\n\n${USAGE}`)
  }

  const port = Number(text('port', 'MEADOW_MCP_PORT') ?? 8765)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new ConfigError(`--port is not a port: ${port}`)
  }

  return {
    api: origin.origin + origin.pathname.replace(/\/+$/, ''),
    token: token === '' ? null : token,
    transport,
    host: text('host', 'MEADOW_MCP_HOST') ?? '127.0.0.1',
    port,
    idleMs: 60_000,
  }
}
