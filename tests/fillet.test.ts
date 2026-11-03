import { describe, expect, it } from 'vitest'
import { filletPolygon, formatRadii, maxFillet, parseRadii, rectCorners } from '../src/geometry/fillet'
import { buildFromParams, cornerRadii } from '../src/editor/shapeFactory'
import { radiusValues } from '../src/editor/radius'
import type { Shape } from '../src/model/types'

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)

describe('corner fillets', () => {
  it('clamps a square corner to half its side, as the uniform radius does', () => {
    const sq = rectCorners(100, 100)
    expect(maxFillet(sq, 0)).toBeCloseTo(50, 6)
    const big = filletPolygon(sq, [200, 0, 0, 0])
    // The top-left fillet is the half-side arc: radius 50 about the square's centre.
    const arcPts = big.filter((p) => p.x < -1 && p.y < -1)
    expect(arcPts.length).toBeGreaterThan(0)
    for (const p of arcPts) expect(Math.abs(dist(p, { x: 0, y: 0 }) - 50)).toBeLessThan(1e-6)
  })

  it('rounds each corner with its own radius and leaves zero corners sharp', () => {
    const sq = rectCorners(100, 100)
    const out = filletPolygon(sq, [10, 0, 20, 0])
    expect(out.some((p) => p.x === 50 && p.y === -50)).toBe(true) // top-right stays sharp
    expect(out.some((p) => p.x === -50 && p.y === 50)).toBe(true) // bottom-left stays sharp
    // Points on the top-left arc sit exactly 10 mm from its centre (-40, -40).
    for (const p of out.filter((q) => q.x < -40 && q.y < -40)) expect(dist(p, { x: -40, y: -40 })).toBeCloseTo(10, 6)
  })

  it('keeps tangent contact: each fillet ends on the adjacent edges', () => {
    const tri = [
      { x: 0, y: -50 },
      { x: 43.3, y: 25 },
      { x: -43.3, y: 25 },
    ]
    const out = filletPolygon(tri, [5, 5, 5])
    // Every output point lies inside the triangle (fillets only remove corner area).
    const inside = (p: { x: number; y: number }) => {
      const s = (a: { x: number; y: number }, b: { x: number; y: number }) => (p.x - b.x) * (a.y - b.y) - (a.x - b.x) * (p.y - b.y)
      const d1 = s(tri[0], tri[1])
      const d2 = s(tri[1], tri[2])
      const d3 = s(tri[2], tri[0])
      return !((d1 < -1e-6 || d2 < -1e-6 || d3 < -1e-6) && (d1 > 1e-6 || d2 > 1e-6 || d3 > 1e-6))
    }
    expect(out.every(inside)).toBe(true)
    expect(out.length).toBeGreaterThan(tri.length)
  })

  it('round-trips the per-corner radius list and rejects a list of the wrong length', () => {
    expect(parseRadii(formatRadii([1, 0.5, 0, 2]), 4)).toEqual([1, 0.5, 0, 2])
    expect(parseRadii('1,2', 4)).toBeNull()
    expect(parseRadii(undefined, 4)).toBeNull()
  })
})

describe('shape radius params', () => {
  const rectShape = (params: Record<string, number | string | boolean>): Shape =>
    ({ kind: 'rect', params } as unknown as Shape)

  it('falls back to the uniform radius when no corner list is stored', () => {
    expect(cornerRadii({ r: 3 }, 4)).toEqual([3, 3, 3, 3])
    expect(radiusValues(rectShape({ w: 100, h: 100, r: 3 }))).toEqual([3, 3, 3, 3])
  })

  it('builds a rectangle from its corner list', () => {
    const cs = buildFromParams('rect', { w: 100, h: 100, r: 0, cr: formatRadii([10, 0, 0, 0]) })!
    const xs = cs[0].pts.map((p) => p.x)
    expect(Math.min(...xs)).toBeCloseTo(-50, 6)
    expect(cs[0].pts.some((p) => p.x === 50 && p.y === -50)).toBe(true)
  })

  it('rounds a pentagon and reports its vertex count as the corner count', () => {
    const sharp = buildFromParams('polygon', { w: 100, h: 100, n: 5, r: 0 })!
    const round = buildFromParams('polygon', { w: 100, h: 100, n: 5, r: 8 })!
    expect(round[0].pts.length).toBeGreaterThan(sharp[0].pts.length)
    expect(radiusValues({ kind: 'polygon', params: { n: 5, r: 8 } } as unknown as Shape)).toHaveLength(5)
  })
})
