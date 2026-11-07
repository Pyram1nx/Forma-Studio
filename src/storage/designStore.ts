// Designs saved in this browser, per storage space (see space.ts). Kept in IndexedDB, which
// survives closing the tab and the browser and has far more room than localStorage; falls
// back to localStorage where IndexedDB is unavailable. The current space's designs are held
// in memory as well, so the editor can read them synchronously.
//
// Several tabs (or the desktop app's home and studio windows) share the database. Every write
// is a read-modify-write in one transaction, and each committed write is announced through a
// localStorage key so the other pages refresh that design.
import { currentSpace, LOCAL_SPACE, storageFrozen, type SpaceId } from './space'

export interface DesignRecord {
  space: SpaceId
  id: string
  name: string
  updatedAt: string
  shapes: number
  /** The serialized design (projectFile.serialize). Empty for a tombstone. */
  data: string
  /** Server revision this copy is based on; 0 = never synced. Only used in account spaces. */
  rev: number
  /** Changed here since it was last synced. */
  dirty: boolean
  /** Deleted here, waiting for the delete to reach the account. */
  deleted?: boolean
}

export interface DesignSummary {
  id: string
  name: string
  updatedAt: string
  shapes: number
}

type Updater = (cur: DesignRecord | undefined) => DesignRecord | null | undefined

/** Where records live. `update` must be atomic across tabs. undefined = leave as is, null = delete. */
export interface DesignBackend {
  kind: 'indexeddb' | 'localstorage' | 'memory'
  all(space: SpaceId): Promise<DesignRecord[]>
  get(space: SpaceId, id: string): Promise<DesignRecord | undefined>
  update(space: SpaceId, id: string, fn: Updater): Promise<DesignRecord | null | undefined>
  clear(space: SpaceId): Promise<void>
}

// ---------- backends ----------

const DB_NAME = 'forma-studio'
const STORE = 'designs'

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

export async function openIndexedDbBackend(): Promise<DesignBackend> {
  if (typeof indexedDB === 'undefined') throw new Error('No IndexedDB')
  const open = indexedDB.open(DB_NAME, 1)
  open.onupgradeneeded = () => {
    const store = open.result.createObjectStore(STORE, { keyPath: ['space', 'id'] })
    store.createIndex('space', 'space')
  }
  const db = await Promise.race([
    req(open),
    // Some private modes leave the open request hanging forever.
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('IndexedDB did not open')), 4000)),
  ])
  // Another tab upgrading the schema later: let it, and reconnect on next load.
  db.onversionchange = () => db.close()

  const tx = (mode: IDBTransactionMode) => db.transaction(STORE, mode).objectStore(STORE)
  const done = (t: IDBTransaction) =>
    new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve()
      t.onerror = () => reject(t.error)
      t.onabort = () => reject(t.error ?? new Error('Transaction aborted'))
    })

  return {
    kind: 'indexeddb',
    all: (space) => req(tx('readonly').index('space').getAll(space)) as Promise<DesignRecord[]>,
    get: (space, id) => req(tx('readonly').get([space, id])) as Promise<DesignRecord | undefined>,
    async update(space, id, fn) {
      const t = db.transaction(STORE, 'readwrite')
      const store = t.objectStore(STORE)
      const finished = done(t)
      const cur = (await req(store.get([space, id]))) as DesignRecord | undefined
      const next = fn(cur)
      if (next === null) store.delete([space, id])
      else if (next) store.put(next)
      await finished
      return next === undefined ? cur : next
    },
    async clear(space) {
      const t = db.transaction(STORE, 'readwrite')
      const finished = done(t)
      const store = t.objectStore(STORE)
      const keys = await req(store.index('space').getAllKeys(space))
      for (const k of keys) store.delete(k)
      await finished
    },
  }
}

/** Fallback: one localStorage key per record. Synchronous underneath, so updates are atomic. */
export function localStorageBackend(storage: Storage = localStorage): DesignBackend {
  const prefix = (space: SpaceId) => `formastudio:design:${space}:`
  const read = (key: string) => {
    try {
      return JSON.parse(storage.getItem(key) ?? 'null') as DesignRecord | null
    } catch {
      return null
    }
  }
  return {
    kind: 'localstorage',
    async all(space) {
      const out: DesignRecord[] = []
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i)
        const r = k?.startsWith(prefix(space)) ? read(k) : null
        if (r) out.push(r)
      }
      return out
    },
    get: async (space, id) => read(prefix(space) + id) ?? undefined,
    async update(space, id, fn) {
      const key = prefix(space) + id
      const cur = read(key) ?? undefined
      const next = fn(cur)
      if (next === null) storage.removeItem(key)
      else if (next) storage.setItem(key, JSON.stringify(next))
      return next === undefined ? cur : next
    },
    async clear(space) {
      for (let i = storage.length - 1; i >= 0; i--) {
        const k = storage.key(i)
        if (k?.startsWith(prefix(space))) storage.removeItem(k)
      }
    },
  }
}

export function memoryBackend(): DesignBackend {
  const map = new Map<string, DesignRecord>()
  const k = (s: SpaceId, id: string) => s + '\u0000' + id
  return {
    kind: 'memory',
    all: async (space) => [...map.values()].filter((r) => r.space === space).map((r) => ({ ...r })),
    get: async (space, id) => {
      const r = map.get(k(space, id))
      return r && { ...r }
    },
    async update(space, id, fn) {
      const cur = map.get(k(space, id))
      const next = fn(cur && { ...cur })
      if (next === null) map.delete(k(space, id))
      else if (next) map.set(k(space, id), { ...next })
      return next === undefined ? cur : next
    },
    async clear(space) {
      for (const [key, r] of map) if (r.space === space) map.delete(key)
    },
  }
}

// ---------- the store ----------

/** Announces committed writes to other tabs: { space, id }. */
const CHANGE_KEY = 'formastudio:design-changed'
/** Writes still in flight when the page was closed, saved synchronously; replayed on next start. */
const JOURNAL_KEY = 'formastudio:design-journal'
/** Autosaves from before IndexedDB (the local space). */
const LEGACY_RECENT = 'formastudio:recent'
const LEGACY_DOC = (id: string) => 'formastudio:doc:' + id

let backend: DesignBackend = memoryBackend()
let space: SpaceId = LOCAL_SPACE
const mem = new Map<string, DesignRecord>()
/** Records written to memory whose backend write has not committed yet. */
const pending = new Map<string, DesignRecord>()
let chain: Promise<unknown> = Promise.resolve()
const listeners = new Set<() => void>()
const remoteListeners = new Set<(id: string) => void>()
let onWriteError: (err: unknown) => void = (err) => console.warn('Saving a design failed', err)
let firstSaveHook: (() => void) | null = null

const notify = () => {
  for (const fn of listeners) fn()
}

function announce(id: string) {
  try {
    localStorage.setItem(CHANGE_KEY, JSON.stringify({ space, id, t: Date.now(), r: Math.random() }))
  } catch {
    /* other tabs refresh on focus instead */
  }
}

/** Queue a backend update; the memory copy is already current. */
function write(id: string, fn: Updater, optimistic: DesignRecord | null) {
  if (storageFrozen()) return Promise.resolve(undefined)
  if (optimistic) pending.set(id, optimistic)
  else pending.delete(id)
  const p = chain.then(async () => {
    const result = await backend.update(space, id, fn)
    if (pending.get(id) === optimistic) pending.delete(id)
    // Adopt what was committed (it may carry a rev another tab's sync set meanwhile).
    if (result && !pending.has(id) && mem.has(id)) mem.set(id, result)
    announce(id)
    return result
  })
  chain = p.catch((err) => onWriteError(err))
  return p
}

/**
 * Write in-flight saves to localStorage right now (synchronously), so a page that starts
 * next (the studio, opened from the home window) sees them even before IndexedDB commits.
 */
export function persistPendingNow() {
  journalPending()
}

function journalPending() {
  if (!pending.size || storageFrozen()) return
  try {
    const all = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]') as DesignRecord[]
    localStorage.setItem(JOURNAL_KEY, JSON.stringify([...all.filter((r) => !pending.has(r.id) || r.space !== space), ...pending.values()]))
  } catch {
    /* storage full: the last debounce window may be lost */
  }
}

async function replayJournal() {
  let entries: DesignRecord[] = []
  try {
    entries = JSON.parse(localStorage.getItem(JOURNAL_KEY) ?? '[]')
  } catch {
    /* corrupt journal: drop it */
  }
  for (const r of Array.isArray(entries) ? entries : []) {
    if (!r?.space || !r.id) continue
    await backend.update(r.space, r.id, (cur) => ({ ...r, rev: cur?.rev ?? r.rev }))
  }
  try {
    localStorage.removeItem(JOURNAL_KEY)
  } catch {
    /* ignore */
  }
}

/** Move autosaves from the old localStorage layout into the local space. */
async function migrateLegacy() {
  let recent: { id: string }[] = []
  try {
    const v = JSON.parse(localStorage.getItem(LEGACY_RECENT) ?? '[]')
    if (Array.isArray(v)) recent = v
  } catch {
    return
  }
  if (!recent.length) return
  for (const r of recent) {
    const raw = typeof r?.id === 'string' ? localStorage.getItem(LEGACY_DOC(r.id)) : null
    if (!raw) continue
    let doc: { name?: unknown; updatedAt?: unknown; shapes?: unknown }
    try {
      doc = JSON.parse(raw)
    } catch {
      continue
    }
    await backend.update(LOCAL_SPACE, r.id, (cur) =>
      cur
        ? undefined
        : {
            space: LOCAL_SPACE,
            id: r.id,
            name: typeof doc.name === 'string' ? doc.name : 'Untitled',
            updatedAt: typeof doc.updatedAt === 'string' ? doc.updatedAt : new Date().toISOString(),
            shapes: Array.isArray(doc.shapes) ? doc.shapes.length : 0,
            data: raw,
            rev: 0,
            dirty: true,
          },
    )
  }
  // Only once every design is safely in the new store.
  for (const r of recent) localStorage.removeItem(LEGACY_DOC(r.id))
  localStorage.removeItem(LEGACY_RECENT)
}

let initialized: Promise<void> | null = null

/**
 * Open storage and load the current space. Call once before rendering (main.tsx).
 * Tests pass a memory backend and a space.
 */
export function initDesignStore(opts: { backend?: DesignBackend; space?: SpaceId } = {}): Promise<void> {
  if (initialized && !opts.backend) return initialized
  initialized = (async () => {
    space = opts.space ?? currentSpace()
    if (opts.backend) backend = opts.backend
    else {
      try {
        backend = await openIndexedDbBackend()
      } catch (err) {
        console.warn('IndexedDB unavailable, saving designs in localStorage', err)
        backend = localStorageBackend()
      }
    }
    mem.clear()
    pending.clear()
    if (typeof localStorage !== 'undefined') {
      try {
        await replayJournal()
        await migrateLegacy()
      } catch (err) {
        console.warn('Could not finish moving saved designs', err)
      }
    }
    for (const r of await backend.all(space)) mem.set(r.id, r)
    if (typeof window !== 'undefined' && !opts.backend) installWindowHooks()
  })()
  return initialized
}

function installWindowHooks() {
  window.addEventListener('pagehide', journalPending)
  window.addEventListener('beforeunload', journalPending)
  window.addEventListener('storage', (e) => {
    if (e.key !== CHANGE_KEY || !e.newValue) return
    try {
      const { space: s, id } = JSON.parse(e.newValue) as { space: string; id: string }
      if (s === space) void refreshOne(id)
    } catch {
      /* ignore */
    }
  })
  // Covers browsers that drop storage events for background tabs.
  window.addEventListener('focus', () => void reloadFromBackend())
}

/** Re-read one design another page wrote. */
async function refreshOne(id: string) {
  if (pending.has(id)) return
  const r = await backend.get(space, id)
  if (pending.has(id)) return
  const before = mem.get(id)
  if (r) mem.set(id, r)
  else mem.delete(id)
  if (r && !r.dirty && !r.deleted && before && before.data !== r.data) for (const fn of remoteListeners) fn(id)
  notify()
}

/** Re-read the whole space (other pages may have written while this one was hidden). */
export async function reloadFromBackend() {
  await flushDesigns()
  const all = await backend.all(space)
  const seen = new Set<string>()
  let changed = false
  for (const r of all) {
    seen.add(r.id)
    if (pending.has(r.id)) continue
    const before = mem.get(r.id)
    if (!before || before.data !== r.data || before.rev !== r.rev || before.dirty !== r.dirty || !!before.deleted !== !!r.deleted) {
      mem.set(r.id, r)
      changed = true
      if (before && !r.dirty && !r.deleted && before.data !== r.data) for (const fn of remoteListeners) fn(r.id)
    }
  }
  for (const id of [...mem.keys()]) {
    if (!seen.has(id) && !pending.has(id)) {
      mem.delete(id)
      changed = true
    }
  }
  if (changed) notify()
}

/** Wait until every queued write has reached storage. */
export async function flushDesigns() {
  let last: Promise<unknown> | null = null
  while (last !== chain) {
    last = chain
    await chain
  }
}

export const storageBackendKind = () => backend.kind
export const designSpace = () => space

export function setDesignWriteErrorHandler(fn: (err: unknown) => void) {
  onWriteError = fn
}

/** Run once after the first design is saved in this page (asks for persistent storage). */
export function onFirstDesignSave(fn: () => void) {
  firstSaveHook = fn
}

export function subscribeDesigns(fn: () => void) {
  listeners.add(fn)
  return () => void listeners.delete(fn)
}

/** A design changed because of another device (pulled by sync), not because of this page. */
export function onRemoteDesignChange(fn: (id: string) => void) {
  remoteListeners.add(fn)
  return () => void remoteListeners.delete(fn)
}

/** Designs in this space, newest first. */
export function listDesigns(): DesignSummary[] {
  return [...mem.values()]
    .filter((r) => !r.deleted)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
    .map(({ id, name, updatedAt, shapes }) => ({ id, name, updatedAt, shapes }))
}

export function getDesignData(id: string): string | null {
  const r = mem.get(id)
  return r && !r.deleted ? r.data : null
}

export const getDesignRecord = (id: string) => mem.get(id)

/** Every record in this space, tombstones included (for sync). */
export const allDesignRecords = () => [...mem.values()]

/** Save a design. Synchronous for the caller; the disk write follows. */
export function saveDesign(d: { id: string; name: string; updatedAt: string; shapes: number; data: string }): Promise<unknown> {
  const before = mem.get(d.id)
  if (before && !before.deleted && before.data === d.data && before.name === d.name) return Promise.resolve()
  const rec: DesignRecord = { space, ...d, rev: before?.rev ?? 0, dirty: true }
  mem.set(d.id, rec)
  notify()
  if (firstSaveHook) {
    const fn = firstSaveHook
    firstSaveHook = null
    fn()
  }
  // Keep whatever rev the stored copy has: another tab's sync may have moved it on.
  return write(d.id, (cur) => ({ ...rec, rev: cur?.rev ?? rec.rev }), rec)
}

/** Delete a design. In an account space it becomes a tombstone until the delete is synced. */
export function deleteDesign(id: string): Promise<unknown> {
  const before = mem.get(id)
  if (!before) return Promise.resolve()
  if (space === LOCAL_SPACE || before.rev === 0) {
    mem.delete(id)
    notify()
    return write(id, (cur) => (cur && cur.rev > 0 && space !== LOCAL_SPACE ? { ...cur, data: '', deleted: true, dirty: true } : null), null)
  }
  const rec: DesignRecord = { ...before, data: '', deleted: true, dirty: true }
  mem.set(id, rec)
  notify()
  return write(id, (cur) => ({ ...rec, rev: cur?.rev ?? rec.rev }), rec)
}

// ---------- used by sync ----------

/**
 * A push succeeded: record the new rev, and clear `dirty` only if nothing changed since the
 * push started (compared on the stored copy, so edits from another tab count too).
 */
export function markDesignSynced(id: string, rev: number, pushedData: string, pushedDeleted: boolean) {
  const apply: Updater = (cur) => {
    if (!cur) return undefined
    const same = cur.data === pushedData && !!cur.deleted === pushedDeleted
    if (same && pushedDeleted) return null
    return { ...cur, rev, dirty: same ? false : cur.dirty }
  }
  const m = mem.get(id)
  const next = m ? apply({ ...m }) : undefined
  if (next === null) mem.delete(id)
  else if (next) mem.set(id, next)
  notify()
  return write(id, apply, next ?? null)
}

/** Move a changed design onto a newer server rev (after keeping the other version), still dirty. */
export function rebaseDesign(id: string, rev: number) {
  const apply: Updater = (cur) => (cur ? { ...cur, rev } : undefined)
  const m = mem.get(id)
  const next = m ? apply({ ...m }) : undefined
  if (next) mem.set(id, next)
  return write(id, apply, next ?? null)
}

/** Store a design that came from the account (another device changed it). */
export function applyRemoteDesign(meta: { id: string; name: string; updatedAt: string; shapes: number; rev: number }, data: string) {
  const rec: DesignRecord = { space, id: meta.id, name: meta.name, updatedAt: meta.updatedAt, shapes: meta.shapes, data, rev: meta.rev, dirty: false }
  const before = mem.get(meta.id)
  // Never overwrite edits made here that sync has not pushed yet.
  if (before?.dirty) return Promise.resolve()
  mem.set(meta.id, rec)
  notify()
  if (before && before.data !== data) for (const fn of remoteListeners) fn(meta.id)
  return write(meta.id, (cur) => (cur?.dirty ? undefined : rec), rec)
}

/** The account deleted a design that is unchanged here: drop it. */
export function dropRemoteDeleted(id: string) {
  const before = mem.get(id)
  if (!before || before.dirty) return Promise.resolve()
  mem.delete(id)
  notify()
  return write(id, (cur) => (cur?.dirty ? undefined : null), null)
}

/** Remove a whole space from this device (after signing out of an account). */
export async function clearDesignSpace(s: SpaceId) {
  await flushDesigns()
  await backend.clear(s)
}

/** Designs of another space, read straight from storage (to copy them into an account). */
export async function readSpace(s: SpaceId): Promise<DesignRecord[]> {
  await flushDesigns()
  return (await backend.all(s)).filter((r) => !r.deleted)
}

/**
 * Copy designs into another space on this device (keeping an account's designs as
 * no-account designs). A design that is already there under the same id, with different
 * content, is added as a separate copy instead of replacing it.
 */
export async function copyToSpace(target: SpaceId, recs: DesignRecord[], copyId: () => string) {
  await flushDesigns()
  for (const r of recs) {
    if (r.deleted) continue
    const existing = await backend.get(target, r.id)
    if (existing && existing.data === r.data) continue
    const id = existing ? copyId() : r.id
    let data = r.data
    let name = r.name
    if (existing) {
      name = `${r.name} (from account)`
      try {
        data = JSON.stringify({ ...JSON.parse(r.data), id, name })
      } catch {
        continue
      }
    }
    await backend.update(target, id, () => ({ ...r, space: target, id, name, data, rev: 0, dirty: true, deleted: false }))
  }
}

/** Test helper: forget all state. */
export function _resetDesignStoreForTests() {
  mem.clear()
  pending.clear()
  listeners.clear()
  remoteListeners.clear()
  chain = Promise.resolve()
  initialized = null
}
