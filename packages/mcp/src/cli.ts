#!/usr/bin/env node
/**
 * `meadow-mcp`: stdio for local clients, Streamable HTTP for remote ones.
 *
 * stdio is one person, one token, one process: coding agents and editors
 * start it as a subprocess. HTTP is for clients that connect to a URL (web assistant
 * connectors, and anything behind a proxy): every session is opened with a bearer
 * token and every later request on that session must bring the same one.
 *
 * Nothing is written to stdout in stdio mode except protocol messages, so every log line
 * goes to stderr.
 */

import { createHash, randomUUID } from 'node:crypto'
import {
  type IncomingMessage,
  type ServerResponse,
  createServer as createHttpServer,
} from 'node:http'

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js'

import { MeadowApi, type TokenInfo } from './api'
import { type Config, ConfigError, parseConfig } from './config'
import { VERSION, createServer } from './server'

const log = (message: string): void => {
  process.stderr.write(`meadow-mcp: ${message}\n`)
}

async function stdio(config: Config): Promise<void> {
  const api = new MeadowApi(config.api, config.token as string)
  // Checked up front, so a wrong token is a clear message at startup rather than the
  // first tool call failing inside a client that may not show the reason.
  let access: TokenInfo
  try {
    const [me, token] = await Promise.all([api.me(), api.currentToken()])
    access = token
    const scope =
      token.kind === 'classic'
        ? 'classic token, full access'
        : `fine-grained token, ${token.grants?.length ?? 0} glade(s)`
    log(`${VERSION} connected to ${config.api} as ${me.display_name} (${scope})`)
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }

  const { server, close } = createServer({
    api,
    idleMs: config.idleMs,
    access,
    snapshots: config.snapshots,
    site: config.api.replace(/\/+$/, ''),
  })
  const shutdown = (): void => {
    close()
    void server.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
  process.stdin.on('close', shutdown)
  await server.connect(new StdioServerTransport())
}

/** How long an HTTP session lives with no requests. A client that comes back later re-initialises. */
const SESSION_IDLE_MS = 30 * 60_000
const MAX_BODY_BYTES = 8 * 1024 * 1024

type Session = {
  transport: StreamableHTTPServerTransport
  close: () => void
  tokenHash: string
  lastUsed: number
}

function bearer(request: IncomingMessage): string | null {
  const header = request.headers.authorization
  if (header === undefined) return null
  const match = /^Bearer\s+(\S+)$/i.exec(header)
  return match === null ? null : match[1]
}

/**
 * Where a client finds out how to sign in (RFC 9728). Built from the forwarded host and
 * scheme nginx sets, so it names the public address rather than this container's.
 */
function publicOrigin(request: IncomingMessage): string | undefined {
  const forwarded = request.headers['x-forwarded-proto']
  const scheme = forwarded === 'https' || forwarded === 'http' ? forwarded : 'http'
  const host = request.headers.host
  if (host === undefined || !/^[A-Za-z0-9.:\[\]-]+$/.test(host)) return undefined
  return `${scheme}://${host}`
}

function challenge(request: IncomingMessage): string {
  const origin = publicOrigin(request)
  if (origin === undefined) return 'Bearer'
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`
}

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex')

function reply(
  response: ServerResponse,
  status: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers })
  response.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }))
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    size += (chunk as Buffer).length
    if (size > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  return text === '' ? undefined : JSON.parse(text)
}

async function http(config: Config): Promise<void> {
  const sessions = new Map<string, Session>()

  const sweeper = setInterval(() => {
    const now = Date.now()
    for (const [id, session] of sessions) {
      if (now - session.lastUsed > SESSION_IDLE_MS) {
        session.close()
        void session.transport.close()
        sessions.delete(id)
      }
    }
  }, 60_000)
  sweeper.unref()

  const server = createHttpServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      if (url.pathname === '/healthz') {
        response.writeHead(200, { 'content-type': 'text/plain' }).end('ok')
        return
      }
      if (url.pathname !== '/mcp') {
        reply(response, 404, 'not found')
        return
      }

      const token = bearer(request)
      if (token === null) {
        reply(
          response,
          401,
          'a Meadow access token is required as "Authorization: Bearer mdw_..."',
          {
            'www-authenticate': challenge(request),
          },
        )
        return
      }

      const sessionId = request.headers['mcp-session-id']
      const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined
      if (existing !== undefined) {
        // A session belongs to the token that opened it. Another token presenting its id
        // gets nothing: not the session, and not a hint that it exists.
        if (existing.tokenHash !== hashToken(token)) {
          reply(response, 404, 'session not found')
          return
        }
        existing.lastUsed = Date.now()
        const body = request.method === 'POST' ? await readBody(request) : undefined
        await existing.transport.handleRequest(request, response, body)
        return
      }

      if (request.method !== 'POST') {
        reply(response, 400, 'no session; send an initialize request first')
        return
      }
      const body = await readBody(request)
      if (!isInitializeRequest(body)) {
        reply(
          response,
          typeof sessionId === 'string' ? 404 : 400,
          'session not found; initialize again',
        )
        return
      }

      const api = new MeadowApi(config.api, token)
      let access: TokenInfo
      try {
        access = await api.currentToken()
      } catch (error) {
        reply(response, 401, error instanceof Error ? error.message : 'access token refused', {
          'www-authenticate': challenge(request),
        })
        return
      }

      const { server: mcp, close } = createServer({
        api,
        idleMs: config.idleMs,
        access,
        snapshots: config.snapshots,
        site: publicOrigin(request),
      })
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, close, tokenHash: hashToken(token), lastUsed: Date.now() })
        },
      })
      transport.onclose = () => {
        if (transport.sessionId !== undefined) sessions.delete(transport.sessionId)
        close()
      }
      await mcp.connect(transport)
      await transport.handleRequest(request, response, body)
    })().catch((error: unknown) => {
      log(error instanceof Error ? (error.stack ?? error.message) : String(error))
      if (!response.headersSent) reply(response, 500, 'internal error')
    })
  })

  server.listen(config.port, config.host, () => {
    log(
      `${VERSION} serving Streamable HTTP on http://${config.host}:${config.port}/mcp for ${config.api}`,
    )
  })

  const shutdown = (): void => {
    for (const session of sessions.values()) {
      session.close()
      void session.transport.close()
    }
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

let config: Config
try {
  config = parseConfig(process.argv.slice(2), process.env)
} catch (error) {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`)
    process.exit(error.message.startsWith('meadow-mcp:') ? 0 : 2)
  }
  throw error
}

await (config.transport === 'http' ? http(config) : stdio(config))
