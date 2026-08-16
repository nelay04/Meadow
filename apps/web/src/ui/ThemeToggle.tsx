/**
 * Cycles system, light, dark. One button rather than a menu: there are three states,
 * the icon says which one is active, and a dropdown for three options is a menu that
 * exists to be closed again.
 */

import { useState } from 'react'

import { IconAuto, IconMoon, IconSun } from './icons'
import { type Theme, applyTheme, nextTheme, readTheme } from './theme'

const LABEL: Record<Theme, string> = {
  system: 'Theme: match system',
  light: 'Theme: light',
  dark: 'Theme: dark',
}

export function ThemeToggle({ className = 'icon ghost' }: { className?: string }) {
  const [theme, setTheme] = useState<Theme>(readTheme)

  const cycle = () => {
    const next = nextTheme(theme)
    setTheme(next)
    applyTheme(next)
  }

  const Icon = theme === 'light' ? IconSun : theme === 'dark' ? IconMoon : IconAuto

  return (
    <button type="button" className={className} onClick={cycle} title={LABEL[theme]} aria-label={LABEL[theme]}>
      <Icon />
    </button>
  )
}
