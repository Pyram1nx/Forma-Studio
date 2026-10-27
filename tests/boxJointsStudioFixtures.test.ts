// Our box joint geometry against shapes captured from the live Shaper Studio
// (tests/fixtures/boxJointsStudio.json). Studio's svg frame is y-down like ours, in the shape's
// units (inches or mm), translated so nothing is negative; both sides are aligned on the
// top-left of everything drawn and compared within 1e-3 in.
import { describe, expect, it } from 'vitest'
import fixtures from './fixtures/boxJointsStudio.json'
import { boxJointGuides, boxJointPocket, type BoxJointKind } from '../src/geometry/boxJoints'
import type { Pt } from '../src/model/types'

interface Fixture {
  case: string
  params: Record<string, unknown> | null
  paths: { id: string; cutParams: { cutType: string; toolDia: string }; svg: string }[]
}

type Poly = Pt[]

/** Subpaths of an absolute M/L/C/Z path: on-curve points only (curve end points). */
function parseSvg(d: string): { polys: Poly[]; hv: { xs: number[]; ys: number[] } } {
  const tok = d.match(/[MLCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi) ?? []
  const polys: Poly[] = []
  const xs: number[] = []
  const ys: number[] = []
  let cur: Poly = []
  let i = 0
  let cmd = ''
  const num = () => Number(tok[i++])
  while (i < tok.length) {
    if (/[MLCZ]/i.test(tok[i])) cmd = tok[i++].toUpperCase()
    if (cmd === 'Z') {
      if (cur.length) polys.push(cur)
      cur = []
      continue
    }
    if (cmd === 'M') {
      if (cur.length) polys.push(cur)
      cur = [{ x: num(), y: num() }]
      cmd = 'L'
    } else if (cmd === 'L') {
      const p = { x: num(), y: num() }
      const q = cur[cur.length - 1]
      if (q && Math.abs(q.x - p.x) < 1e-6 && Math.abs(q.y - p.y) > 1e-6) xs.push(p.x)
      if (q && Math.abs(q.y - p.y) < 1e-6 && Math.abs(q.x - p.x) > 1e-6) ys.push(p.y)
      cur.push(p)
    } else if (cmd === 'C') {
      i += 4
      cur.push({ x: num(), y: num() })
    }
  }
  if (cur.length) polys.push(cur)
  return { polys, hv: { xs, ys } }
}

/** x levels of vertical edges and y levels of horizontal edges of a polyline. */
function levels(polys: Poly[], closed: boolean) {
  const xs: number[] = []
  const ys: number[] = []
  for (const pts of polys) {
    const n = pts.length
    for (let k = 0; k < (closed ? n : n - 1); k++) {
      const a = pts[k]
      const b = pts[(k + 1) % n]
      if (Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) > 1e-6) xs.push(a.x)
      if (Math.abs(a.y - b.y) < 1e-9 && Math.abs(a.x - b.x) > 1e-6) ys.push(a.y)
    }
  }
  return { xs, ys }
}

const uniq = (v: number[], tol: number) =>
  [...v].sort((a, b) => a - b).filter((x, k, arr) => k === 0 || Math.abs(x - arr[k - 1]) > tol)

function bbox(polys: Poly[]) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const pts of polys)
    for (const p of pts) {
      b.minX = Math.min(b.minX, p.x)
      b.minY = Math.min(b.minY, p.y)
      b.maxX = Math.max(b.maxX, p.x)
      b.maxY = Math.max(b.maxY, p.y)
    }
  return b
}

const dropClosing = (pts: Poly) =>
  pts.length > 1 && Math.abs(pts[0].x - pts[pts.length - 1].x) < 1e-6 && Math.abs(pts[0].y - pts[pts.length - 1].y) < 1e-6 ? pts.slice(0, -1) : pts

function distToPoly(p: Pt, pts: Poly): number {
  let best = Infinity
  for (let k = 0; k < pts.length; k++) {
    const a = pts[k]
    const b = pts[(k + 1) % pts.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y))
  }
  return best
}

/** Studio params (doc units) → our params (mm). */
function ourParams(p: Record<string, unknown>): { kind: BoxJointKind; u: number; v: Record<string, number> } {
  const u = p.units === 'in' ? 25.4 : 1
  const n = (k: string) => Number(p[k])
  return {
    kind: p.templateName === 'boxJointIrregular' ? 'pro' : 'basic',
    u,
    v: {
      side: p.side === 'B' ? 1 : 0,
      length: n('totalWidth') * u,
      thickness: n('thickness') * u,
      bitDiameter: n('bitDiameter') * u,
      fingers: n('pinCount'),
      pinFactor: p.ratio === undefined ? 0 : n('ratio'),
      glueGap: n('glueGap') * u,
      guides: p.includeGuides === 'hide' ? 0 : 1,
    },
  }
}

const cases = (fixtures as Fixture[]).filter((f) => f.params && f.paths.some((p) => p.id === 'geometry'))

describe('box joints match the live Studio capture', () => {
  it('covers the cases we rely on', () => {
    const names = cases.map((c) => c.case)
    for (const want of [
      'basic-defaults',
      'basic-sideB',
      'basic-pin4-sideA',
      'basic-pin4-sideB',
      'basic-glueGap0.02in-sideA',
      'basic-glueGap0.02in-sideB',
      'basic-guidesHide-sideA',
      'pro-defaults',
      'pro-sideB',
      'pro-ratio-min (Home key)',
      'pro-ratio-0 (20x ArrowRight from -1)',
      'pro-ratio+0.5 (10x ArrowRight from 0)',
      'pro-ratio+1 (12x ArrowRight from 0.5, stops at max)',
      'pro-glueGap0.02in-sideA',
      'pro-glueGap0.02in-sideB',
    ])
      expect(names).toContain(want)
  })

  for (const f of cases) {
    it(f.case, () => {
      const { kind, u, v } = ourParams(f.params!)
      // Tolerance: 1e-3 in, in the shape's own units.
      const tol = u === 1 ? 0.0254 : 1e-3
      const toUnits = (pts: Pt[]) => pts.map((p) => ({ x: p.x / u, y: p.y / u }))

      const pocket = boxJointPocket(kind, v).map((c) => toUnits(c.pts))
      const guides = boxJointGuides(kind, v)
      const ourGuidePolys = guides.flatMap((g) => [toUnits(g.rect.pts), dropClosing(toUnits(g.letter.pts))])

      const geo = f.paths.find((p) => p.id === 'geometry')!
      const studioPocket = parseSvg(geo.svg)
      const studioGuides = f.paths.filter((p) => p.id !== 'geometry').flatMap((p) => parseSvg(p.svg).polys.map(dropClosing))

      // Pocket cut settings as Studio has them: inside, 1/4 in tool; guides are guide cuts.
      expect(geo.cutParams.cutType).toBe('inside')
      expect(geo.cutParams.toolDia).toBe('0.25in')
      for (const p of f.paths) if (p.id !== 'geometry') expect(p.cutParams.cutType).toBe('guide')

      // Align both on the top-left of everything drawn.
      const ours = bbox([...pocket, ...ourGuidePolys])
      const theirs = bbox([...studioPocket.polys, ...studioGuides])
      const dx = theirs.minX - ours.minX
      const dy = theirs.minY - ours.minY
      const shift = (pts: Poly) => pts.map((p) => ({ x: p.x + dx, y: p.y + dy }))
      const P = pocket.map(shift)
      const G = ourGuidePolys.map(shift)

      // Pocket: same extents, same straight-edge levels, every Studio vertex on our outline.
      const pb = bbox(P)
      const sb = bbox(studioPocket.polys)
      expect(Math.abs(pb.minX - sb.minX)).toBeLessThan(tol)
      expect(Math.abs(pb.maxX - sb.maxX)).toBeLessThan(tol)
      expect(Math.abs(pb.minY - sb.minY)).toBeLessThan(tol)
      expect(Math.abs(pb.maxY - sb.maxY)).toBeLessThan(tol)
      const ol = levels(P, true)
      const near = (a: number[], b: number[]) => a.length === b.length && a.every((x, k) => Math.abs(x - b[k]) < tol)
      expect(near(uniq(ol.xs, tol), uniq(studioPocket.hv.xs, tol))).toBe(true)
      expect(near(uniq(ol.ys, tol), uniq(studioPocket.hv.ys, tol))).toBe(true)
      for (const pts of studioPocket.polys) for (const p of pts) expect(Math.min(...P.map((q) => distToPoly(p, q)))).toBeLessThan(tol)

      // Guides: the same boxes and letters (vertex for vertex, any order).
      expect(G.length).toBe(studioGuides.length)
      const key = (pts: Poly) => {
        const b = bbox([pts])
        return [b.minX, b.minY, b.maxX, b.maxY]
      }
      const sortPolys = (ps: Poly[]) => [...ps].sort((a, b) => {
        const ka = key(a)
        const kb = key(b)
        for (let k = 0; k < 4; k++) if (Math.abs(ka[k] - kb[k]) > tol) return ka[k] - kb[k]
        return a.length - b.length
      })
      const gs = sortPolys(G)
      const ss = sortPolys(studioGuides)
      gs.forEach((g, k) => {
        const s = ss[k]
        expect(key(g).every((x, j) => Math.abs(x - key(s)[j]) < tol)).toBe(true)
        expect(g.length).toBe(s.length)
        for (const p of s) expect(Math.min(...g.map((q) => Math.hypot(q.x - p.x, q.y - p.y)))).toBeLessThan(tol)
      })
    })
  }
})
