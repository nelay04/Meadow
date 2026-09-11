/*
 * Meadow's service worker. A template, not served as-is: the `serviceWorker()` plugin in
 * vite.config.ts fills in the two placeholders at build time and emits the result as
 * /sw.js. There is no worker in dev, on purpose - a cached shell under a hot-reloading
 * dev server is a stale page nobody asked for.
 *
 * What it does, and nothing more:
 *   - The /app shell is network-first. Online, every launch gets the current deploy,
 *     exactly as it does without a worker; offline, it gets the last one it saw.
 *   - The fingerprinted bundles are precached at install and served cache-first. Their
 *     names change whenever their contents do, so a cached copy is never stale.
 *   - Fonts and brand images are cached the first time they are fetched.
 *
 * What it never touches: /api and /ws. Auth, board data and live sync go to the network
 * or fail the way they always have; a cached API answer would be a stale board or,
 * worse, somebody else's session. Offline board content is y-indexeddb's job, not this.
 */

const VERSION = '__MEADOW_SW_VERSION__'
const PRECACHE = /* __MEADOW_SW_PRECACHE__ */ []

const CACHE = `meadow-${VERSION}`
const SHELL = '/app'

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([SHELL, ...PRECACHE]))
      // Take over as soon as the new bundles are in. Safe because the shell is
      // network-first: an open tab keeps the page it has, and the next launch was going
      // to get the new deploy from the network anyway.
      .then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((key) => key.startsWith('meadow-') && key !== CACHE).map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) return

  if (request.mode === 'navigate') {
    // Only the app's own two spellings. The query rides along on the network request (a
    // share link is /app?k=<token>) and is dropped only for the offline fallback.
    if (url.pathname === '/app' || url.pathname === '/app/') {
      event.respondWith(networkFirst(request))
    }
    return
  }

  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Images only. /brand also holds the splash video, which arrives as range requests a
  // cache cannot store whole, and is five megabytes nobody needs offline.
  if (url.pathname.startsWith('/brand/') && url.pathname.endsWith('.png')) {
    event.respondWith(cacheFirst(request))
  }
})

async function networkFirst(request) {
  const cache = await caches.open(CACHE)
  try {
    const response = await fetch(request)
    if (response.ok) cache.put(SHELL, response.clone())
    return response
  } catch (error) {
    const cached = await cache.match(SHELL)
    if (cached !== undefined) return cached
    throw error
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE)
  const cached = await cache.match(request)
  if (cached !== undefined) return cached
  const response = await fetch(request)
  if (response.ok) cache.put(request, response.clone())
  return response
}
