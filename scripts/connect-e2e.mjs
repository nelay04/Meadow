/**
 * An assistant connecting by signing in, end to end, the way a web assistant does it.
 *
 * Discovery from the MCP server's 401, registration, the authorization request, a real
 * browser signing in and picking one glade on the consent screen, the code exchange, and
 * then the token it got used against the MCP server over HTTP, where it must see the
 * picked glade and nothing else. Ends with a refresh.
 *
 * Needs the data services: docker compose -f docker-compose.local.yml up -d postgres redis
 * and a built MCP bundle: pnpm --filter @meadow/mcp build
 */

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const sdk = (path) =>
  import(new URL(`../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/${path}`, import.meta.url))
const { Client } = await sdk('client/index.js')
const { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js')

const API_PORT = process.env.E2E_API_PORT ?? '8017'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3095'
const MCP_PORT = process.env.E2E_MCP_PORT ?? '8767'
const BUNDLE = new URL('../packages/mcp/dist/meadow-mcp.js', import.meta.url).pathname
const REDIRECT = 'https://assistant.example/callback'

const failures = []
const check = (name, ok, detail = '') => {
  if (ok) console.log(`PASS  ${name}`)
  else {
    console.log(`FAIL  ${name}${detail === '' ? '' : ` -- ${detail}`}`)
    failures.push(name)
  }
}

const procs = []
const stop = () => {
  for (const proc of procs) proc.kill('SIGTERM')
  procs.length = 0
}
process.on('exit', stop)

const apiBase = `http://127.0.0.1:${API_PORT}`
const webBase = `http://127.0.0.1:${WEB_PORT}`

procs.push(
  spawn(
    'bash',
    ['-c', `cd services/api && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT} --log-level warning`],
    {
      stdio: 'ignore',
      // Mail off, whichever provider the repo's .env picks, so accounts open at once and
      // nothing is sent to the made-up addresses below.
      env: {
        ...process.env,
        MEADOW_RATE_LIMIT_ENABLED: 'false',
        MEADOW_MAIL_PROVIDER: 'smtp',
        MEADOW_RESEND_API_KEY: '',
        MEADOW_SMTP_HOST: '',
        MEADOW_SMTP_FROM: '',
        MEADOW_WEB_BASE_URL: webBase,
      },
    },
  ),
)
procs.push(
  spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', WEB_PORT, '--strictPort'], {
    stdio: 'ignore',
    env: { ...process.env, API_PORT, WEB_PORT },
  }),
)
procs.push(spawn(process.execPath, [BUNDLE, '--http', '--api', apiBase, '--port', MCP_PORT], { stdio: 'ignore' }))

async function waitFor(url, label) {
  for (let i = 0; i < 80; i += 1) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      /* not up yet */
    }
    await delay(500)
  }
  throw new Error(`${label} did not start at ${url}`)
}
await waitFor(`${apiBase}/healthz`, 'api')
await waitFor(webBase, 'web')
await waitFor(`http://127.0.0.1:${MCP_PORT}/healthz`, 'mcp')

const email = `connect-${Date.now()}@meadow.dev`
const password = 'correct-horse-battery-staple'
await fetch(`${apiBase}/api/v1/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email, password, display_name: 'Connect Person' }),
})
const login = await (
  await fetch(`${apiBase}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
).json()
if (typeof login.access_token !== 'string') {
  console.error('FAIL  could not sign the test account in', JSON.stringify(login))
  process.exit(1)
}
const session = { 'content-type': 'application/json', authorization: `Bearer ${login.access_token}` }
const workspaces = await (await fetch(`${apiBase}/api/v1/workspaces`, { headers: session })).json()
const workspaceId = (Array.isArray(workspaces) ? workspaces[0] : workspaces.items?.[0])?.id
const makeBoard = async (title) =>
  (
    await fetch(`${apiBase}/api/v1/boards`, {
      method: 'POST',
      headers: session,
      body: JSON.stringify({ workspace_id: workspaceId, title }),
    })
  ).json()
const picked = await makeBoard('Picked glade')
const hidden = await makeBoard('Hidden glade')

// --- discovery ---------------------------------------------------------------------

const refused = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
})
check(
  'the MCP server points a client without a token at sign-in',
  refused.status === 401 &&
    (refused.headers.get('www-authenticate') ?? '').includes('resource_metadata="'),
  refused.headers.get('www-authenticate') ?? '(none)',
)

const resource = await (await fetch(`${webBase}/.well-known/oauth-protected-resource/mcp`)).json()
check('the protected resource names this site as its server', resource.authorization_servers?.[0] === webBase, JSON.stringify(resource))
const server = await (await fetch(`${webBase}/.well-known/oauth-authorization-server`)).json()
check('the authorization server describes itself', server.issuer === webBase, JSON.stringify(server))

// --- registration and the browser ------------------------------------------------------

const registered = await (
  await fetch(server.registration_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Test Assistant', redirect_uris: [REDIRECT] }),
  })
).json()
check('the assistant registers', typeof registered.client_id === 'string', JSON.stringify(registered))

const verifier = randomBytes(48).toString('base64url')
const challenge = createHash('sha256').update(verifier).digest('base64url')
const authorizeUrl = `${server.authorization_endpoint}?${new URLSearchParams({
  response_type: 'code',
  client_id: registered.client_id,
  redirect_uri: REDIRECT,
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state: 'e2e-state',
  resource: resource.resource,
})}`

const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const context = await browser.newContext({ viewport: { width: 1100, height: 900 } })
const page = await context.newPage()
const errors = []
page.on('pageerror', (error) => errors.push(error.message))

let returned = null
await page.route('https://assistant.example/**', async (route) => {
  returned = route.request().url()
  await route.fulfill({ status: 200, contentType: 'text/plain', body: 'back at the assistant' })
})

await page.goto(authorizeUrl)
await page.waitForSelector('input[type="email"]', { timeout: 20000 })
check('a signed-out person is asked to sign in first', page.url().includes('#/connect/'), page.url())
await page.fill('input[type="email"]', email)
await page.fill('input[type="password"]', password)
await page.click('button[type="submit"]')

await page.waitForSelector('text=Test Assistant wants to use Meadow as you', { timeout: 20000 })
check('the consent screen names the assistant and where the answer goes', await page.getByText('assistant.example').isVisible())
const allow = page.getByRole('button', { name: 'Allow' })
check('nothing is granted until something is picked', await allow.isDisabled())

await page.getByText('Picked glade', { exact: true }).locator('xpath=..').getByRole('button', { name: 'View' }).click()
await delay(300)
if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })
check('picking a glade enables Allow', await allow.isEnabled())
await allow.click()
for (let i = 0; i < 40 && returned === null; i += 1) await delay(250)

const back = returned === null ? null : new URL(returned)
check('the browser is sent back to the assistant with a code', back?.searchParams.get('code') !== null && back !== null, returned ?? '(never)')
check('the state comes back unchanged', back?.searchParams.get('state') === 'e2e-state')
check('no page errors', errors.length === 0, errors.join(' | '))
await browser.close()

// --- the token -------------------------------------------------------------------------

const exchange = async (form) =>
  fetch(server.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(form),
  })
const issued = await (
  await exchange({
    grant_type: 'authorization_code',
    code: back?.searchParams.get('code') ?? '',
    redirect_uri: REDIRECT,
    client_id: registered.client_id,
    code_verifier: verifier,
  })
).json()
check('the code becomes an access token and a refresh token', issued.access_token?.startsWith('mdw_') && typeof issued.refresh_token === 'string', JSON.stringify(issued))

const listedBy = async (token) => {
  const client = new Client({ name: 'Meadow connect E2E', version: '1.0.0' })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  )
  const result = await client.callTool({ name: 'list_glades', arguments: {} })
  await client.close()
  return JSON.parse(result.content?.[0]?.text ?? '[]')
}

const glades = await listedBy(issued.access_token)
const ids = glades.map((glade) => glade.id)
check('over MCP the token sees the picked glade', ids.includes(picked.id), JSON.stringify(ids))
check('and not the one left out', !ids.includes(hidden.id), JSON.stringify(ids))

const refreshed = await (
  await exchange({ grant_type: 'refresh_token', refresh_token: issued.refresh_token, client_id: registered.client_id })
).json()
check('refreshing issues a new access token', refreshed.access_token?.startsWith('mdw_') && refreshed.access_token !== issued.access_token, JSON.stringify(refreshed))
check('the refreshed token works over MCP', (await listedBy(refreshed.access_token)).some((glade) => glade.id === picked.id))

stop()
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall connect checks passed')
