// Storage spaces. Everything a person makes (designs, presets, the bit kit, the Systainer
// layout) is stored per "space": `local` when no account is selected, `u:<account id>` for
// each account. Signing in switches to the account's space; signing out switches back.
// The local space is never touched by an account, so designs made without an account
// reappear, untouched, after signing out, and two accounts on one device never mix.
//
// A page picks its space once, at start-up, and keeps it. Switching (in this tab or another)
// reloads the page, so no store ever holds data from two spaces at once.
import { accountsEnabled, getSession, SESSION_KEY } from '../account/api'

export type SpaceId = string
export const LOCAL_SPACE: SpaceId = 'local'

const spaceOf = (accountId: string | null | undefined): SpaceId => (accountId ? 'u:' + accountId : LOCAL_SPACE)

/** The space the current session selects. */
export const sessionSpace = (): SpaceId => spaceOf(accountsEnabled() ? getSession()?.id : null)

let current: SpaceId | null = null

/** This page's space, fixed for its lifetime. */
export function currentSpace(): SpaceId {
  current ??= sessionSpace()
  return current
}

export const isAccountSpace = (space: SpaceId = currentSpace()) => space !== LOCAL_SPACE

/**
 * The localStorage key for a setting in a space. The local space keeps the original keys,
 * so data saved before spaces existed is the local space's data, with no migration.
 */
export function scopedKey(base: string, space: SpaceId = currentSpace()): string {
  return space === LOCAL_SPACE ? base : `formastudio:${space}:${base}`
}

/** Settings that follow an account between devices: kind on the server -> base key here. */
export const SYNCED_SETTINGS = {
  prefs: 'forma.prefs.v1',
  bits: 'forma.bitLibrary.v1',
  units: 'formastudio:units',
  systainer: 'formastudio:systainer-layout',
} as const
export type SettingKind = keyof typeof SYNCED_SETTINGS

let frozen = false

/**
 * Stop all writes to this page's space. Used right before switching spaces: the page is
 * about to reload, and nothing in flight may write the old space back after it is cleared.
 */
export function freezeStorage() {
  frozen = true
}
export const storageFrozen = () => frozen

const localListeners = new Set<() => void>()
const remoteListeners = new Map<string, Set<(raw: string | null) => void>>()

/** Read a per-space setting. */
export function readScoped(base: string, space?: SpaceId): string | null {
  try {
    return localStorage.getItem(scopedKey(base, space))
  } catch {
    return null
  }
}

/** Write a per-space setting and let the sync engine know. Returns false when storage refused. */
export function writeScoped(base: string, value: string | null): boolean {
  if (frozen) return false
  try {
    const key = scopedKey(base)
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    return false
  }
  for (const fn of localListeners) fn()
  return true
}

/** Called after any per-space setting changes in this page. */
export function onLocalSettingChange(fn: () => void) {
  localListeners.add(fn)
  return () => void localListeners.delete(fn)
}

/** Register how a loaded store takes in a setting that arrived from another device. */
export function onRemoteSetting(base: string, fn: (raw: string | null) => void) {
  let set = remoteListeners.get(base)
  if (!set) remoteListeners.set(base, (set = new Set()))
  set.add(fn)
  return () => void set.delete(fn)
}

/** Store a setting that came from the server and hand it to the live store, if loaded. */
export function applyRemoteSetting(base: string, raw: string | null) {
  if (frozen) return
  try {
    const key = scopedKey(base)
    if (raw === null) localStorage.removeItem(key)
    else localStorage.setItem(key, raw)
  } catch {
    /* storage full: the next sync tries again */
  }
  for (const fn of remoteListeners.get(base) ?? []) fn(raw)
}

/** Remove every per-space localStorage key of an account space (used after signing out). */
export function clearScopedSettings(space: SpaceId) {
  if (space === LOCAL_SPACE) return
  const prefix = `formastudio:${space}:`
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i)
      if (k?.startsWith(prefix)) localStorage.removeItem(k)
    }
  } catch {
    /* storage blocked */
  }
}

/**
 * Reload when another tab or window signs in or out, so this page never keeps editing in the
 * space it no longer belongs to. `beforeReload` saves anything still pending first.
 */
export function reloadOnSpaceChange(beforeReload: () => Promise<unknown>) {
  window.addEventListener('storage', (e) => {
    if (e.key !== SESSION_KEY && e.key !== null) return
    if (sessionSpace() === currentSpace()) return
    void beforeReload()
      .catch(() => {})
      .then(() => window.location.reload())
  })
}
