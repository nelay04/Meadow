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
