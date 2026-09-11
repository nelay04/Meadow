import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import App from './App'
import './styles.css'
import { initTheme } from './ui/theme'

// Before the first render: `light-dark()` resolves against the root's colour-scheme,
// so applying the stored theme here is what stops a dark-theme user seeing a frame
// of cream.
initTheme()

const container = document.getElementById('root')
if (container === null) throw new Error('missing #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// The worker that makes Meadow installable and lets the shell open offline; see
// pwa/sw.js. Production builds only, since dev has no /sw.js to register. After `load`,
// so its precache does not compete with the board's first paint for the network.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/app' }).catch((error: unknown) => {
      console.warn('service worker registration failed', error)
    })
  })
}
