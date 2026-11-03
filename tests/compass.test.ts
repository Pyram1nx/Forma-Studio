import { describe, expect, it } from 'vitest'
import { TEMPLATES } from '../src/geometry/templates'

const build = (p: Record<string, number> = {}) => TEMPLATES.find((t) => t.id === 'compass')!.build(p)

describe('compass template matches Shaper Studio', () => {
  it('is 16 closed facets by default, one per half point', () => {
    const cs = build()
    expect(cs).toHaveLength(16)
    expect(cs.every((c) => c.closed)).toBe(true)
  })

  it('keeps the outer diameter exact with rounded tips (50.8 mm)', () => {
    const pts = build().flatMap((c) => c.pts)
    const maxY = Math.min(...pts.map((p) => p.y))
    const maxX = Math.max(...pts.map((p) => p.x))
    expect(-maxY).toBeCloseTo(25.4, 6)
    expect(maxX).toBeCloseTo(25.4, 6)
  })

  it('puts sharp notches at the inner radius and a spoke centre at the origin', () => {
    const cs = build()
    const r = cs[0].pts.map((p) => Math.hypot(p.x, p.y))
    expect(r.some((v) => Math.abs(v - 12.7) < 1e-6)).toBe(true)
    expect(cs.every((c) => c.pts.some((p) => p.x === 0 && p.y === 0))).toBe(true)
  })

  it('survives tip radius 0 and oversized tip radius', () => {
    expect(build({ tipRadius: 0 })).toHaveLength(16)
    const big = build({ tipRadius: 100 }).flatMap((c) => c.pts)
    expect(big.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y))).toBe(true)
  })
})

describe('compass limits match Shaper Studio (inch values from the real Studio, in mm)', () => {
  const t = TEMPLATES.find((x) => x.id === 'compass')!
  const IN = 25.4
  const base = { points: 8, size: 2 * IN, innerDiameter: IN, tipRadius: 0.07 * IN }
  const edit = (key: string, inches: number, from: Record<string, number> = base) => t.constrain!(from, key, key === 'points' ? inches : inches * IN)

  it('clamps the tip radius to what fits when the inner diameter shrinks', () => {
    expect(edit('innerDiameter', 0.3)!.tipRadius / IN).toBeCloseTo(0.057, 3)
    expect(edit('innerDiameter', 0.1)!.tipRadius / IN).toBeCloseTo(0.019, 3)
  })

  it('clamps an oversized tip radius (0.189 in at the defaults)', () => {
    expect(edit('tipRadius', 0.4)!.tipRadius / IN).toBeCloseTo(0.189, 3)
  })

  it('keeps the inner diameter 0.005 in inside the outer and at least 0.02 in', () => {
    expect(edit('innerDiameter', 5)!.innerDiameter / IN).toBeCloseTo(1.995, 6)
    expect(edit('innerDiameter', 0.005)!.innerDiameter / IN).toBeCloseTo(0.02, 6)
    expect(edit('size', 0.5, { ...base, tipRadius: 0 })!.innerDiameter / IN).toBeCloseTo(0.495, 6)
  })

  it('refuses an outer diameter that cannot hold the tip radius, or is ~0', () => {
    expect(edit('size', 0.38)).not.toBeNull()
    expect(edit('size', 0.37)).toBeNull()
    expect(edit('size', 0.005, { ...base, tipRadius: 0 })).toBeNull()
  })

  it('shrinks the tip radius when the point count grows', () => {
    expect(edit('points', 100)!.tipRadius / IN).toBeCloseTo(0.0155, 3)
  })

  it('keeps the star centre at the origin whatever the point count', () => {
    for (const n of [3, 5, 7]) {
      const cs = build({ points: n })
      expect(cs.every((c) => c.pts.some((p) => p.x === 0 && p.y === 0))).toBe(true)
    }
  })
})
