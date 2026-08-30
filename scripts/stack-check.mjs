/**
 * Production stack check.
 *
 * Drives the running docker-compose.yml stack through nginx on its published port,
 * the way a browser reaches it. Everything here is a property of the deployment
 * rather than of the application: the m0 gate and the e2e scripts already talk to a
 * uvicorn on the host, so they would pass against a stack whose proxy config was
 * wrong in every way that matters.
 *
 *   docker compose --env-file .env.prod up -d
 *   node scripts/stack-check.mjs
 *
 * Reads WEB_PUBLIC_PORT (default 8080) to find the stack.
 *
 * On a deployment that sends activation mail, the account this script registers cannot
 * log in until somebody opens its link, so point it at one that is already activated:
 *
 *   STACK_CHECK_EMAIL=you@example.com STACK_CHECK_PASSWORD=... node scripts/stack-check.mjs
 */

import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const PORT = process.env.WEB_PUBLIC_PORT ?? '8080'
const HOST = process.env.WEB_CHECK_HOST ?? '127.0.0.1'
const BASE = `http://${HOST}:${PORT}`
const WS = `ws://${HOST}:${PORT}/ws/board`

let failures = 0

function log(ok, message, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}${detail === undefined ? '' : ` (${detail})`}`)
  if (!ok) failures += 1
}

let accessToken = null

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  const merged = { ...headers }
  if (body !== undefined) merged['content-type'] = 'application/json'
  if (accessToken !== null) merged.authorization = `Bearer ${accessToken}`
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: merged,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  return response
}

async function json(path, options) {
  const response = await call(path, options)
  if (!response.ok) throw new Error(`${options?.method ?? 'GET'} ${path} -> ${response.status}`)
  return response.status === 204 ? null : response.json()
}

async function phaseStatic() {
  console.log('\n== phase: the SPA is served, not a placeholder')

  const index = await fetch(`${BASE}/`)
  const html = await index.text()
  log(index.ok, `GET / -> ${index.status}`)
  log(
    /<script[^>]+src="\/assets\/[^"]+\.js"/.test(html),
    'index.html references a fingerprinted bundle',
  )
  log(
    (index.headers.get('cache-control') ?? '').includes('no-cache'),
    'index.html is not cacheable',
    index.headers.get('cache-control'),
  )
  log(
    index.headers.get('x-content-type-options') === 'nosniff',
    'security headers are set on the document',
  )

  // A client-side route is not a file on disk. Without the fallback this 404s and the
  // app is unusable on reload, which is the classic SPA deployment bug.
  const deep = await fetch(`${BASE}/board/2f1c9a44-0000-4000-8000-000000000000`)
  log(deep.ok, `GET /board/<uuid> falls back to the app -> ${deep.status}`)

  const bundle = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  if (bundle === undefined) {
    log(false, 'could not find a bundle URL to check')
    return
  }
  const asset = await fetch(`${BASE}${bundle}`)
  log(asset.ok, `the bundle itself is served -> ${asset.status}`)
  log(
    (asset.headers.get('cache-control') ?? '').includes('immutable'),
    'fingerprinted assets are immutable',
    asset.headers.get('cache-control'),
  )

  // The fallback must not swallow this. `try_files $uri /index.html` under /assets/
  // would answer a missing bundle with HTML, and the browser reports a MIME type
  // error rather than the 404 that would point at the real problem.
  const missing = await fetch(`${BASE}/assets/definitely-not-here.js`)
  log(missing.status === 404, `a missing asset is a 404, not the app -> ${missing.status}`)

  const font = await fetch(`${BASE}/fonts/inter-100-900-latin.woff2`)
  log(font.ok, `self-hosted fonts are served -> ${font.status}`)
}

async function phaseApi() {
  console.log('\n== phase: the API is reachable through the proxy')

  const health = await fetch(`${BASE}/healthz`)
  const body = await health.json().catch(() => null)
  log(
    health.ok && body?.status === 'ok',
    '/healthz reaches the API, not the SPA fallback',
    JSON.stringify(body),
  )

  const credentials = {
    email: `stack-${Date.now().toString(36)}@meadow-check.dev`,
    password: 'stack-check-password',
  }
  const attempt = await call('/api/v1/auth/register', {
    method: 'POST',
    body: { ...credentials, display_name: 'Stack Check' },
  })
  if (attempt.status === 429) {
    // Registration is limited to a handful an hour per address, so a few runs in
    // quick succession exhaust it. Say so, rather than reporting it as a stack fault.
    throw new Error(
      'registration is rate limited for this address; the stack is up, but this check ' +
        'can only run a few times an hour against it. Wait, or bring the stack up with ' +
        'MEADOW_RATE_LIMIT_ENABLED=false.',
    )
  }
  if (!attempt.ok) throw new Error(`POST /api/v1/auth/register -> ${attempt.status}`)
  log(attempt.status === 202, 'POST /api/v1/auth/register through nginx', `status ${attempt.status}`)

  /*
   * The session comes from a login, and on a deployment that sends mail it comes from
   * an account somebody has already activated.
   *
   * `POST /register` answers 202 and deliberately signs nobody in: until the address
   * answers, every other endpoint refuses the account. This read `access_token` off
   * the registration response until activation shipped in M6, and it has been
   * `undefined` since, so every authenticated check below was running without a token.
   *
   * Which of the two paths applies is a property of the deployment, which is what this
   * script is for. With no relay configured the account just registered is opened
   * immediately and logs straight in. With a relay it is waiting on a link nobody here
   * can read, so the operator supplies an account that is already through the door.
   * There is deliberately no back door into the database from here: reaching around
   * the stack to activate a row would make this check pass against a deployment whose
   * activation is broken, which is the opposite of its job.
   */
  const supplied = process.env.STACK_CHECK_EMAIL
  const identity =
    supplied === undefined
      ? credentials
      : { email: supplied, password: process.env.STACK_CHECK_PASSWORD ?? '' }

  const session = await call('/api/v1/auth/login', { method: 'POST', body: identity })
  if (!session.ok) {
    const detail = (await session.text()).slice(0, 160)
    throw new Error(
      supplied === undefined
        ? `POST /api/v1/auth/login -> ${session.status}: ${detail}\n` +
          'The account this check just registered cannot log in, which on a deployment ' +
          'that sends mail means it is waiting for its activation link. Point the check ' +
          'at an account that is already activated:\n' +
          '  STACK_CHECK_EMAIL=you@example.com STACK_CHECK_PASSWORD=... pnpm check:stack'
        : `POST /api/v1/auth/login -> ${session.status}: ${detail}\n` +
          `STACK_CHECK_EMAIL is set to ${supplied}; check the password and that the ` +
          'account is activated on this deployment.',
    )
  }

  const authenticated = await session.json()
  accessToken = authenticated.access_token
  log(typeof accessToken === 'string', 'POST /api/v1/auth/login through nginx')

  return authenticated.user.default_workspace_id
}

async function connect(boardId, label) {
  const doc = new Y.Doc()
  const token = (await json('/api/v1/ws-token', { method: 'POST', body: { board_id: boardId } })).token
  const provider = new WebsocketProvider(WS, boardId, doc, {
    WebSocketPolyfill: WebSocket,
    params: { token },
    maxBackoffTime: 1000,
    // Two clients in one process would otherwise sync through a BroadcastChannel and
    // never prove the server relayed anything.
    disableBc: true,
  })

  const connected = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 10000)
    provider.on('status', (event) => {
      if (event.status === 'connected') {
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
  if (!connected) throw new Error(`${label} failed to connect`)

  await new Promise((resolve) => {
    if (provider.synced) return resolve()
    provider.once('sync', resolve)
    setTimeout(resolve, 4000)
  })
  return { doc, provider, objects: doc.getMap('objects') }
}

async function phaseWebsocket(workspaceId) {
  console.log('\n== phase: websockets survive the proxy')

  const board = await json('/api/v1/boards', {
    method: 'POST',
    body: { workspace_id: workspaceId, title: 'stack check' },
  })

  const a = await connect(board.id, 'A')
  log(true, 'a yjs client completed the upgrade through nginx')

  a.doc.transact(() => {
    const shape = new Y.Map()
    shape.set('id', 'stack-rect')
    shape.set('type', 'rect')
    shape.set('x', 40)
    shape.set('y', 40)
    shape.set('w', 100)
    shape.set('h', 60)
    a.objects.set('stack-rect', shape)
  }, 'stack-check')

  const b = await connect(board.id, 'B')
  const converged = await waitFor(() => b.objects.size === 1, 8000)
  log(converged, 'a second client converged on the first one\'s edit', `saw ${b.objects.size}`)

  a.provider.destroy()
  b.provider.destroy()
}

async function phaseForgedForwardedFor() {
  console.log('\n== phase: a client cannot choose its own rate-limit identity')

  // Login rather than register, for two reasons. Its window is 60 seconds against
  // registration's hour, so running this check twice in a row is not a twenty-minute
  // wait; and a refused login leaves nothing behind, while a probe built on
  // registration either creates junk accounts or fails on the duplicates.
  //
  // Every attempt below carries a different forged X-Forwarded-For. If nginx passed
  // the caller's header through, or uvicorn trusted anyone to set it, each value would
  // be a bucket of its own and every attempt would come back 401 for the bad password.
  // Sharing one bucket is the whole property.
  const statuses = []
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const response = await call('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'x-forwarded-for': `203.0.113.${attempt + 1}` },
      body: { email: 'nobody@meadow-check.dev', password: 'not-the-password' },
    })
    statuses.push(response.status)
  }

  const refused = statuses.filter((status) => status === 429).length
  log(
    refused > 0,
    'forged X-Forwarded-For values share one bucket and get refused',
    `statuses ${statuses.join(',')}`,
  )
}

function waitFor(predicate, timeoutMs) {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      if (predicate()) return resolve(true)
      if (Date.now() > deadline) return resolve(false)
      setTimeout(tick, 100)
    }
    tick()
  })
}

async function main() {
  console.log(`checking the stack at ${BASE}`)
  await phaseStatic()
  const workspaceId = await phaseApi()
  await phaseWebsocket(workspaceId)
  // Last: it deliberately exhausts the login limit for this source address, which
  // clears on its own after a minute.
  await phaseForgedForwardedFor()

  console.log(failures === 0 ? '\nstack check passed' : `\nstack check failed: ${failures}`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
