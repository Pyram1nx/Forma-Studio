import { describe, expect, it } from 'vitest'
import { BITS, ORIGIN_MAX_DEPTH, reachDepth } from '../src/features/carve3d/bits'
import { buildLayeredPlan, layerPiece, suggestLayers } from '../src/features/carve3d/layers'
import { analyzeSides } from '../src/features/carve3d/sideAnalysis'
import { placeModel } from '../src/features/carve3d/loadModel'
import { buildFinishedPart } from '../src/features/carve3d/finishedPart'

const bit = (sku: string) => BITS.find((b) => b.sku === sku)!

/** Signed volume of a triangle soup (positive when wound outward). */
function volume(p: Float32Array): number {
  let v = 0
  for (let a = 0; a < p.length; a += 9)
    v += p[a] * (p[a + 4] * p[a + 8] - p[a + 5] * p[a + 7]) - p[a + 1] * (p[a + 3] * p[a + 8] - p[a + 5] * p[a + 6]) + p[a + 2] * (p[a + 3] * p[a + 7] - p[a + 4] * p[a + 6])
  return v / 6
}

/** Square bowl upside down on its flat tip (4-segment revolve), outward normals. */
function bowl(): Float32Array {
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
  if (volume(m) < 0) for (let i = 0; i < m.length; i += 9) for (let k = 0; k < 3; k++) [m[i + 3 + k], m[i + 6 + k]] = [m[i + 6 + k], m[i + 3 + k]]
  return m
}

describe('reachDepth', () => {
  it("takes Shaper's stated max depth, else the stick-out, never past Origin's Z travel", () => {
    // No stated depth: as far as it sticks out (73 mm − 35 mm holder), at least the flutes.
    expect(reachDepth(bit('SF1-8-16D'))).toBe(38)
    expect(reachDepth(bit('SF1-8-16D'), 60)).toBe(16)
    expect(reachDepth(bit('SE1-2500-1000C'))).toBeCloseTo(25.4) // "max depth 1 in"
    expect(reachDepth(bit('SF1-8-8DP'))).toBe(ORIGIN_MAX_DEPTH) // usable 45 mm, Origin stops at 43
    expect(ORIGIN_MAX_DEPTH).toBe(43)
  })

  it('splits a block into as few boards as the reach allows', () => {
    expect(suggestLayers(117, 43)).toBe(3)
    expect(suggestLayers(43, 43)).toBe(1)
    expect(suggestLayers(10, Infinity)).toBe(1)
  })
})

describe('layerPiece', () => {
  it('cuts a closed slab out of the model, capped, aligned with the model in x and y', () => {
    const placed = placeModel(bowl(), 'mm', 'z', null)
    const total = volume(placed.positions)
    const lo = layerPiece(placed, 0, 20)!
    const hi = layerPiece(placed, 20, 47)!
    expect(lo.offsetZ).toBeCloseTo(0)
    expect(hi.offsetZ).toBeCloseTo(20)
    expect(hi.placed.size.z).toBeCloseTo(27)
    // The two pieces add back up to the model: the caps close each one.
    expect(volume(lo.placed.positions) + volume(hi.placed.positions)).toBeCloseTo(total, -1)
    expect(volume(lo.placed.positions)).toBeGreaterThan(0)
    // Same frame as the model in x and y, so the layers stack.
    expect(hi.placed.bbox.max.x).toBeCloseTo(placed.bbox.max.x, 0)
    // The upper piece is a frame open in the middle: its bottom face is a ring, seen from below
    // the overhang is real waste.
    expect(analyzeSides(hi.placed).bottom.needed).toBe(true)
  })
})

describe('buildLayeredPlan', () => {
  const settings = {
    sides: ['top', 'bottom'] as ('top' | 'bottom')[],
    bits: { rough: null, detail: 'SE1-2500-1000C', engrave: null },
    finishAllowance: 1,
    engraveDepth: 1.5,
    stepDown: 3,
    margin: 10,
    stockThickness: 47,
    bridges: { count: 2, width: 5, height: 1 },
    outputs: { contour: false, toolpath: true, pocket: false },
    units: 'mm' as const,
    key: 'layers',
  }

  it('one board: depths past the bit are cut short and the split is suggested', async () => {
    const placed = placeModel(bowl(), 'mm', 'z', null)
    const plan = await buildLayeredPlan(placed, { ...settings, layers: 1 })
    expect(plan.layers).toHaveLength(1)
    // 1/4" × 1" reaches 25.4 mm: two 23.5 mm boards.
    expect(plan.layerLimit).toBeCloseTo(25.4)
    expect(plan.splitTo).toBe(2)
    expect(plan.warnings.some((w) => w.includes('split the block into layers'))).toBe(true)
    // No layer of any stage, nor the cut-out, goes past the bit's reach.
    for (const s of plan.layers[0].plan.sides)
      for (const p of s.plans) {
        for (const l of p.layers) expect(l.depth).toBeLessThanOrEqual(25.4 + 1e-6)
        if (p.throughCut) expect(p.throughDepth).toBeLessThanOrEqual(25.4 + 1e-6)
      }
  }, 60_000)

  it('two boards: everything in reach, each board carved, cut out and named by layer', async () => {
    const placed = placeModel(bowl(), 'mm', 'z', null)
    // 1 mm steps keep the stair-steps on the sloped walls small for the volume check below.
    const plan = await buildLayeredPlan(placed, { ...settings, stepDown: 1, layers: 2 })
    expect(plan.layers.map((l) => [l.z0, l.z1])).toEqual([[23.5, 47], [0, 23.5]])
    expect(plan.splitTo).toBeNull()
    for (const l of plan.layers) {
      expect(l.plan.verticalShort).toBe(0)
      expect(l.plan.sides.some((s) => s.freeing)).toBe(true)
    }
    expect(plan.shapes.every((s) => /^Layer [12] · /.test(s.name))).toBe(true)
    // Glued back up, the boards' finished parts make the bowl.
    let v = 0
    for (const l of plan.layers) {
      const part = await buildFinishedPart(l.placed, l.plan, undefined, undefined, 300_000)
      const ix = part!.indices
      const p = part!.positions
      const tri = new Float32Array(ix.length * 3)
      for (let k = 0; k < ix.length; k++) tri.set(p.subarray(ix[k] * 3, ix[k] * 3 + 3), k * 3)
      v += volume(tri)
    }
    const model = volume(placed.positions)
    expect(v).toBeGreaterThan(model * 0.95)
    expect(v).toBeLessThan(model * 1.3)
  }, 60_000)
})
