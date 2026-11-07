// Every bundled library font must typeset through textGeometry: no load failures (missing files served as
// the HTML app page, opentype.js shaping errors) and no NaN coordinates.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { FONTS } from '../src/io/fontCatalog'
import { commandsToPathData, textGeometry } from '../src/io/text'

const FONT_DIR = join(__dirname, '../public/fonts/studio')
const SAMPLE = 'Hello World éñ 08 &@'

beforeAll(() => {
  // Serve /fonts/studio/<file> from public/, as the dev server does; anything else is a 404.
  vi.stubGlobal('fetch', async (url: string) => {
    const m = /\/fonts\/studio\/([^/?#]+)$/.exec(url)
    if (!m) return new Response('not found', { status: 404 })
    try {
      return new Response(await readFile(join(FONT_DIR, decodeURIComponent(m[1]))), { headers: { 'content-type': 'font/ttf' } })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
})
afterAll(() => vi.unstubAllGlobals())

describe('commandsToPathData', () => {
  it('writes coordinates a hair off a whole number (opentype.js writes NaN for these)', () => {
    const d = commandsToPathData([{ type: 'M', x: 54.00000000000001, y: -56.592000000000006 }, { type: 'L', x: 1e-12, y: -0.0000001 }, { type: 'Z' }], 2)
    expect(d).toBe('M54 -56.59L0 0Z')
  })

  it('skips commands with non-finite coordinates instead of emitting NaN', () => {
    const d = commandsToPathData([{ type: 'M', x: 0, y: 0 }, { type: 'L', x: NaN, y: 1 }, { type: 'L', x: 2, y: 3 }], 3)
    expect(d).toBe('M0 0L2 3')
  })
})

const local = FONTS.flatMap((f) => f.fontStyles.filter((s) => !s.remoteUrl).map((s) => [f.fontDisplayName, s.displayStyle] as const))

describe('library fonts', () => {
  it.each(local)('%s %s typesets the sample', async (font, style) => {
    const g = await textGeometry(SAMPLE, font, 10, style)
    expect(g.pen.length).toBeGreaterThan(10)
    const values = g.pen.flatMap((c) => c.nodes.flatMap((n) => [n.x, n.y, n.in?.x ?? 0, n.in?.y ?? 0, n.out?.x ?? 0, n.out?.y ?? 0]))
    expect(values.every(Number.isFinite)).toBe(true)
    // The whole line is there: it spans far wider than a few glyphs at 10 mm cap height.
    let minX = Infinity
    let maxX = -Infinity
    for (const c of g.contours) for (const p of c.pts) (minX = Math.min(minX, p.x)), (maxX = Math.max(maxX, p.x))
    expect(maxX - minX).toBeGreaterThan(60)
  })
})
