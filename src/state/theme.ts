// Light or dark appearance for the studio, the home window and the bit gallery. The landing
// page keeps its own look and never turns dark. Saved on this device; 'system' follows the OS.
// index.html applies the saved choice before the first paint, so the loading screen matches.
import { create } from 'zustand'

export type ThemePref = 'system' | 'light' | 'dark'
export const THEME_PREFS: ThemePref[] = ['system', 'light', 'dark']
export const THEME_LABELS: Record<ThemePref, string> = { system: 'System', light: 'Light', dark: 'Dark' }

// index.html reads this key too; keep the two in step.
const KEY = 'forma.theme.v1'

const parse = (v: string | null): ThemePref => (v === 'light' || v === 'dark' ? v : 'system')

function load(): ThemePref {
  try {
    return parse(localStorage.getItem(KEY))
  } catch {
    return 'system'
  }
}

const darkQuery = () => (typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : undefined)
const resolve = (pref: ThemePref) => pref === 'dark' || (pref === 'system' && !!darkQuery()?.matches)

interface ThemeState {
  pref: ThemePref
  /** What is showing, after resolving 'system'. Stays false on pages that never go dark. */
  dark: boolean
  set: (pref: ThemePref) => void
}

let installed = false

export const useTheme = create<ThemeState>()((set) => ({
  pref: load(),
  dark: false,
  set: (pref) => {
    try {
      localStorage.setItem(KEY, pref)
    } catch {
      /* no storage */
    }
    set({ pref, dark: installed && resolve(pref) })
  },
}))

/** Whether the page is dark right now, for canvases and 3D scenes that draw their own colours. */
export const useIsDark = () => useTheme((s) => s.dark)

/**
 * Keep <html data-theme> in step with the saved choice, the OS setting and other windows.
 * Pages that keep their own look (the landing page) do not call this.
 */
export function installTheme() {
  installed = true
  const root = document.documentElement
  const meta = document.querySelector('meta[name="theme-color"]')
  const sync = () => useTheme.setState((s) => ({ dark: resolve(s.pref) }))
  const apply = (dark: boolean) => {
    root.dataset.theme = dark ? 'dark' : 'light'
    meta?.setAttribute('content', dark ? '#18191b' : '#fdfdfe')
  }
  useTheme.subscribe((s, prev) => {
    if (s.dark !== prev.dark || !root.dataset.theme) apply(s.dark)
  })
  sync()
  apply(useTheme.getState().dark)
  darkQuery()?.addEventListener('change', sync)
  // Another window (home vs studio in the desktop app, or another tab) changed it.
  window.addEventListener('storage', (e) => {
    if (e.key === KEY) useTheme.getState().set(parse(e.newValue))
  })
}
