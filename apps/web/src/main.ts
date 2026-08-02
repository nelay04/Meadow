import { IndexeddbPersistence } from 'y-indexeddb'
import * as Y from 'yjs'

import { connectBoard, type ConnectionState } from './sync/provider'

/**
 * M0 harness. Exercises the real CRDT layout from ARCHITECTURE 4 (a flat `objects`
 * Y.Map keyed by id) rather than a toy Y.Text, so convergence and persistence are
 * proven against the schema the canvas will actually use.
 */

const TYPES = ['rect', 'ellipse', 'diamond', 'sticky'] as const

const el = {
  add: document.getElementById('add') as HTMLButtonElement,
  move: document.getElementById('move') as HTMLButtonElement,
  clear: document.getElementById('clear') as HTMLButtonElement,
  offline: document.getElementById('offline') as HTMLButtonElement,
  dot: document.getElementById('dot') as HTMLSpanElement,
  state: document.getElementById('state') as HTMLSpanElement,
  meta: document.getElementById('meta') as HTMLDivElement,
  rows: document.getElementById('rows') as HTMLTableSectionElement,
}

function nanoid(size = 12): string {
  const alphabet = 'useandom26T198340PX75pxJACKVERYMINDBUSHWOLFGQZbfghjklqvwyzrict'
  const bytes = crypto.getRandomValues(new Uint8Array(size))
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
}

/** Reuse one board across reloads so the restart test has something to reload. */
async function resolveBoardId(): Promise<string> {
  const cached = localStorage.getItem('meadow.m0.boardId')
  if (cached) return cached

  const response = await fetch('/api/v1/boards', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'M0 spike board' }),
  })
  if (!response.ok) throw new Error(`create board failed: ${response.status}`)

  const board: { id: string } = await response.json()
  localStorage.setItem('meadow.m0.boardId', board.id)
  return board.id
}

async function boot(): Promise<void> {
  const boardId = await resolveBoardId()

  const doc = new Y.Doc()
  const objects = doc.getMap<Y.Map<unknown>>('objects')

  // Offline persistence. Edits made while disconnected survive a reload and
  // replay on reconnect.
  const idb = new IndexeddbPersistence(`meadow-${boardId}`, doc)
  let idbSynced = false
  idb.on('synced', () => {
    idbSynced = true
    render()
  })

  let connection: ConnectionState = 'connecting'
  let detail = ''

  const link = connectBoard({
    boardId,
    doc,
    onState: (state, message) => {
      connection = state
      detail = message ?? ''
      render()
    },
  })

  const addObject = () => {
    const id = nanoid()
    const object = new Y.Map<unknown>()
    // Mutations go through one transaction with a consistent origin. In the real app
    // this lives in src/doc/mutations.ts, never in a component.
    doc.transact(() => {
      object.set('id', id)
      object.set('type', TYPES[Math.floor(Math.random() * TYPES.length)])
      object.set('x', Math.round(Math.random() * 2000))
      object.set('y', Math.round(Math.random() * 2000))
      object.set('w', 120)
      object.set('h', 80)
      object.set('rotation', 0)
      object.set('opacity', 1)
      object.set('locked', false)
      object.set('parentId', null)
      objects.set(id, object)
    }, 'local')
  }

  const moveRandom = () => {
    const keys = Array.from(objects.keys())
    if (keys.length === 0) return
    const key = keys[Math.floor(Math.random() * keys.length)]
    const object = objects.get(key)
    if (!object) return
    doc.transact(() => {
      object.set('x', Math.round(Math.random() * 2000))
      object.set('y', Math.round(Math.random() * 2000))
    }, 'local')
  }

  const clearAll = () => {
    doc.transact(() => {
      for (const key of Array.from(objects.keys())) objects.delete(key)
    }, 'local')
  }

  let online = true
  const toggleOffline = () => {
    online = !online
    if (online) {
      link.reconnect()
      el.offline.textContent = 'Go offline'
    } else {
      link.disconnect()
      el.offline.textContent = 'Go online'
    }
  }

  el.add.addEventListener('click', addObject)
  el.move.addEventListener('click', moveRandom)
  el.clear.addEventListener('click', clearAll)
  el.offline.addEventListener('click', toggleOffline)

  function render(): void {
    el.dot.className = `dot ${connection}`
    el.state.textContent = detail ? `${connection} (${detail})` : connection
    el.meta.textContent = [
      `board ${boardId}`,
      `objects ${objects.size}`,
      `idb ${idbSynced ? 'synced' : 'loading'}`,
      `clientID ${doc.clientID}`,
    ].join('  |  ')

    el.rows.replaceChildren()
    const entries = Array.from(objects.entries())
    if (entries.length === 0) {
      const row = el.rows.insertRow()
      const cell = row.insertCell()
      cell.colSpan = 6
      cell.className = 'empty'
      cell.textContent = 'no objects yet'
      return
    }
    for (const [id, object] of entries) {
      const row = el.rows.insertRow()
      row.className = 'mono'
      for (const value of [
        id,
        object.get('type'),
        object.get('x'),
        object.get('y'),
        object.get('w'),
        object.get('h'),
      ]) {
        row.insertCell().textContent = String(value)
      }
    }
  }

  objects.observeDeep(render)
  render()
}

void boot().catch((error: unknown) => {
  el.state.textContent = `boot failed: ${error instanceof Error ? error.message : String(error)}`
  el.dot.className = 'dot disconnected'
})
