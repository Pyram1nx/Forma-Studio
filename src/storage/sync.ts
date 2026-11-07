// Background sync between this device and the signed-in account. Local-first: the editor
// only ever reads and writes the local copy (designStore, per-space settings); this engine
// pushes local changes up and pulls other devices' changes down, whenever it can.
//
// Rules:
// - Each item carries the server rev it is based on. A push with a stale rev is refused (409).
// - Design changed on both sides: nothing is lost. The other device's version is saved as a
//   separate design, "<name> (from another device)", and this device's edits keep the design.
// - Settings changed on both sides: this device wins (it is the one being used right now),
//   except on a device that has never synced the account, where the account wins.
// - One tab syncs at a time (Web Locks), and re-reads storage first, so tabs never race.
import { create } from 'zustand'
import { accountsEnabled, api, ApiError, forgetSession, getSession, refreshSession, selectSession, type Session } from '../account/api'
import { uid } from '../model/ids'
import {
  allDesignRecords,
  applyRemoteDesign,
  clearDesignSpace,
  copyToSpace,
  dropRemoteDeleted,
  flushDesigns,
  getDesignRecord,
  markDesignSynced,
  readSpace,
  rebaseDesign,
  reloadFromBackend,
  saveDesign,
  subscribeDesigns,
  type DesignRecord,
} from './designStore'
import {
  applyRemoteSetting,
  clearScopedSettings,
  currentSpace,
  freezeStorage,
  isAccountSpace,
  LOCAL_SPACE,
  onLocalSettingChange,
  readScoped,
  SYNCED_SETTINGS,
  type SettingKind,
} from './space'

export type SyncStatus = 'off' | 'idle' | 'syncing' | 'offline' | 'signin' | 'error'

interface SyncState {
  status: SyncStatus
  /** Changes made here that have not reached the account yet. */
  pending: number
  lastSyncedAt: string | null
  error: string | null
}

export const useSync = create<SyncState>()(() => ({ status: 'off', pending: 0, lastSyncedAt: null, error: null }))

interface RemoteMeta {
  kind: 'design' | 'setting'
  id: string
  name: string
  shapes: number
  updatedAt: string
  deleted: boolean
  rev: number
}

interface Meta {
  /** Highest server rev pulled. */
  cursor: number
  settings: Partial<Record<SettingKind, { rev: number; hash: string }>>
  lastSyncedAt?: string
}

const META_BASE = 'formastudio:sync'

function loadMeta(): Meta {
  try {
    const m = JSON.parse(readScoped(META_BASE) ?? 'null') as Meta | null
    if (m && typeof m.cursor === 'number') return { cursor: m.cursor, settings: m.settings ?? {}, lastSyncedAt: m.lastSyncedAt }
  } catch {
    /* start over */
  }
  return { cursor: 0, settings: {} }
}

function saveMeta(m: Meta) {
  try {
    localStorage.setItem(`formastudio:${currentSpace()}:${META_BASE}`, JSON.stringify(m))
  } catch {
    /* next sync re-pulls */
  }
}

/** Cheap content fingerprint (FNV-1a), to tell whether a setting changed since it was synced. */
export function fingerprint(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36) + ':' + s.length
}

const dirtyCount = () => {
  let n = allDesignRecords().filter((r) => r.dirty).length
  const meta = loadMeta()
  for (const kind of Object.keys(SYNCED_SETTINGS) as SettingKind[]) {
    const raw = readScoped(SYNCED_SETTINGS[kind])
    if (raw !== null && meta.settings[kind]?.hash !== fingerprint(raw)) n++
  }
  return n
}

const designBody = (r: DesignRecord) => ({ name: r.name, shapes: r.shapes, updatedAt: r.updatedAt, data: r.data, baseRev: r.rev })

/** A copy of a serialized design under a new id and name. */
function renamedCopy(data: string, id: string, name: string): string {
  try {
    return JSON.stringify({ ...JSON.parse(data), id, name })
  } catch {
    return data
  }
}

async function fetchItem(kind: 'design' | 'setting', id: string) {
  return api<RemoteMeta & { data: string | null }>('GET', `/item?kind=${kind}&id=${encodeURIComponent(id)}`, { auth: true })
}

/**
 * Both sides changed a design. Keep the account's version as a new design and move this
 * device's copy onto the account's rev, so the next push replaces it.
 */
async function keepBoth(local: DesignRecord, remoteRev: number) {
  const remote = await fetchItem('design', local.id)
  if (!remote.deleted && remote.data) {
    const id = uid()
    const name = `${remote.name} (from another device)`
    await saveDesign({ id, name, updatedAt: remote.updatedAt, shapes: remote.shapes, data: renamedCopy(remote.data, id, name) })
  }
  await rebaseDesign(local.id, remote.rev || remoteRev)
}

async function pull(meta: Meta, since: number, seen: Set<string>) {
  let cursor = since
  for (;;) {
    const page = await api<{ items: RemoteMeta[]; cursor: number; more: boolean }>('GET', `/items?since=${cursor}`, { auth: true })
    for (const item of page.items) {
      seen.add(`${item.kind}:${item.id}`)
      if (item.kind === 'design') await pullDesign(item)
      else if (item.kind === 'setting' && item.id in SYNCED_SETTINGS) await pullSetting(meta, item)
    }
    cursor = Math.max(cursor, page.cursor)
    if (!page.more) break
  }
  meta.cursor = Math.max(meta.cursor, cursor)
}

async function pullDesign(item: RemoteMeta) {
  const local = getDesignRecord(item.id)
  if (local && local.rev >= item.rev) return
  if (item.deleted) {
    if (local && !local.dirty) await dropRemoteDeleted(item.id)
    return
  }
  if (local?.dirty) {
    if (local.deleted) {
      // Deleted here, edited elsewhere: the edits win, nothing is lost.
      const remote = await fetchItem('design', item.id)
      if (remote.data) {
        await markDesignSynced(item.id, remote.rev, local.data, true)
        await applyRemoteDesign(remote, remote.data)
      }
      return
    }
    await keepBoth(local, item.rev)
    return
  }
  const remote = await fetchItem('design', item.id)
  if (remote.data) await applyRemoteDesign(remote, remote.data)
}

async function pullSetting(meta: Meta, item: RemoteMeta) {
  const kind = item.id as SettingKind
  const base = SYNCED_SETTINGS[kind]
  const m = meta.settings[kind]
  if (m && item.rev <= m.rev) return
  const raw = readScoped(base)
  const changedHere = raw !== null && !!m && m.hash !== fingerprint(raw)
  if (changedHere) {
    // This device wins; the push below overwrites the account's copy.
    meta.settings[kind] = { rev: item.rev, hash: m.hash }
    return
  }
  const remote = item.deleted ? null : await fetchItem('setting', kind)
  const data = remote?.data ?? null
  applyRemoteSetting(base, data)
  meta.settings[kind] = { rev: remote?.rev ?? item.rev, hash: data === null ? '' : fingerprint(data) }
}

async function pushDesigns() {
  for (const rec of allDesignRecords().filter((r) => r.dirty)) {
    try {
      await pushDesign(rec)
    } catch (e) {
      if (e instanceof ApiError && (e.status === 409 || e.status === 0 || e.status === 401)) throw e
      // Too large, account full: tell the person, keep the rest syncing.
      useSync.setState({ error: `“${rec.name}”: ${(e as Error).message}` })
    }
  }
}

async function pushDesign(rec: DesignRecord, retry = true): Promise<void> {
  try {
    if (rec.deleted) {
      if (rec.rev === 0) {
        await markDesignSynced(rec.id, 0, rec.data, true)
        return
      }
      const out = await api<{ rev: number }>('DELETE', `/item?kind=design&id=${encodeURIComponent(rec.id)}&baseRev=${rec.rev}`, { auth: true })
      await markDesignSynced(rec.id, out.rev, rec.data, true)
      return
    }
    const out = await api<{ rev: number }>('PUT', `/item?kind=design&id=${encodeURIComponent(rec.id)}`, { body: designBody(rec), auth: true })
    await markDesignSynced(rec.id, out.rev, rec.data, false)
  } catch (e) {
    if (!(e instanceof ApiError) || e.status !== 409 || !retry) throw e
    // Someone pushed between our pull and this push.
    if (rec.deleted) {
      const remote = await fetchItem('design', rec.id)
      await markDesignSynced(rec.id, remote.rev, rec.data, true)
      if (remote.data) await applyRemoteDesign(remote, remote.data)
      return
    }
    await keepBoth(rec, Number(e.body.rev) || 0)
    const next = getDesignRecord(rec.id)
    if (next?.dirty) await pushDesign(next, false)
  }
}

async function pushSettings(meta: Meta) {
  for (const kind of Object.keys(SYNCED_SETTINGS) as SettingKind[]) {
    const raw = readScoped(SYNCED_SETTINGS[kind])
    if (raw === null) continue
    const hash = fingerprint(raw)
    const m = meta.settings[kind]
    if (m?.hash === hash) continue
    const body = { name: kind, shapes: 0, updatedAt: new Date().toISOString(), data: raw, baseRev: m?.rev ?? 0 }
    let out: { rev: number }
    try {
      out = await api('PUT', `/item?kind=setting&id=${kind}`, { body, auth: true })
    } catch (e) {
      if (!(e instanceof ApiError) || e.status !== 409) throw e
      out = await api('PUT', `/item?kind=setting&id=${kind}`, { body: { ...body, baseRev: Number(e.body.rev) || 0 }, auth: true })
    }
    meta.settings[kind] = { rev: out.rev, hash }
  }
}

/**
 * First sync of this account on this device: settings the account does not have yet start
 * from this device's no-account settings (a new account keeps the kit and presets set up
 * before signing up). Designs are never copied automatically; see copyLocalDesigns.
 */
function seedSettings(seen: Set<string>) {
  for (const kind of Object.keys(SYNCED_SETTINGS) as SettingKind[]) {
    const base = SYNCED_SETTINGS[kind]
    if (seen.has(`setting:${kind}`) || readScoped(base) !== null) continue
    const fromLocal = readScoped(base, LOCAL_SPACE)
    if (fromLocal !== null) applyRemoteSetting(base, fromLocal)
  }
}

const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  return locks ? (locks.request('forma-sync:' + currentSpace(), fn) as Promise<T>) : fn()
}

let running: Promise<void> | null = null
let stopped = false
let again = false
let firstCycle = true

async function cycle() {
  const session = getSession()
  if (!session) return useSync.setState({ status: 'off' })
  if (session.needsSignIn) return useSync.setState({ status: 'signin', pending: dirtyCount() })
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return useSync.setState({ status: 'offline', pending: dirtyCount() })
  useSync.setState({ status: 'syncing', error: null })
  try {
    await withLock(async () => {
      await reloadFromBackend()
      const meta = loadMeta()
      const neverSynced = meta.cursor === 0
      const seen = new Set<string>()
      // Each page start re-reads the full list (metadata only), which also catches any
      // write that committed out of rev order; later cycles only ask for what is new.
      await pull(meta, firstCycle ? 0 : meta.cursor, seen)
      firstCycle = false
      if (neverSynced) seedSettings(seen)
      await pushDesigns()
      await pushSettings(meta)
      meta.lastSyncedAt = new Date().toISOString()
      saveMeta(meta)
    })
    const s = useSync.getState()
    useSync.setState({ status: s.error ? 'error' : 'idle', lastSyncedAt: new Date().toISOString(), pending: dirtyCount() })
  } catch (e) {
    const status = e instanceof ApiError ? (e.status === 0 ? 'offline' : e.status === 401 ? 'signin' : 'error') : 'error'
    useSync.setState({ status, error: status === 'error' ? (e as Error).message : null, pending: dirtyCount() })
  }
}

/** Run a sync now (or right after the one in progress). Resolves when it has finished. */
export function syncNow(): Promise<void> {
  if (stopped || !isAccountSpace() || !accountsEnabled()) return Promise.resolve()
  if (running) {
    again = true
    return running
  }
  running = (async () => {
    do {
      again = false
      await cycle()
    } while (again && !stopped)
  })().finally(() => {
    running = null
  })
  return running
}

let timer: ReturnType<typeof setTimeout> | undefined
function schedule(ms: number) {
  clearTimeout(timer)
  timer = setTimeout(() => void syncNow(), ms)
}

let started = false

/** Start background sync for the page's account space. No-op without an account. */
export function startSync() {
  if (started || !isAccountSpace() || !accountsEnabled()) return
  started = true
  useSync.setState({ status: 'idle', pending: dirtyCount(), lastSyncedAt: loadMeta().lastSyncedAt ?? null })
  void refreshSession()
    .catch(() => {})
    .finally(() => schedule(0))
  subscribeDesigns(() => {
    useSync.setState({ pending: dirtyCount() })
    schedule(2000)
  })
  onLocalSettingChange(() => schedule(2000))
  window.addEventListener('online', () => schedule(0))
  window.addEventListener('focus', () => schedule(500))
  document.addEventListener('visibilitychange', () => {
    // Leaving the page: push what is pending while the page can still run.
    if (document.visibilityState === 'hidden' && dirtyCount()) void syncNow()
  })
  setInterval(() => {
    if (document.visibilityState === 'visible') void syncNow()
  }, 60_000)
}

// ---------- switching accounts ----------

const CLEAR_KEY = 'formastudio:clear-spaces'

function markForClearing(space: string) {
  try {
    const list = JSON.parse(localStorage.getItem(CLEAR_KEY) ?? '[]') as string[]
    localStorage.setItem(CLEAR_KEY, JSON.stringify([...new Set([...list, space])]))
  } catch {
    /* the in-page clear still runs */
  }
}

/** On start-up: remove what is left of accounts signed out of on this device. */
export async function finishPendingClears() {
  let list: string[] = []
  try {
    list = JSON.parse(localStorage.getItem(CLEAR_KEY) ?? '[]')
  } catch {
    /* ignore */
  }
  if (!Array.isArray(list) || !list.length) return
  const rest: string[] = []
  for (const space of list) {
    // Signed back in to that account before the clear ran: keep it.
    if (space === currentSpace() || space === LOCAL_SPACE) continue
    try {
      await clearDesignSpace(space)
      clearScopedSettings(space)
    } catch {
      rest.push(space)
    }
  }
  try {
    if (rest.length) localStorage.setItem(CLEAR_KEY, JSON.stringify(rest))
    else localStorage.removeItem(CLEAR_KEY)
  } catch {
    /* ignore */
  }
}

/** Let the sync in progress finish, start no more, and stop all writes to this space. */
async function stopEverything() {
  stopped = true
  clearTimeout(timer)
  if (running) await running
  await flushDesigns()
  freezeStorage()
}

/** Select an account on this device and reload into its space. */
export async function enterAccount(session: Session) {
  await stopEverything()
  selectSession(session)
  window.location.reload()
}

/**
 * Sign out. When everything has reached the account, its copy on this device is removed
 * (it is in the account, and this may be a shared computer). With `keepUnsynced`, changes
 * that have not synced stay on this device and sync the next time this account signs in.
 */
export async function leaveAccount({ keepUnsynced }: { keepUnsynced: boolean }) {
  const space = currentSpace()
  const keep = keepUnsynced && dirtyCount() > 0
  await stopEverything()
  if (!keep && space !== LOCAL_SPACE) {
    // Also finished by the next page load (finishPendingClears), in case anything still
    // writes to this space while the page unloads, or the browser closes first.
    markForClearing(space)
    await clearDesignSpace(space)
    clearScopedSettings(space)
  }
  forgetSession()
  window.location.reload()
}

/** How many no-account designs on this device are not in the signed-in account yet. */
export async function countLocalDesignsToCopy(): Promise<number> {
  if (!isAccountSpace()) return 0
  return (await readSpace(LOCAL_SPACE)).filter((r) => !getDesignRecord(r.id)).length
}

/**
 * Copy this device's no-account designs into the signed-in account. The originals stay
 * where they are and show again after signing out. Designs already copied are skipped.
 */
export async function copyLocalDesigns(): Promise<number> {
  if (!isAccountSpace()) return 0
  let n = 0
  for (const r of await readSpace(LOCAL_SPACE)) {
    if (getDesignRecord(r.id)) continue
    await saveDesign({ id: r.id, name: r.name, updatedAt: r.updatedAt, shapes: r.shapes, data: r.data })
    n++
  }
  void syncNow()
  return n
}

/** Before deleting an account: keep its designs on this device as no-account designs. */
export async function keepAccountDesignsOnDevice() {
  if (!isAccountSpace()) return
  await copyToSpace(LOCAL_SPACE, allDesignRecords(), uid)
}
