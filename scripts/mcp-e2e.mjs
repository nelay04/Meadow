/**
 * End-to-end check of the Meadow MCP server.
 *
 * Real API, real web app, the built `meadow-mcp` bundle over stdio and over Streamable
 * HTTP, and a browser with the glade open watching the agent's edits arrive. The unit
 * tests in packages/mcp cover planning and parsing against a local Y.Doc; this is the
 * only check that covers the access token, the handshake, the headless peer and
 * persistence together.
 *
 * Requires postgres and redis: docker compose -f docker-compose.local.yml up -d
 * and a built bundle: pnpm --filter @meadow/mcp build (this script builds it).
 */

import { spawn, spawnSync } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

import { chromium } from 'playwright'

const sdk = (path) =>
  import(new URL(`../packages/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/${path}`, import.meta.url))
const { Client } = await sdk('client/index.js')
const { StdioClientTransport } = await sdk('client/stdio.js')
const { StreamableHTTPClientTransport } = await sdk('client/streamableHttp.js')

const API_PORT = process.env.E2E_API_PORT ?? '8016'
const WEB_PORT = process.env.E2E_WEB_PORT ?? '3096'
const MCP_PORT = process.env.E2E_MCP_PORT ?? '8766'
const BUNDLE = new URL('../packages/mcp/dist/meadow-mcp.js', import.meta.url).pathname

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

const built = spawnSync('pnpm', ['--filter', '@meadow/mcp', 'build'], { stdio: 'inherit' })
if (built.status !== 0) {
  console.error('FAIL  building the MCP bundle')
  process.exit(1)
}

// Mail off and rate limits off, for the reasons board-e2e.mjs gives.
const api = spawn(
  'bash',
  ['-c', `cd services/api && exec .venv/bin/python -m uvicorn app.main:app --host 127.0.0.1 --port ${API_PORT} --log-level warning`],
  {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      MEADOW_RATE_LIMIT_ENABLED: 'false',
      MEADOW_SMTP_HOST: '',
      MEADOW_SMTP_FROM: '',
      MEADOW_MAIL_PROVIDER: 'none',
    },
  },
)
procs.push(api)

const web = spawn('pnpm', ['--filter', 'web', 'exec', 'vite', '--port', WEB_PORT, '--strictPort'], {
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, API_PORT, WEB_PORT },
})
procs.push(web)

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

const apiBase = `http://127.0.0.1:${API_PORT}`
const webBase = `http://127.0.0.1:${WEB_PORT}`
await waitFor(`${apiBase}/healthz`, 'api')
await waitFor(webBase, 'web')

async function rest(path, { method = 'GET', body, token } = {}) {
  const response = await fetch(`${apiBase}/api/v1${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text === '' ? null : JSON.parse(text) }
}

const email = `mcp-e2e-${Date.now()}@meadow.dev`
const password = 'correct-horse-battery-staple'
const registered = await rest('/auth/register', { method: 'POST', body: { email, password, display_name: 'MCP E2E' } })
if (registered.status !== 202) {
  console.error(`FAIL  register returned ${registered.status}. Is the database up and migrated?`)
  process.exit(1)
}
const session = (await rest('/auth/login', { method: 'POST', body: { email, password } })).body.access_token
const workspaceId = (await rest('/auth/me', { token: session })).body.default_workspace_id
const board = (await rest('/boards', { method: 'POST', token: session, body: { workspace_id: workspaceId, title: 'MCP glade' } })).body

const other = (await rest('/boards', { method: 'POST', token: session, body: { workspace_id: workspaceId, title: 'Other glade' } })).body
const layoutGlade = (await rest('/boards', { method: 'POST', token: session, body: { workspace_id: workspaceId, title: 'Layout glade' } })).body
const hidden = (await rest('/boards', { method: 'POST', token: session, body: { workspace_id: workspaceId, title: 'Hidden glade' } })).body

const writeToken = await rest('/tokens', { method: 'POST', token: session, body: { name: 'e2e classic', kind: 'classic' } })
const readToken = await rest('/tokens', {
  method: 'POST',
  token: session,
  body: { name: 'e2e reader', kind: 'fine_grained', grants: [{ board_id: board.id, read: true }] },
})
// Edit but not delete on the main glade, delete but not edit on the other, nothing on the third.
const splitToken = await rest('/tokens', {
  method: 'POST',
  token: session,
  body: {
    name: 'e2e split',
    kind: 'fine_grained',
    grants: [
      { board_id: board.id, read: true, edit: true },
      { board_id: other.id, read: true, delete: true },
    ],
  },
})
check(
  'a session mints classic and fine-grained access tokens',
  writeToken.status === 201 && readToken.status === 201 && splitToken.status === 201,
  `${writeToken.status} ${readToken.status} ${splitToken.status}`,
)

// --- the browser, watching ---------------------------------------------------------------

const browser = await chromium.launch({ channel: 'chromium', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage({ viewport: { width: 1280, height: 860 } })
await page.goto(`${webBase}/app`, { waitUntil: 'load' })
await page.fill('input[type="email"]', email)
await page.fill('input[type="password"]', password)
await page.click('button[type="submit"]')
await page.waitForSelector('text=MCP glade', { timeout: 20000 })
await page.click('text=MCP glade')
await page.waitForFunction(() => document.querySelector('.role')?.textContent?.trim() === 'owner', null, { timeout: 20000 })
check('the owner has the glade open in a browser', true)

const objectCount = () => page.textContent('[data-testid="object-count"]').then((text) => text?.trim())
const waitForCount = (expected, timeout = 10000) =>
  page
    .waitForFunction((want) => document.querySelector('[data-testid="object-count"]')?.textContent?.trim() === want, expected, { timeout })
    .then(() => true, () => false)

// --- stdio ---------------------------------------------------------------------------------

async function connectStdio(token) {
  const client = new Client({ name: 'Meadow E2E', version: '1.0.0' })
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [BUNDLE],
      env: { ...process.env, MEADOW_API_URL: apiBase, MEADOW_TOKEN: token },
      stderr: 'pipe',
    }),
  )
  return client
}

const call = async (client, name, args) => {
  const result = await client.callTool({ name, arguments: args })
  const text = result.content?.[0]?.text ?? ''
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* plain text result */
  }
  const image = result.content?.find((part) => part.type === 'image') ?? null
  return { error: result.isError === true, text, json, image }
}

/** A PNG's width and height from its header, or null when the bytes are not a PNG. */
const pngSize = (base64) => {
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 24 || bytes.toString('ascii', 1, 4) !== 'PNG') return null
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
}

const agent = await connectStdio(writeToken.body.token)
const tools = (await agent.listTools()).tools.map((tool) => tool.name)
check(
  'the server lists its read and write tools',
  ['list_glades', 'get_glade_graph', 'apply_diagram', 'update_objects', 'export_mermaid'].every((name) => tools.includes(name)),
  tools.join(', '),
)

const listed = await call(agent, 'list_glades', {})
check('list_glades finds the glade', listed.json?.some((entry) => entry.id === board.id), listed.text.slice(0, 200))

const previewed = await call(agent, 'apply_diagram', {
  glade_id: board.id,
  mermaid: 'flowchart LR\n  cart[Cart] -->|checkout| paid{Paid?}\n  paid -->|yes| done((Done))',
  preview: true,
})
check('a preview describes the plan', previewed.json?.preview === true && previewed.json.create.length === 5, previewed.text.slice(0, 300))
await delay(1000)
check('a preview leaves the glade untouched', (await objectCount()) === '0 objects', await objectCount())

const applied = await call(agent, 'apply_diagram', {
  glade_id: board.id,
  mermaid: 'flowchart LR\n  cart[Cart] -->|checkout| paid{Paid?}\n  paid -->|yes| done((Done))',
})
check('apply_diagram draws three nodes and two arrows', !applied.error && Object.keys(applied.json?.ids ?? {}).length === 5, applied.text.slice(0, 300))
check('the edit arrives in the open browser without a reload', await waitForCount('5 objects'), await objectCount())

const face = await page
  .waitForSelector('.wanderers [title*="via MCP"]', { timeout: 10000 })
  .then(() => true, () => false)
check('the agent shows up among the wanderers', face)

const graph = await call(agent, 'get_glade_graph', { glade_id: board.id })
const ids = applied.json.ids
const checkout = graph.json?.edges.find((edge) => edge.label === 'checkout')
check(
  'the graph reads the arrow as Cart -> Paid?',
  checkout?.from === ids.cart && checkout?.to === ids.paid && checkout?.direction === 'forward',
  JSON.stringify(checkout),
)

const renamed = await call(agent, 'update_objects', { glade_id: board.id, updates: [{ id: ids.cart, label: 'Basket' }] })
const relabelled = await page
  .waitForFunction(
    () => [...document.querySelectorAll('.meadow-overlay [data-object-id] .meadow-rt')].some((node) => node.textContent === 'Basket'),
    null,
    { timeout: 10000 },
  )
  .then(() => true, () => false)
check('relabelling by id renders in the browser', !renamed.error && relabelled, renamed.text.slice(0, 200))

const again = await call(agent, 'apply_diagram', {
  glade_id: board.id,
  mermaid: 'flowchart LR\n  b[Basket] -->|checkout| p[Paid?]\n  p -->|no| b',
})
check(
  're-applying matches nodes by label and adds only the missing arrow',
  !again.error && Object.keys(again.json?.matched ?? {}).length === 2 && Object.keys(again.json?.ids ?? {}).length === 1,
  again.text.slice(0, 300),
)
check('the glade now holds six objects', await waitForCount('6 objects'), await objectCount())

const mermaid = await call(agent, 'export_mermaid', { glade_id: board.id })
check('export_mermaid carries the labels', mermaid.text.includes('"Basket"') && mermaid.text.includes('|"no"|'), mermaid.text)

// --- layout ----------------------------------------------------------------------------------

const drawn = await call(agent, 'apply_diagram', {
  glade_id: layoutGlade.id,
  diagram: {
    direction: 'LR',
    nodes: [
      { key: 'member', label: 'Member', type: 'ellipse' },
      { key: 'portal', label: 'Web / Kiosk Portal' },
      { key: 'auth', label: 'Authentication\nlogin and roles' },
      { key: 'avail', label: 'Copy available?', type: 'diamond' },
      { key: 'circ', label: 'Circulation Service\nissue, return, renew' },
      { key: 'hold', label: 'Reservation Queue' },
      { key: 'db', label: 'Library DB\nbooks, copies, members, loans', type: 'cylinder' },
    ],
    edges: [
      { from: 'member', to: 'portal', label: 'search / borrow' },
      { from: 'portal', to: 'auth' },
      { from: 'auth', to: 'avail' },
      { from: 'avail', to: 'circ', label: 'yes: issue' },
      { from: 'avail', to: 'hold', label: 'no: place hold' },
      { from: 'circ', to: 'db' },
      { from: 'hold', to: 'db' },
      { from: 'auth', to: 'db', label: 'audit' },
    ],
  },
})
check('a laid-out diagram reports its layout as clean', !drawn.error && drawn.json?.layout === 'clean', drawn.text.slice(0, 400))

const checked = await call(agent, 'check_layout', { glade_id: layoutGlade.id })
check('check_layout reads the glade', !checked.error && typeof checked.json?.counts?.text_overflow === 'number', checked.text.slice(0, 300))

const tidied = await call(agent, 'tidy_layout', { glade_id: layoutGlade.id })
check('tidy_layout lays the glade out again', !tidied.error && (tidied.json?.updated?.length ?? 0) > 0, tidied.text.slice(0, 300))
const snap = await call(agent, 'get_glade_snapshot', { glade_id: layoutGlade.id, include_graph: true, max_width: 1200 })
const snapSize = snap.image === null ? null : pngSize(snap.image.data)
check(
  'get_glade_snapshot returns a PNG with the graph beside it',
  !snap.error && snap.image?.mimeType === 'image/png' && snapSize !== null && snapSize.width <= 1200 && snap.json?.graph?.nodes?.length === 7,
  `${snap.text.slice(0, 200)} ${JSON.stringify(snapSize)}`,
)
if (process.env.MCP_E2E_SNAPSHOT && snap.image !== null) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(process.env.MCP_E2E_SNAPSHOT, Buffer.from(snap.image.data, 'base64'))
}

if (process.env.MCP_E2E_SHOT) {
  // The drawn result on the real canvas, for a person to look at, then back to the glade
  // the reload check below expects to be on.
  const back = page.url()
  await page.setViewportSize({ width: 1600, height: 700 })
  await page.goto(`${webBase}/app#/glade/${layoutGlade.id}`, { waitUntil: 'load' })
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
  await delay(2500)
  await page.getByRole('button', { name: /fit/i }).first().click().catch(() => {})
  await delay(800)
  await page.screenshot({ path: process.env.MCP_E2E_SHOT })
  await page.goto(back, { waitUntil: 'load' })
  await page.reload({ waitUntil: 'load' })
  await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
  await page.setViewportSize({ width: 1280, height: 860 })
}

// --- fine-grained tokens --------------------------------------------------------------------

const reader = await connectStdio(readToken.body.token)
const readerTools = (await reader.listTools()).tools.map((tool) => tool.name)
check(
  'a read-only token is not offered tools it can use nowhere',
  readerTools.includes('get_glade_graph') &&
    !readerTools.includes('create_nodes') &&
    !readerTools.includes('delete_objects') &&
    !readerTools.includes('create_glade'),
  readerTools.join(', '),
)
const readerInstructions = reader.getInstructions() ?? ''
check(
  'the instructions state the token boundaries',
  readerInstructions.includes('fine-grained access token') && readerInstructions.includes('"MCP glade"'),
  readerInstructions.slice(-400),
)
const summary = await call(reader, 'get_glade_summary', { glade_id: board.id })
check(
  'a read-only token reads its glade and is told it can only read',
  !summary.error && summary.json?.objects === 6 && summary.json?.allowed === 'only read',
  summary.text.slice(0, 300),
)
const readerSnap = await call(reader, 'get_glade_snapshot', { glade_id: board.id })
check(
  'a view-only token can take a snapshot of its glade',
  !readerSnap.error && readerSnap.image !== null && pngSize(readerSnap.image.data) !== null,
  readerSnap.text.slice(0, 200),
)
const readerSnapElsewhere = await call(reader, 'get_glade_snapshot', { glade_id: other.id })
check(
  'a snapshot of a glade the token does not name is refused, with no image',
  readerSnapElsewhere.error && readerSnapElsewhere.image === null,
  readerSnapElsewhere.text.slice(0, 200),
)
const readerList = await call(reader, 'list_glades', {})
check('a fine-grained token lists only its glades', readerList.json?.length === 1, readerList.text.slice(0, 200))
await reader.close()

const splitter = await connectStdio(splitToken.body.token)
const access = await call(splitter, 'get_my_access', {})
check(
  'get_my_access lists each glade with its own permissions',
  access.json?.kind === 'fine_grained' &&
    access.json.glades.some((g) => g.id === board.id && g.edit && !g.delete) &&
    access.json.glades.some((g) => g.id === other.id && !g.edit && g.delete),
  access.text.slice(0, 400),
)
const cannotDelete = await call(splitter, 'delete_objects', { glade_id: board.id, ids: [ids.done] })
check(
  'deleting where only edit was granted is refused, naming the boundary',
  cannotDelete.error && /may read and edit, but not delete/.test(cannotDelete.text),
  cannotDelete.text,
)
const canEdit = await call(splitter, 'update_objects', { glade_id: board.id, updates: [{ id: ids.done, label: 'Shipped' }] })
check('editing where edit was granted works', !canEdit.error, canEdit.text.slice(0, 200))
const cannotEdit = await call(splitter, 'create_nodes', { glade_id: other.id, nodes: [{ label: 'nope' }] })
check(
  'editing where only delete was granted is refused',
  cannotEdit.error && /may read and delete, but not edit/.test(cannotEdit.text),
  cannotEdit.text,
)
const notGranted = await call(splitter, 'get_glade_summary', { glade_id: hidden.id })
check('a glade the token does not name cannot be opened', notGranted.error, notGranted.text)
await splitter.close()

// --- Streamable HTTP ---------------------------------------------------------------------------

const http = spawn(process.execPath, [BUNDLE, '--http', '--api', apiBase, '--port', MCP_PORT], { stdio: ['ignore', 'pipe', 'pipe'] })
procs.push(http)
await waitFor(`http://127.0.0.1:${MCP_PORT}/healthz`, 'mcp http')

const remote = new Client({ name: 'Meadow E2E HTTP', version: '1.0.0' })
await remote.connect(
  new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${MCP_PORT}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${writeToken.body.token}` } },
  }),
)
const overHttp = await call(remote, 'find_objects', { glade_id: board.id, text: 'paid' })
check('the HTTP transport serves tools with a bearer token', overHttp.json?.nodes?.length === 1, overHttp.text.slice(0, 200))
await remote.close()

const noToken = await fetch(`http://127.0.0.1:${MCP_PORT}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
})
check('the HTTP transport refuses a request with no token', noToken.status === 401, `status ${noToken.status}`)

// --- revocation and persistence ------------------------------------------------------------

const revoked = await rest(`/tokens/${writeToken.body.id}`, { method: 'DELETE', token: session })
check('revoking the write token succeeds', revoked.status === 204)
await delay(500)
const afterRevoke = await call(agent, 'create_nodes', { glade_id: board.id, nodes: [{ label: 'too late' }] })
check('a revoked token cannot write again', afterRevoke.error, afterRevoke.text.slice(0, 200))
const snapAfterRevoke = await call(agent, 'get_glade_snapshot', { glade_id: board.id })
check(
  'a revoked token cannot take a snapshot',
  snapAfterRevoke.error && snapAfterRevoke.image === null,
  snapAfterRevoke.text.slice(0, 200),
)
await agent.close()

await delay(1500)
await page.reload({ waitUntil: 'load' })
await page.waitForSelector('.canvas-host canvas', { timeout: 20000 })
check('the agent’s edits survive a reload', await waitForCount('6 objects', 15000), await objectCount())

if (process.env.E2E_SHOT) await page.screenshot({ path: process.env.E2E_SHOT })

await browser.close()
stop()
if (failures.length > 0) {
  console.log(`\n${failures.length} check(s) failed`)
  process.exit(1)
}
console.log('\nall MCP checks passed')
process.exit(0)
