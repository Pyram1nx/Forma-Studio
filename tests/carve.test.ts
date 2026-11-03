import { describe, expect, it } from 'vitest'
import { sliceAt, sliceDetailed } from '../src/features/carve3d/slicer'
import { buildCarvePlan } from '../src/features/carve3d/carvePlan'
import { BITS, DEFAULT_BIT_ID, defaultBit, radiusAtHeight, type Bit } from '../src/features/carve3d/bits'
import { signedArea } from '../src/geometry/offset'

/** Hemisphere of radius R on z=0 (closed with a base disc). */
function dome(R = 20, nu = 72, nv = 24): Float32Array {
  const t: number[] = []
  const P = (u: number, v: number) => {
    const th = (u / nu) * 2 * Math.PI
    const ph = (v / nv) * (Math.PI / 2)
    return [R * Math.cos(ph) * Math.cos(th), R * Math.cos(ph) * Math.sin(th), R * Math.sin(ph)]
  }
  for (let u = 0; u < nu; u++)
    for (let v = 0; v < nv; v++) {
      const a = P(u, v), b = P(u + 1, v), c = P(u + 1, v + 1), d = P(u, v + 1)
      t.push(...a, ...b, ...c, ...a, ...c, ...d)
    }
  for (let u = 0; u < nu; u++) t.push(0, 0, 0, ...P(u + 1, 0), ...P(u, 0))
  return new Float32Array(t)
}

/**
 * Closed solid of revolution around Z from a profile of (r, z) points (r >= 0), outward normals.
 * The profile must be closed by returning to its first point.
 */
function revolve(profile: [number, number][], nseg = 64): Float32Array {
  const tris: number[] = []
  const V = (r: number, z: number, j: number) => {
    const th = (j / nseg) * 2 * Math.PI
    return [r * Math.cos(th), r * Math.sin(th), z]
  }
  for (let i = 0; i < profile.length - 1; i++) {
    const [r0, z0] = profile[i]
    const [r1, z1] = profile[i + 1]
    if (r0 === 0 && r1 === 0) continue
    for (let j = 0; j < nseg; j++) {
      const a = V(r0, z0, j), b = V(r1, z1, j), c = V(r1, z1, j + 1), d = V(r0, z0, j + 1)
      tris.push(...a, ...b, ...c, ...a, ...c, ...d)
    }
  }
  // Orientation: make the signed volume positive (outward normals).
  let vol = 0
  for (let i = 0; i < tris.length; i += 9) {
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = tris.slice(i, i + 9)
    vol += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)
  }
  if (vol < 0) {
    for (let i = 0; i < tris.length; i += 9) {
      for (let k = 0; k < 3; k++) {
        const t = tris[i + 3 + k]
        tris[i + 3 + k] = tris[i + 6 + k]
        tris[i + 6 + k] = t
      }
    }
  }
  return new Float32Array(tris)
}

const maxR = (cs: { pts: { x: number; y: number }[] }[], ox = 0, oy = 0) =>
  Math.max(...cs.flatMap((c) => c.pts.map((p) => Math.hypot(p.x + ox, p.y + oy))))
const minR = (cs: { pts: { x: number; y: number }[] }[], ox = 0, oy = 0) =>
  Math.min(...cs.flatMap((c) => c.pts.map((p) => Math.hypot(p.x + ox, p.y + oy))))

const area = (cs: { pts: { x: number; y: number }[]; closed: boolean }[]) =>
  Math.abs(cs.reduce((a, c) => a + (c.closed ? signedArea(c.pts) : 0), 0))

/** Axis-aligned box as 12 outward triangles. Optionally drops one triangle. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, drop = -1): Float32Array {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quads = [
    [0, 3, 2, 1], // bottom (-z)
    [4, 5, 6, 7], // top (+z)
    [0, 1, 5, 4], // -y
    [1, 2, 6, 5], // +x
    [2, 3, 7, 6], // +y
    [3, 0, 4, 7], // -x
  ]
  const out: number[] = []
  let t = 0
  for (const [a, b, c, d] of quads) {
    for (const tri of [[a, b, c], [a, c, d]]) {
      if (t++ === drop) continue
      for (const i of tri) out.push(...p[i])
    }
  }
  return new Float32Array(out)
}

describe('slicer', () => {
  it('slices a dome into one closed circle of the right radius', () => {
    const cs = sliceAt(dome(), 16)
    expect(cs.length).toBe(1)
    expect(cs[0].closed).toBe(true)
    expect(maxR(cs)).toBeCloseTo(12, 0) // sqrt(20² − 16²)
  })

  it('union of two overlapping boxes has no hole (area 175, not 150)', () => {
    const a = box(0, 0, 0, 10, 10, 10)
    const b = box(5, 5, 0, 15, 15, 10)
    const merged = new Float32Array(a.length + b.length)
    merged.set(a, 0)
    merged.set(b, a.length)
    const res = sliceDetailed(merged, 5)
    expect(res.openChains).toBe(0)
    expect(area(res.contours)).toBeCloseTo(175, 1)
  })

  it('a mesh with one missing triangle reports an open loop', () => {
    const closed = sliceDetailed(box(0, 0, 0, 10, 10, 10), 5)
    expect(closed.openChains).toBe(0)
    // Triangle 6 is on the -y face (the side wall), so the section loses one segment.
    const holed = sliceDetailed(box(0, 0, 0, 10, 10, 10, 6), 5)
    expect(holed.openChains).toBeGreaterThan(0)
  })

  it('abutting shells with detail finer than the weld distance still close (fan of wedges)', () => {
    // 40 quarter-disc wedges, each its own closed shell sharing walls with its neighbours, the
    // arc tessellated at 0.03 mm (an exported terrain-style model looks like this).
    const R = 50
    const tris: number[] = []
    for (let w = 0; w < 40; w++) {
      const a0 = (Math.PI / 2) * (w / 40)
      const a1 = (Math.PI / 2) * ((w + 1) / 40)
      const steps = Math.ceil(((a1 - a0) * R) / 0.03)
      const poly: [number, number][] = [[0, 0]]
      for (let s = 0; s <= steps; s++) {
        const a = a0 + ((a1 - a0) * s) / steps
        poly.push([R * Math.cos(a), R * Math.sin(a)])
      }
      tris.push(...prism(poly, 0, 10))
    }
    const res = sliceDetailed(new Float32Array(tris), 5)
    expect(res.openChains).toBe(0)
    expect(res.contours.length).toBe(1)
    expect(area(res.contours)).toBeCloseTo((Math.PI * R * R) / 4, 0)
  })

  it('a plane at a flat face with float noise takes the material above it, without slivers', () => {
    // Step: a 10×10 slab up to z≈5 (its top vertices jittered by ±2e-5) under a 5×10 block to z=10.
    const edge = (n: number): [number, number][] => {
      const out: [number, number][] = []
      for (let i = 0; i < n; i++) out.push([(10 * i) / n, 0])
      for (let i = 0; i < n; i++) out.push([10, (10 * i) / n])
      for (let i = 0; i < n; i++) out.push([10 - (10 * i) / n, 10])
      for (let i = 0; i < n; i++) out.push([0, 10 - (10 * i) / n])
      return out
    }
    const jitter = (x: number, y: number) => 5 + 2e-5 * Math.sin(x * 12.9898 + y * 78.233)
    const slab = prism(edge(20), 0, 5, jitter)
    const block = prism([[0, 0], [5, 0], [5, 10], [0, 10]], 5, 10)
    const res = sliceDetailed(new Float32Array([...slab, ...block]), 5)
    expect(res.openChains).toBe(0)
    expect(res.contours.length).toBe(1)
    expect(area(res.contours)).toBeCloseTo(50, 1)
  })

  it('joins a crack and a flipped triangle instead of dropping the loop', () => {
    // The +x wall (triangles 6 and 7) moved out 0.01 mm: its corners no longer meet the
    // neighbouring walls', so the section has two cracks.
    const cracked = box(0, 0, 0, 10, 10, 10)
    for (let i = 6 * 9; i < 8 * 9; i += 3) cracked[i] += 0.01
    const a = sliceDetailed(cracked, 5)
    expect(a.openChains).toBe(0)
    expect(area(a.contours)).toBeCloseTo(100, 0)
    // Triangle 6 (a side wall) wound the wrong way round.
    const flipped = box(0, 0, 0, 10, 10, 10)
    const t = 6 * 9
    for (let k = 0; k < 3; k++) [flipped[t + 3 + k], flipped[t + 6 + k]] = [flipped[t + 6 + k], flipped[t + 3 + k]]
    const b = sliceDetailed(flipped, 5)
    expect(b.openChains).toBe(0)
    expect(area(b.contours)).toBeCloseTo(100, 1)
  })
})

/** Closed prism over a counter-clockwise polygon from z0 to z1 (top z per vertex optional). */
function prism(poly: [number, number][], z0: number, z1: number, top: (x: number, y: number) => number = () => z1): number[] {
  const out: number[] = []
  const n = poly.length
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % n]
    out.push(ax, ay, z0, bx, by, z0, bx, by, top(bx, by), ax, ay, z0, bx, by, top(bx, by), ax, ay, top(ax, ay))
  }
  // Fan caps from the polygon centroid (works for the convex and star-shaped test polygons).
  const cx = poly.reduce((s, p) => s + p[0], 0) / n
  const cy = poly.reduce((s, p) => s + p[1], 0) / n
  for (let i = 0; i < n; i++) {
    const [ax, ay] = poly[i]
    const [bx, by] = poly[(i + 1) % n]
    out.push(cx, cy, top(cx, cy), ax, ay, top(ax, ay), bx, by, top(bx, by))
    out.push(cx, cy, z0, bx, by, z0, ax, ay, z0)
  }
  return out
}

describe('bits', () => {
  it('60° engraving bit: radius at 1 mm is tan 30° ≈ 0.577', () => {
    const v60 = BITS.find((b) => b.sku === 'SE1-2500-V60E')!
    expect(v60.type).toBe('vbit')
    expect(radiusAtHeight(v60, 1)).toBeCloseTo(Math.tan(Math.PI / 6), 2)
  })

  it('the in-box 1/4" bit is the default', () => {
    const b = defaultBit()
    expect(b.inBox).toBe(true)
    expect(b.type).toBe('flat')
    expect(b.sku).toBeNull()
    expect(b.diameter).toBeCloseTo(6.35)
    expect(b.id).toBe(DEFAULT_BIT_ID)
  })

  it('T-slot and dovetail are gallery-only (not carvable)', () => {
    expect(BITS.filter((b) => !b.carvable).map((b) => b.name)).toEqual(['5mm T-Slot Router Bit', '15° Dovetail Router Bit'])
  })
})

describe('carve plan', () => {
  const flat: Bit = { id: 't-flat', name: 'test flat', type: 'flat', diameter: 6.35, fluteLength: 30 } as Bit
  it('flat bit toolpath = section radius + bit radius', async () => {
    const plan = await buildCarvePlan(dome(), 20, {
      bit: flat, stepDown: 4, stockThickness: 20, margin: 5, throughCut: false,
      outputs: { contour: true, toolpath: true, pocket: true }, units: 'mm',
    })
    const tp = plan.shapes.find((s) => s.name.startsWith('L01 · toolpath'))!
    expect(maxR(tp.contours, tp.x, tp.y)).toBeCloseTo(12 + 3.175, 0)
    expect(tp.cut.type).toBe('online')
    expect(tp.cut.depth).toBeCloseTo(4)
    expect(plan.layers.every((l) => l.openLoops === 0)).toBe(true)
  })

  it('mushroom overhang: layer-5 toolpath clears the cap (r = 10) by the bit radius', async () => {
    // Cap r=10 from z 8..10, stem r=3 from z 0..8.
    const mushroom = revolve([
      [0, 0], [3, 0], [3, 8], [10, 8], [10, 10], [0, 10], [0, 0],
    ])
    const plan = await buildCarvePlan(mushroom, 10, {
      bit: { ...flat, id: 'f635', name: '1/4 flat', diameter: 6.35, fluteLength: 25.4 } as Bit,
      stepDown: 2, stockThickness: 10, margin: 5, throughCut: false,
      outputs: { contour: false, toolpath: true, pocket: false }, units: 'mm',
    })
    const tp = plan.shapes.find((s) => s.name.startsWith('L05 · toolpath'))!
    expect(tp).toBeDefined()
    expect(minR(tp.contours, tp.x, tp.y)).toBeGreaterThanOrEqual(10 + 3.175 - 0.05)
    expect(plan.layers.every((l) => l.openLoops === 0)).toBe(true)
    // The undercut under the cap is reported, not silently ignored.
    expect(plan.warnings.some((w) => w.includes('undercuts'))).toBe(true)
  })

  it('a bit that cannot carve top-down is rejected', async () => {
    const tslot = BITS.find((b) => b.type === 'undercut')!
    await expect(
      buildCarvePlan(dome(), 20, {
        bit: tslot, stepDown: 2, stockThickness: 20, margin: 5, throughCut: false,
        outputs: { contour: true, toolpath: true, pocket: true }, units: 'mm',
      }),
    ).rejects.toThrow()
  })
})
