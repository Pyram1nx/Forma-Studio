import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { createHandler } from '../server/app.js'
import { createMemoryDb } from '../server/db.js'

// Find Art's own icon index (server/icons.js, data from scripts/build-icon-index.mjs).
const handle = createHandler({ db: createMemoryDb(), env: { SESSION_SECRET: 'test-secret-test-secret-test-secret' } })
const get = (path: string) => handle(new Request('https://forma.test/api' + path))
const search = async (q: string, extra = '') => (await (await get(`/icons/search?q=${encodeURIComponent(q)}${extra}`)).json()) as {
  icons: { id: string; name: string; set: string; license: string }[]
  total: number
}

type Catalog = { sets: { prefix: string; license: string; names: string[] }[] }
const catalog = JSON.parse(readFileSync(new URL('../server/icons/catalog.json', import.meta.url), 'utf8')) as Catalog

describe('icon search', () => {
  it('puts the exact icon first and credits its set', async () => {
    const r = await search('dog')
    expect(r.icons[0]).toEqual({ id: 'mdi:dog', name: 'dog', set: 'Material Design Icons', license: 'Apache-2.0' })
    expect(r.total).toBeGreaterThan(20)
  })

  it('mixes sets on the first page instead of one set filling it', async () => {
    const r = await search('heart')
    const perSet = new Map<string, number>()
    for (const h of r.icons.slice(0, 24)) perSet.set(h.set, (perSet.get(h.set) ?? 0) + 1)
    expect(Math.max(...perSet.values())).toBeLessThanOrEqual(6)
    expect(perSet.size).toBeGreaterThanOrEqual(4)
  })

  it('ranks icons matching every word first, then partial matches', async () => {
    const r = await search('coffee cup')
    expect(r.icons[0].id).toBe('mdi:coffee-to-go') // alias "cup" + name "coffee"
    expect(r.icons.some((h) => h.name === 'cup')).toBe(true)
  })

  it('pages without repeats', async () => {
    const a = await search('star', '&limit=20&offset=0')
    const b = await search('star', '&limit=20&offset=20')
    expect(a.total).toBe(b.total)
    expect(b.icons).toHaveLength(20)
    const ids = new Set(a.icons.map((h) => h.id))
    for (const h of b.icons) expect(ids.has(h.id)).toBe(false)
  })

  it('rejects too-short queries and is CDN-cacheable', async () => {
    expect((await get('/icons/search?q=a')).status).toBe(400)
    const res = await get('/icons/search?q=tree')
    expect(res.headers.get('cache-control')).toContain('s-maxage')
  })
})

describe('icon svg', () => {
  it('serves a standalone black-filled svg', async () => {
    const res = await get('/icons/svg?id=mdi:dog')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    const svg = await res.text()
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="24" height="24" viewBox="0 0 24 24">/)
    expect(svg).not.toContain('currentColor')
  })

  it('keeps the aspect ratio of non-square icons', async () => {
    const svg = await (await get('/icons/svg?id=fa:automobile')).text()
    expect(svg).toContain('height="24"')
    expect(svg).toContain('viewBox="0 0 2048 1600"')
    expect(svg).toContain('width="30.72"')
  })

  it('only serves icons that are in the index', async () => {
    expect((await get('/icons/svg?id=mdi:not-an-icon')).status).toBe(404)
    expect((await get('/icons/svg?id=nope:dog')).status).toBe(404)
    expect((await get('/icons/svg?id=../../etc/passwd')).status).toBe(400)
    expect((await get('/icons/svg?id=mdi:dog%00')).status).toBe(400)
  })
})

describe('icon index data', () => {
  it('lists every set with a permissive licence', async () => {
    const { sets } = (await (await get('/icons/sets')).json()) as { sets: { prefix: string; license: string; total: number }[] }
    expect(sets.length).toBe(catalog.sets.length)
    for (const s of sets) expect(['MIT', 'Apache-2.0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'CC0-1.0', 'OFL-1.1', 'Unlicense']).toContain(s.license)
  })

  it('has a body for every catalogued icon and nothing the importer cannot read', () => {
    for (const s of catalog.sets) {
      const data = JSON.parse(readFileSync(new URL(`../server/icons/sets/${s.prefix}.json`, import.meta.url), 'utf8')) as { icons: Record<string, string | unknown[]> }
      expect(Object.keys(data.icons).sort()).toEqual([...s.names].sort())
      for (const v of Object.values(data.icons)) {
        const body = typeof v === 'string' ? v : (v[0] as string)
        expect(body).not.toMatch(/stroke-width|<(mask|clipPath|script|foreignObject|use)\b|\son[a-z]+=/i)
      }
    }
  })
})
