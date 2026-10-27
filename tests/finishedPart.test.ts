import { describe, expect, it } from 'vitest'
import { buildFinishedPart, surfaceNets } from '../src/features/carve3d/finishedPart'
import { buildMultiSidePlan } from '../src/features/carve3d/multiSide'
import { placeModel } from '../src/features/carve3d/loadModel'

/** Signed volume of an indexed mesh (positive when wound outward). */
function volume(m: { positions: Float32Array; indices: Uint32Array }): number {
  const p = m.positions
  let v = 0
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t] * 3, m.indices[t + 1] * 3, m.indices[t + 2] * 3]
    v += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])
  }
  return v / 6
}

function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const p = [[x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]]
  const q = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]]
  const o: number[] = []
  for (const [a, b, c, d] of q) for (const t of [[a, b, c], [a, c, d]]) for (const i of t) o.push(...p[i])
  return o
}

describe('surfaceNets', () => {
  it('meshes a sphere field closed and wound outward', () => {
    const n = 24
    const f = new Float32Array(n * n * n)
    for (let k = 0; k < n; k++)
      for (let j = 0; j < n; j++)
        for (let i = 0; i < n; i++) f[(k * n + j) * n + i] = 8 - Math.hypot(i - 11.5, j - 11.5, k - 11.5)
    const m = surfaceNets(f, n, n, n, [0, 0, 0], 1)
    expect(m.indices.length).toBeGreaterThan(0)
    // Every edge is shared by exactly two triangles: the mesh is closed.
    const edges = new Map<string, number>()
    for (let t = 0; t < m.indices.length; t += 3)
      for (let e = 0; e < 3; e++) {
        const a = m.indices[t + e]
        const b = m.indices[t + ((e + 1) % 3)]
        const key = a < b ? `${a},${b}` : `${b},${a}`
        edges.set(key, (edges.get(key) ?? 0) + 1)
      }
    for (const c of edges.values()) expect(c).toBe(2)
    expect(volume(m)).toBeGreaterThan(0.9 * (4 / 3) * Math.PI * 512)
    expect(volume(m)).toBeLessThan(1.1 * (4 / 3) * Math.PI * 512)
  })
})

describe('buildFinishedPart', () => {
  it('applies every side: the slot carved from the front and the part cut out from the top', async () => {
    // 40 × 40 × 40 cube with a 10 mm wide slot cut 20 mm in from the front (z 15..25).
    const raw = new Float32Array([...box(0, 0, 0, 40, 40, 15), ...box(0, 0, 25, 40, 40, 40), ...box(0, 20, 15, 40, 40, 25)])
    const placed = placeModel(raw, 'mm', 'z', null)
    const plan = await buildMultiSidePlan(placed, {
      sides: ['top', 'front'],
      bits: { rough: null, detail: 'SF1-8-6F3', engrave: null },
      finishAllowance: 1,
      engraveDepth: 1.5,
      stepDown: 2,
      margin: 10,
      stockThickness: 40,
      bridges: { count: 2, width: 5, height: 1 },
      outputs: { contour: false, toolpath: true, pocket: false },
      units: 'mm',
      key: 'part',
    })
    expect(plan.sides.map((s) => s.side)).toEqual(['top', 'front'])
    const part = await buildFinishedPart(placed, plan, undefined, undefined, 400_000)
    expect(part).not.toBeNull()
    const v = volume(part!)
    // Model volume: 40³ − slot 40 × 20 × 10 = 56 000 mm³. The frame is cut away, the slot is
    // carved, and the 6 mm bit leaves rounded inside corners at the slot floor.
    expect(v).toBeGreaterThan(54_000)
    expect(v).toBeLessThan(60_000)
  }, 60_000)
})

describe('overhanging bowl', () => {
  /** Square bowl upside down on its flat tip: walls flare out over the base, cavity from the top. */
  function bowl(): Float32Array {
    // A 4-segment revolve is a square frustum; profile (half-diagonal, z), outward normals.
    const profile: [number, number][] = [[0, 0], [34, 0], [70, 47], [69, 47], [30, 7], [0, 7]]
    const nseg = 4
    const tris: number[] = []
    const V = (r: number, z: number, j: number) => {
      const th = (j / nseg) * 2 * Math.PI + Math.PI / 4
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
    const m = new Float32Array(tris)
    if (volume({ positions: m, indices: Uint32Array.from({ length: m.length / 3 }, (_, i) => i) }) < 0)
      for (let i = 0; i < m.length; i += 9) for (let k = 0; k < 3; k++) [m[i + 3 + k], m[i + 6 + k]] = [m[i + 6 + k], m[i + 3 + k]]
    return m
  }

  it('the bottom carves the whole overhang, not just what the top does not reach first', async () => {
    const raw = bowl()
    const placed = placeModel(raw, 'mm', 'z', null)
    const plan = await buildMultiSidePlan(placed, {
      sides: ['top', 'bottom'],
      bits: { rough: null, detail: 'SF1-8-6F3', engrave: null },
      finishAllowance: 1,
      engraveDepth: 1.5,
      stepDown: 1,
      margin: 10,
      stockThickness: 47,
      bridges: { count: 0, width: 5, height: 1 },
      outputs: { contour: false, toolpath: true, pocket: false },
      units: 'mm',
      key: 'bowl',
    })
    const bottom = plan.sides.find((s) => s.side === 'bottom')!
    // The waste under the flared walls runs almost up to the rim: 47 mm, less a cell.
    expect(bottom.cutDepth).toBeGreaterThan(44)
    const part = await buildFinishedPart(placed, plan, undefined, undefined, 500_000)
    const model = volume({ positions: placed.positions, indices: Uint32Array.from({ length: placed.positions.length / 3 }, (_, i) => i) })
    // The finished part is the bowl, not the bowl with a slab of block left around its rim.
    // (Stair-steps and the bit's corner radii leave a little extra.)
    expect(volume(part!)).toBeLessThan(model * 1.25)
  }, 60_000)
})
