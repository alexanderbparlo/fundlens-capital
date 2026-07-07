'use client'
import { useState, useEffect } from 'react'
import { Sun, Moon } from 'lucide-react'

export function ThemeToggle() {
  const [theme, setTheme] = useState('dark')

  useEffect(() => {
    // Hydration-safe read of an external store: the server renders the
    // 'dark' default, then the stored preference is applied after mount.
    const stored = localStorage.getItem('capital-theme') || 'dark'
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTheme(stored)
  }, [])

  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    setTheme(next)
    document.documentElement.className = next
    localStorage.setItem('capital-theme', next)
  }

  return (
    <button
      onClick={toggle}
      aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}
      className="flex items-center justify-center w-8 h-8 rounded-card text-text-muted hover:text-text-secondary transition-colors duration-200"
    >
      {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
    </button>
  )
}
