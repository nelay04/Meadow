/**
 * M0 gate harness.
 *
 * Drives real yjs clients over the websocket, so this tests actual JS-to-pycrdt wire
 * compatibility rather than pycrdt talking to itself. Run in phases so the server can
 * be fully restarted between them; the restart is the part that actually tests the
 * persistence design.
 *
 *   node scripts/m0-gate.mjs seal      create board, two clients, assert convergence
 *   node scripts/m0-gate.mjs verify    after a server restart, assert state reloaded
 *   node scripts/m0-gate.mjs offline   edit while disconnected, reconnect, converge
 */

import { readFileSync, writeFileSync } from 'node:fs'
import WebSocket from 'ws'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'

const PORT = process.env.API_PORT ?? '8012'
const API = `http://127.0.0.1:${PORT}`
const WS = `ws://127.0.0.1:${PORT}/ws/board`
const STATE_FILE = new URL('../.m0-gate-board', import.meta.url)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function log(ok, message) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`)
  if (!ok) process.exitCode = 1
}

async function mintToken(boardId) {
  const response = await fetch(`${API}/api/v1/ws-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ board_id: boardId }),
  })
  if (!response.ok) throw new Error(`ws-token ${response.status}`)
  return (await response.json()).token
}

/** Connect one client with a freshly minted single-use token. */
async function connect(boardId, label) {
  const doc = new Y.Doc()
  const token = await mintToken(boardId)
  const provider = new WebsocketProvider(WS, boardId, doc, {
    WebSocketPolyfill: WebSocket,
    params: { token },
    // Reconnect is driven by the caller; a retry would replay the spent token.
    maxBackoffTime: 1000,
  })

  const connected = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), 8000)
    provider.on('status', (e) => {
      if (e.status === 'connected') {
        clearTimeout(timer)
        resolve(true)
      }
    })
  })
  if (!connected) throw new Error(`${label} failed to connect`)

  await new Promise((resolve) => {
    if (provider.synced) return resolve()
    provider.once('sync', resolve)
    setTimeout(resolve, 3000)
  })

  return { doc, provider, objects: doc.getMap('objects') }
}

function addObject(doc, objects, type, x) {
  const id = `obj-${type}-${x}`
  doc.transact(() => {
    const o = new Y.Map()
    o.set('id', id)
    o.set('type', type)
    o.set('x', x)
    o.set('y', 10)
    o.set('w', 120)
    o.set('h', 80)
    objects.set(id, o)
  }, 'gate')
  return id
}

async function phaseSeed() {
  const created = await fetch(`${API}/api/v1/boards`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'M0 gate' }),
  })
  const board = await created.json()
  writeFileSync(STATE_FILE, board.id)
  console.log(`board ${board.id}`)

  const a = await connect(board.id, 'A')
  log(true, 'client A connected with a valid ws-token')

  addObject(a.doc, a.objects, 'rect', 100)
  addObject(a.doc, a.objects, 'ellipse', 200)
  addObject(a.doc, a.objects, 'sticky', 300)
  await sleep(500)

  const b = await connect(board.id, 'B')
  await sleep(800)
  log(b.objects.size === 3, `client B converged on A's 3 objects (saw ${b.objects.size})`)

  // Concurrent edit in both directions.
  addObject(b.doc, b.objects, 'diamond', 400)
  await sleep(600)
  log(a.objects.size === 4, `client A saw B's object (${a.objects.size} objects)`)

  a.provider.destroy()
  b.provider.destroy()
  // Give the room's background ystore writes time to land before the room evicts.
  await sleep(1500)
  console.log('clients disconnected')
}

async function phaseVerify() {
  const boardId = readFileSync(STATE_FILE, 'utf8').trim()
  const c = await connect(boardId, 'C')
  await sleep(1000)
  log(
    c.objects.size === 4,
    `state reloaded from Postgres after full server restart (${c.objects.size} objects)`,
  )
  const types = [...c.objects.values()].map((o) => o.get('type')).sort()
  log(
    JSON.stringify(types) === JSON.stringify(['diamond', 'ellipse', 'rect', 'sticky']),
    `object contents intact: ${types.join(', ')}`,
  )
  c.provider.destroy()
  await sleep(300)
}

async function phaseOffline() {
  const boardId = readFileSync(STATE_FILE, 'utf8').trim()

  const d = await connect(boardId, 'D')
  await sleep(600)
  const before = d.objects.size

  // Simulate a network drop, edit while disconnected, then reconnect with a fresh
  // token. Nothing may be lost and both sides must agree afterwards.
  d.provider.disconnect()
  await sleep(300)
  addObject(d.doc, d.objects, 'offline', 999)
  log(d.objects.size === before + 1, 'offline edit applied locally while disconnected')

  d.provider.params = { token: await mintToken(boardId) }
  d.provider.connect()
  await sleep(1500)

  const e = await connect(boardId, 'E')
  await sleep(1000)
  log(
    e.objects.size === before + 1,
    `offline edit reached a fresh client after reconnect (${e.objects.size} objects)`,
  )

  d.provider.destroy()
  e.provider.destroy()
  await sleep(300)
}

async function phaseReject() {
  const boardId = readFileSync(STATE_FILE, 'utf8').trim()

  // A spent token must not open a second connection.
  const token = await mintToken(boardId)
  const once = new WebSocket(`${WS}/${boardId}?token=${token}`)
  await new Promise((r) => once.on('open', r))
  const replay = new WebSocket(`${WS}/${boardId}?token=${token}`)
  const replayCode = await new Promise((r) => replay.on('close', (code) => r(code)))
  log(replayCode === 4401, `replayed ws-token rejected with 4401 (got ${replayCode})`)
  once.close()

  // A garbage token must be rejected.
  const bad = new WebSocket(`${WS}/${boardId}?token=not-a-real-token`)
  const badCode = await new Promise((r) => bad.on('close', (code) => r(code)))
  log(badCode === 4401, `invalid ws-token rejected with 4401 (got ${badCode})`)

  // No token at all.
  const none = new WebSocket(`${WS}/${boardId}`)
  const noneCode = await new Promise((r) => none.on('close', (code) => r(code)))
  log(noneCode === 4401, `missing ws-token rejected with 4401 (got ${noneCode})`)
}

const phase = process.argv[2]
const phases = {
  seed: phaseSeed,
  verify: phaseVerify,
  offline: phaseOffline,
  reject: phaseReject,
}
if (!phases[phase]) {
  console.error(`usage: node scripts/m0-gate.mjs <${Object.keys(phases).join('|')}>`)
  process.exit(2)
}
await phases[phase]()
process.exit(process.exitCode ?? 0)
