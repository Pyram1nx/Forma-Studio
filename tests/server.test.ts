import { beforeEach, describe, expect, it } from 'vitest'
import { createHandler } from '../server/app.js'
import { createMemoryDb } from '../server/db.js'

const env = { SESSION_SECRET: 'test-secret-test-secret-test-secret', ALLOWED_ORIGINS: 'tauri://localhost' }
let handle: (r: Request) => Promise<Response>

const call = async (method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) => {
  const res = await handle(
    new Request('https://forma.test/api' + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  )
  return { status: res.status, body: res.status === 204 ? null : await res.json(), headers: res.headers }
}

const signup = async (email = 'a@example.com') => (await call('POST', '/auth/signup', { email, password: 'correct horse' })).body

beforeEach(() => {
  handle = createHandler({ db: createMemoryDb(), env })
})

describe('accounts', () => {
  it('signs up, signs in and reads the session', async () => {
    const s = await signup()
    expect(s.id).toMatch(/[0-9a-f-]{36}/)
    expect(s.token).toBeTruthy()
    expect((await call('POST', '/auth/signup', { email: 'A@example.com', password: 'correct horse' })).status).toBe(409)
    expect((await call('POST', '/auth/login', { email: 'a@example.com', password: 'wrong pass' })).status).toBe(401)
    const login = await call('POST', '/auth/login', { email: ' A@Example.com ', password: 'correct horse' })
    expect(login.status).toBe(200)
    expect(login.body.id).toBe(s.id)
    const me = await call('GET', '/auth/me', undefined, login.body.token)
    expect(me.body.email).toBe('a@example.com')
  })

  it('rejects bad and forged tokens', async () => {
    const s = await signup()
    expect((await call('GET', '/auth/me')).status).toBe(401)
    const [payload, sig] = s.token.split('.')
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, 'base64url').toString()), sub: 'someone-else' })).toString('base64url')
    expect((await call('GET', '/auth/me', undefined, `${forged}.${sig}`)).status).toBe(401)
  })

  it('rate-limits password guessing', async () => {
    await signup()
    let last = 0
    for (let i = 0; i < 12; i++) last = (await call('POST', '/auth/login', { email: 'a@example.com', password: 'wrong pass' })).status
    expect(last).toBe(429)
  })

  it('deletes the account with its data, only with the password', async () => {
    const s = await signup()
    await call('PUT', '/item?kind=design&id=d1', { name: 'A', shapes: 1, updatedAt: new Date().toISOString(), data: '{}', baseRev: 0 }, s.token)
    expect((await call('DELETE', '/account', { password: 'nope nope' }, s.token)).status).toBe(401)
    expect((await call('DELETE', '/account', { password: 'correct horse' }, s.token)).status).toBe(200)
    expect((await call('GET', '/items', undefined, s.token)).status).toBe(401)
  })

  it('says accounts are off when the server has no database', async () => {
    const off = createHandler({ env: {} })
    const res = await off(new Request('https://forma.test/api/auth/me'))
    expect(res.status).toBe(503)
  })
})

describe('sync', () => {
  const put = (token: string, id: string, data: string, baseRev: number, kind = 'design') =>
    call('PUT', `/item?kind=${kind}&id=${id}`, { name: 'Box ' + id, shapes: 3, updatedAt: '2026-01-01T00:00:00.000Z', data, baseRev }, token)

  it('stores items and lists changes since a revision', async () => {
    const { token } = await signup()
    const a = await put(token, 'a', '{"v":1}', 0)
    const b = await put(token, 'b', '{"v":1}', 0)
    expect(b.body.rev).toBeGreaterThan(a.body.rev)
    const all = await call('GET', '/items?since=0', undefined, token)
    expect(all.body.items.map((i: { id: string }) => i.id)).toEqual(['a', 'b'])
    expect(all.body.items[0].data).toBeUndefined()
    const later = await call('GET', `/items?since=${a.body.rev}`, undefined, token)
    expect(later.body.items.map((i: { id: string }) => i.id)).toEqual(['b'])
    const one = await call('GET', '/item?kind=design&id=a', undefined, token)
    expect(one.body).toMatchObject({ id: 'a', name: 'Box a', shapes: 3, data: '{"v":1}' })
  })

  it('refuses stale writes and deletes (optimistic concurrency)', async () => {
    const { token } = await signup()
    const first = await put(token, 'a', '{"v":1}', 0)
    const second = await put(token, 'a', '{"v":2}', first.body.rev)
    expect(second.status).toBe(200)
    const stale = await put(token, 'a', '{"v":3}', first.body.rev)
    expect(stale.status).toBe(409)
    expect(stale.body.rev).toBe(second.body.rev)
    expect((await call('DELETE', `/item?kind=design&id=a&baseRev=${first.body.rev}`, undefined, token)).status).toBe(409)
    const del = await call('DELETE', `/item?kind=design&id=a&baseRev=${second.body.rev}`, undefined, token)
    expect(del.status).toBe(200)
    const list = await call('GET', `/items?since=${second.body.rev}`, undefined, token)
    expect(list.body.items).toEqual([expect.objectContaining({ id: 'a', deleted: true })])
  })

  it('keeps accounts apart', async () => {
    const a = await signup('a@example.com')
    const b = await signup('b@example.com')
    await put(a.token, 'x', '{"owner":"a"}', 0)
    expect((await call('GET', '/items?since=0', undefined, b.token)).body.items).toEqual([])
    expect((await call('GET', '/item?kind=design&id=x', undefined, b.token)).status).toBe(404)
    // Same id in another account is a different item.
    expect((await put(b.token, 'x', '{"owner":"b"}', 0)).status).toBe(200)
  })

  it('validates kinds, ids and sizes', async () => {
    const { token } = await signup()
    expect((await put(token, '../etc', '{}', 0)).status).toBe(400)
    expect((await put(token, 'a', '{}', 0, 'secrets')).status).toBe(400)
    expect((await put(token, 'big', 'x'.repeat(3.5 * 1024 * 1024), 0)).status).toBe(413)
  })

  it('pages long change lists', async () => {
    const { token } = await signup()
    for (let i = 0; i < 205; i++) await put(token, 'd' + i, '{}', 0)
    const p1 = await call('GET', '/items?since=0', undefined, token)
    expect(p1.body.items.length).toBe(200)
    expect(p1.body.more).toBe(true)
    const p2 = await call('GET', `/items?since=${p1.body.cursor}`, undefined, token)
    expect(p2.body.items.length).toBe(5)
    expect(p2.body.more).toBe(false)
  })

  it('answers CORS only for allowed origins', async () => {
    const ok = await call('OPTIONS', '/items', undefined, undefined, { origin: 'tauri://localhost' })
    expect(ok.headers.get('access-control-allow-origin')).toBe('tauri://localhost')
    const no = await call('OPTIONS', '/items', undefined, undefined, { origin: 'https://evil.example' })
    expect(no.headers.get('access-control-allow-origin')).toBeNull()
  })
})
