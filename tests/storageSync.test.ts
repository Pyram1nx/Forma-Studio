// End-to-end: two simulated devices (each its own localStorage, design storage and module
// state) sync through the real API handler backed by the in-memory database.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHandler } from '../server/app.js'
import { createMemoryDb } from '../server/db.js'

class MemStorage implements Storage {
  private m = new Map<string, string>()
  get length() {
    return this.m.size
  }
  clear() {
    this.m.clear()
  }
  getItem(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null
  }
  removeItem(k: string) {
    this.m.delete(k)
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v))
  }
}

type Mods = {
  api: typeof import('../src/account/api')
  store: typeof import('../src/storage/designStore')
  sync: typeof import('../src/storage/sync')
  space: typeof import('../src/storage/space')
}

interface Device {
  storage: MemStorage
  mods: Mods
  backend: unknown
}

let handle: (r: Request) => Promise<Response>

function onDevice(d: Device) {
  Object.defineProperty(globalThis, 'localStorage', { value: d.storage, configurable: true, writable: true })
}

/** A fresh "browser": own storage, own copy of every module, optionally signed in. */
async function device(session?: unknown, seed: Record<string, string> = {}, shared?: { storage: MemStorage; backend: unknown }): Promise<Device> {
  const storage = shared?.storage ?? new MemStorage()
  for (const [k, v] of Object.entries(seed)) storage.setItem(k, v)
  if (session) storage.setItem('formastudio:session', JSON.stringify(session))
  const d = { storage } as Device
  onDevice(d)
  vi.resetModules()
  const api = await import('../src/account/api')
  const store = await import('../src/storage/designStore')
  const sync = await import('../src/storage/sync')
  const space = await import('../src/storage/space')
  const backend = (shared?.backend as ReturnType<typeof store.memoryBackend>) ?? store.memoryBackend()
  await store.initDesignStore({ backend, space: space.currentSpace() })
  d.mods = { api, store, sync, space }
  d.backend = backend
  return d
}

const docData = (id: string, name: string, shapes = 1) => JSON.stringify({ app: 'FormaStudio', version: 1, id, name, shapes: Array(shapes).fill({}), updatedAt: new Date().toISOString() })

async function save(d: Device, id: string, name: string, shapes = 1) {
  onDevice(d)
  await d.mods.store.saveDesign({ id, name, updatedAt: new Date().toISOString(), shapes, data: docData(id, name, shapes) })
}

async function sync(d: Device) {
  onDevice(d)
  await d.mods.sync.syncNow()
  await d.mods.store.flushDesigns()
  return d.mods.sync.useSync.getState()
}

const names = (d: Device) => {
  onDevice(d)
  return d.mods.store
    .listDesigns()
    .map((x) => x.name)
    .sort()
}

async function newAccount(email = 'maker@example.com') {
  const res = await handle(new Request('https://forma.test/api/auth/signup', { method: 'POST', body: JSON.stringify({ email, password: 'long enough' }) }))
  return res.json()
}

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', '/api')
  handle = createHandler({ db: createMemoryDb(), env: { SESSION_SECRET: 'x'.repeat(40) } })
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => handle(new Request('https://forma.test' + url, init)))
})

describe('spaces', () => {
  it('keeps no-account designs apart from account designs, and copies them on request', async () => {
    const guest = await device()
    expect(guest.mods.space.currentSpace()).toBe('local')
    await save(guest, 'g1', 'Guest box')

    // Same browser, now signed in: a new page load in the account's space.
    const session = await newAccount()
    guest.storage.setItem('formastudio:session', JSON.stringify(session))
    const acct = await device(undefined, {}, { storage: guest.storage, backend: guest.backend })
    expect(acct.mods.space.currentSpace()).toBe('u:' + session.id)
    expect(acct.mods.space.scopedKey('forma.prefs.v1')).toBe(`formastudio:u:${session.id}:forma.prefs.v1`)
    expect(names(acct)).toEqual([])
    onDevice(acct)
    expect(await acct.mods.sync.countLocalDesignsToCopy()).toBe(1)
    await acct.mods.sync.copyLocalDesigns()
    expect(names(acct)).toEqual(['Guest box'])
    expect(await acct.mods.sync.countLocalDesignsToCopy()).toBe(0)
    await sync(acct)

    // Signed out again: the guest design is still there, untouched.
    guest.storage.removeItem('formastudio:session')
    const back = await device(undefined, {}, { storage: guest.storage, backend: guest.backend })
    expect(back.mods.space.currentSpace()).toBe('local')
    expect(names(back)).toEqual(['Guest box'])
  })
})

describe('sync between devices', () => {
  it('brings designs and settings to a second device', async () => {
    const session = await newAccount()
    const a = await device(session)
    await save(a, 'd1', 'Shelf')
    await save(a, 'd2', 'Drawer')
    onDevice(a)
    a.mods.space.writeScoped('forma.prefs.v1', JSON.stringify({ cutType: 'inside', bitDia: 6.35 }))
    expect((await sync(a)).pending).toBe(0)

    const b = await device(session)
    await sync(b)
    expect(names(b)).toEqual(['Drawer', 'Shelf'])
    onDevice(b)
    expect(JSON.parse(b.mods.space.readScoped('forma.prefs.v1')!).cutType).toBe('inside')
    expect(b.mods.store.getDesignRecord('d1')).toMatchObject({ dirty: false })
  })

  it('keeps both versions when a design changed on two devices', async () => {
    const session = await newAccount()
    const a = await device(session)
    await save(a, 'd1', 'Shelf')
    await sync(a)
    const b = await device(session)
    await sync(b)

    await save(a, 'd1', 'Shelf', 2)
    await save(b, 'd1', 'Shelf', 3)
    await sync(a)
    await sync(b)
    // B keeps its edit on the design and has A's version as a copy.
    expect(names(b)).toEqual(['Shelf', 'Shelf (from another device)'])
    onDevice(b)
    const own = b.mods.store.listDesigns().find((x) => x.name === 'Shelf')!
    expect(own.shapes).toBe(3)
    const copy = b.mods.store.listDesigns().find((x) => x.name !== 'Shelf')!
    expect(JSON.parse(b.mods.store.getDesignData(copy.id)!).id).toBe(copy.id)

    await sync(a)
    expect(names(a)).toEqual(['Shelf', 'Shelf (from another device)'])
    onDevice(a)
    expect(a.mods.store.listDesigns().find((x) => x.name === 'Shelf')!.shapes).toBe(3)
  })

  it('syncs deletes', async () => {
    const session = await newAccount()
    const a = await device(session)
    await save(a, 'd1', 'Shelf')
    await save(a, 'd2', 'Drawer')
    await sync(a)
    const b = await device(session)
    await sync(b)
    onDevice(a)
    await a.mods.store.deleteDesign('d1')
    await sync(a)
    await sync(b)
    expect(names(b)).toEqual(['Drawer'])
  })

  it('starts a new account with the settings made before signing up', async () => {
    const session = await newAccount()
    const a = await device(session, { 'forma.bitLibrary.v1': '{"owned":{"bit-1":{"qty":2,"notes":"","addedAt":""}},"custom":[]}', 'formastudio:units': 'mm' })
    await sync(a)
    onDevice(a)
    expect(a.mods.space.readScoped('formastudio:units')).toBe('mm')
    // ...and they reach the account.
    const b = await device(session)
    await sync(b)
    onDevice(b)
    expect(b.mods.space.readScoped('formastudio:units')).toBe('mm')
    expect(JSON.parse(b.mods.space.readScoped('forma.bitLibrary.v1')!).owned['bit-1'].qty).toBe(2)
  })

  it('does not let one account see another', async () => {
    const one = await newAccount('one@example.com')
    const two = await newAccount('two@example.com')
    const a = await device(one)
    await save(a, 'd1', 'Private')
    await sync(a)
    const b = await device(two)
    await sync(b)
    expect(names(b)).toEqual([])
  })

  it('waits for a new sign-in when the session is rejected, keeping local work', async () => {
    const session = await newAccount()
    const a = await device({ ...session, token: 'forged.token' })
    await save(a, 'd1', 'Shelf')
    const state = await sync(a)
    expect(state.status).toBe('signin')
    expect(state.pending).toBe(1)
    onDevice(a)
    expect(a.mods.api.getSession()?.needsSignIn).toBe(true)
    expect(names(a)).toEqual(['Shelf'])
  })
})
