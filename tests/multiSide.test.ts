import { describe, expect, it } from 'vitest'
import { analyzeSides, heightMap, rotateToSide } from '../src/features/carve3d/sideAnalysis'
import { autoStageBits, buildMultiSidePlan, buildStages, cutoutBit } from '../src/features/carve3d/multiSide'
import { buildCarvePlan, depthGrid, samplesPerLayer } from '../src/features/carve3d/carvePlan'
import { createMeshSlicer, sliceDetailed } from '../src/features/carve3d/slicer'
import { placeModel } from '../src/features/carve3d/loadModel'
import { BITS, coneHeight } from '../src/features/carve3d/bits'

/** Hemisphere of radius R on z=0 (closed with a base disc). */
function dome(R = 20, nu = 48, nv = 16): Float32Array {
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

/** Axis-aligned box as 12 outward triangles. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): Float32Array {
  const p = [
    [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
    [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
  ]
  const quads = [
    [0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7],
  ]
  const out: number[] = []
  for (const [a, b, c, d] of quads) for (const tri of [[a, b, c], [a, c, d]]) for (const i of tri) out.push(...p[i])
  return new Float32Array(out)
}

const placed = (raw: Float32Array) => placeModel(raw, 'mm', 'z', null)

describe('heightMap', () => {
  it('reads the top of a box everywhere under it', () => {
    const m = heightMap(placed(box(0, 0, 0, 10, 8, 4)), 1, 'max')
    expect(m.nx).toBeGreaterThan(1)
    let minH = Infinity
    for (let k = 0; k < m.h.length; k++) minH = Math.min(minH, m.h[k])
    expect(minH).toBeCloseTo(4, 5)
  })

  it('min mode reads the bottom of a sitting box as 0', () => {
    const m = heightMap(placed(box(0, 0, 0, 10, 8, 4)), 1, 'min')
    let maxH = -Infinity
    for (let k = 0; k < m.h.length; k++) maxH = Math.max(maxH, m.h[k])
    expect(maxH).toBeCloseTo(0, 5)
  })
})

describe('rotateToSide', () => {
  it('brings the chosen face up and re-normalises the placement', () => {
    const tall = placed(box(-1, -1.5, 0, 1, 1.5, 10)) // 2 × 3 × 10
    const right = rotateToSide(tall, 'right')
    expect(right.size.x).toBeCloseTo(10)
    expect(right.size.z).toBeCloseTo(2)
    expect(right.bbox.min.z).toBeCloseTo(0)
  })
})

describe('analyzeSides', () => {
  it('a dome: top only — a hill is fully exposed from above, sides would duplicate it', () => {
    const a = analyzeSides(placed(dome()), 1)
    expect(a.top.needed).toBe(true)
    // Closed columns only: the deepest is the silhouette ring, not the open corners.
    expect(a.top.cutDepth).toBeGreaterThan(10)
    expect(a.top.cutDepth).toBeLessThan(20)
    expect(a.bottom.needed).toBe(false) // the dome sits on the stock bottom
    for (const s of ['front', 'back', 'left', 'right'] as const) {
      expect(a[s].needed).toBe(false) // every side column is exposed from above or below
    }
  })

  it('a conical glass: cavity and cone from the top, the skirt under the base from the bottom', () => {
    // Outer cone widening upward (r 18 → 25 over z 0..10), cavity floor at z = 2.
    const glass = revolve([
      [0, 0], [18, 0], [25, 10], [14, 10], [0, 2],
    ])
    const a = analyzeSides(placed(glass), 1)
    expect(a.top.needed).toBe(true)
    expect(a.top.cutDepth).toBeGreaterThan(7.5) // down to the cavity floor
    expect(a.top.cutDepth).toBeLessThan(9.5)
    // The base overhangs its rim: the waste under the skirt is only reachable from below.
    expect(a.bottom.needed).toBe(true)
    expect(a.bottom.cutDepth).toBeGreaterThan(5)
    // The conical outside is fully exposed by the top's outline cuts — no side faces needed.
    for (const s of ['front', 'back', 'left', 'right'] as const) expect(a[s].needed).toBe(false)
  })

  it('a blind slot through the front face is claimed by the front — sides earn real overhangs', () => {
    // Two slabs with a back wall: an open slot (z 9..11) reachable only from the front.
    const mesh = new Float32Array([
      ...box(0, 0, 0, 20, 20, 9),
      ...box(0, 0, 11, 20, 20, 20),
      ...box(0, 10, 9, 20, 20, 11),
    ])
    const a = analyzeSides(placed(mesh), 1)
    expect(a.front.needed).toBe(true)
    expect(a.front.cutDepth).toBeGreaterThan(8) // deep to the back wall of the slot
    expect(a.back.needed).toBe(false) // the back wall is flush with the back face
    expect(a.top.needed).toBe(false) // both slabs are flush with top and bottom
    expect(a.bottom.needed).toBe(false)
    expect(a.left.needed).toBe(false)
    expect(a.right.needed).toBe(false)
  })

  it('a mushroom: the waste under the cap goes to the bottom face (one flip), not the sides', () => {
    // Cap r=10 from z 8..10 (flat top), stem r=3 from z 0..8.
    const mushroom = revolve([
      [0, 0], [3, 0], [3, 8], [10, 8], [10, 10], [0, 10], [0, 0],
    ])
    const a = analyzeSides(placed(mushroom), 1)
    expect(a.top.needed).toBe(false) // the cap top is flush with the stock top
    expect(a.bottom.needed).toBe(true)
    expect(a.bottom.cutDepth).toBeGreaterThan(7) // up to the cap underside
    for (const s of ['front', 'back', 'left', 'right'] as const) expect(a[s].needed).toBe(false)
  })
})

describe('buildStages', () => {
  const sel = { rough: 'SF1-8-16D', detail: 'SF1-8-6F3', engrave: 'SE1-2500-V60E' }
  const opts = { finishAllowance: 1, engraveDepth: 1.5, stepDown: 2 }
  const v60 = BITS.find((b) => b.sku === 'SE1-2500-V60E')!

  it('splits the depth: rough short, detail finishes the whole face, engrave on top of the finish', () => {
    const stages = buildStages(10, sel, opts)
    expect(stages.map((s) => s.role)).toEqual(['rough', 'detail', 'engrave'])
    expect(stages[0].depthFrom).toBe(0)
    expect(stages[0].depthTo).toBeCloseTo(9)
    // The rough pass leaves the finish allowance on the walls too.
    expect(stages[0].leave).toBeCloseTo(1)
    // The finishing pass covers the whole depth: the rough bit's big steps leave stairs, and it
    // cannot reach narrow features at all.
    expect(stages[1].depthFrom).toBe(0)
    expect(stages[1].depthTo).toBeCloseTo(10)
    expect(stages[1].leave).toBe(0)
    expect(stages[2].depthFrom).toBeCloseTo(10 - Math.min(1.5, coneHeight(v60)))
    expect(stages[2].depthTo).toBeCloseTo(10)
    // Roughing takes the coarse step-down of its own bit.
    expect(stages[0].stepDown).toBeGreaterThan(stages[1].stepDown)
  })

  it('without a finishing bit the rough pass goes all the way and leaves nothing', () => {
    const stages = buildStages(10, { ...sel, detail: null, engrave: null }, opts)
    expect(stages).toHaveLength(1)
    expect(stages[0].depthTo).toBeCloseTo(10)
    expect(stages[0].leave).toBe(0)
  })

  it('degrades gracefully: no bits, no stages; engrave-only still ends at the face depth', () => {
    expect(buildStages(10, { rough: null, detail: null, engrave: null }, opts)).toEqual([])
    const only = buildStages(10, { rough: null, detail: null, engrave: sel.engrave }, opts)
    expect(only).toHaveLength(1)
    expect(only[0].depthTo).toBeCloseTo(10)
  })

  it('shallow work skips pointless stages', () => {
    const stages = buildStages(0.8, sel, opts)
    expect(stages.every((s) => s.role !== 'rough')).toBe(true)
    expect(stages[stages.length - 1].depthTo).toBeCloseTo(0.8)
  })
})

const msSettings = (over: Partial<Parameters<typeof buildMultiSidePlan>[1]> = {}): Parameters<typeof buildMultiSidePlan>[1] => ({
  sides: ['top', 'bottom', 'left', 'right', 'front', 'back'],
  // The 8 mm-shank V-bit is long enough to engrave at the bottom of the dome's carve.
  bits: { rough: 'SF1-8-16D', detail: 'SF1-8-6F3', engrave: 'SF1-8-V60E' },
  finishAllowance: 1,
  engraveDepth: 1.5,
  stepDown: 5,
  margin: 10,
  stockThickness: 20,
  bridges: { count: 2, width: 5, height: 1 },
  outputs: { contour: false, toolpath: true, pocket: false },
  units: 'mm',
  key: 'test',
  ...over,
})

/** Two slabs with a back wall: a 10 mm deep slot (z 9..11) that only opens to the front. */
const slotted = () =>
  new Float32Array([...box(0, 0, 0, 20, 20, 9), ...box(0, 0, 11, 20, 20, 20), ...box(0, 10, 9, 20, 20, 11)])

/** Outward-widening cone with a cavity: the skirt under the rim is bottom work. */
const glass = () => revolve([[0, 0], [18, 0], [25, 10], [14, 10], [0, 2]])

describe('buildMultiSidePlan', () => {
  it('plans the needed faces in stages and cuts the part out once, with bridges', async () => {
    const plan = await buildMultiSidePlan(placed(dome()), msSettings())
    // A dome is a hill: the top face does all the work; the others are flush or exposed.
    expect(plan.sides.map((s) => s.side)).toEqual(['top'])
    const top = plan.sides[0]
    expect(top.stages.map((s) => s.role)).toEqual(['rough', 'detail', 'engrave', 'cutout'])
    expect(top.plans.length).toBe(top.stages.length)
    for (const p of top.plans.slice(0, -1)) expect(p.layers.length).toBeGreaterThan(0)
    // Every shape name carries its side, so the job packet reads per setup.
    for (const s of plan.shapes) expect(s.name.startsWith('Top · ')).toBe(true)
    // The carving stages never cut the outline; the cut-out stage does, through the whole block.
    for (const p of top.plans.slice(0, -1)) expect(p.throughCut).toBe(false)
    expect(top.freeing).toBe(true)
    const cut = top.plans[top.plans.length - 1]
    expect(cut.layers).toHaveLength(0)
    expect(cut.throughCut).toBe(true)
    expect(cut.throughDepth).toBeCloseTo(20)
    expect(cut.tabs?.bridges.length).toBe(2)
    expect(cut.tabs?.bridgeDepth).toBeCloseTo(19)
    // The cut-out takes the finer bit that reaches through the block.
    expect(cut.bit.id).toBe('SF1-8-6F3')
    // The outline is the silhouette: the dome's full 40 mm footprint, not a deep section of it.
    const xs = cut.outline.flatMap((c) => c.pts.map((p) => p.x))
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(39)
    // Outline-only job: the route must not ring-clear the block.
    expect(top.plans[0].rings).toBe(false)
    // No undercut warnings: the flip is the answer to them.
    expect(plan.warnings.some((w) => w.includes('undercuts'))).toBe(false)
    expect(plan.info.sides).toBe(1)
    expect(plan.info.bridges).toBe(2)
  })

  it('a flush vertical face still serves as the cut-out face', async () => {
    const plan = await buildMultiSidePlan(placed(dome()), msSettings({ sides: ['bottom'] }))
    expect(plan.sides).toHaveLength(1)
    expect(plan.sides[0].stages.map((s) => s.role)).toEqual(['cutout'])
    expect(plan.warnings.some((w) => w.includes('nothing to carve'))).toBe(false)
  })

  it('without a vertical face there is nothing to cut the part out with', async () => {
    const plan = await buildMultiSidePlan(placed(dome()), msSettings({ sides: ['left', 'right'] }))
    expect(plan.sides).toHaveLength(0)
    expect(plan.warnings.some((w) => w.includes('Top or Bottom'))).toBe(true)
  })

  it('side faces measure depth from the stock face, which sits the margin above the model', async () => {
    const plan = await buildMultiSidePlan(placed(slotted()), msSettings({ sides: ['top', 'front'], stepDown: 2 }))
    expect(plan.sides.map((s) => s.side)).toEqual(['top', 'front'])
    const front = plan.sides[1]
    expect(front.cutDepth).toBeCloseTo(10, 0) // the full slot, not a cell short of the back wall
    expect(front.faceOffset).toBe(10)
    const detail = front.plans[front.stages.findIndex((s) => s.role === 'detail')]
    // The plan top is the stock face; layers start below the model face and end at the slot floor.
    expect(detail.modelH).toBeCloseTo(front.placed.size.z + 10)
    expect(detail.layers[0].depth).toBeGreaterThan(10)
    expect(detail.layers[detail.layers.length - 1].depth).toBeCloseTo(20, 0)
    // At the slot depth the section is the two slabs: material above and below the slot.
    expect(detail.layers[0].guide.length).toBe(2)
    // The top face has no work of its own and only cuts the part out.
    expect(plan.sides[0].stages.map((s) => s.role)).toEqual(['cutout'])
  })

  it('stock thicker than the model moves the bottom stock face below the model', async () => {
    const plan = await buildMultiSidePlan(placed(glass()), msSettings({ sides: ['top', 'bottom'], stockThickness: 14 }))
    const bottom = plan.sides.find((s) => s.side === 'bottom')!
    expect(bottom.faceOffset).toBeCloseTo(4)
    expect(bottom.blockDepth).toBeCloseTo(14)
    // The bottom is the last vertical face, so it cuts the part out through the whole block.
    expect(bottom.freeing).toBe(true)
    expect(bottom.plans[bottom.plans.length - 1].throughDepth).toBeCloseTo(14)
    expect(plan.sides.find((s) => s.side === 'top')!.freeing).toBe(false)
  })

  it('no setup cuts through the bridges', async () => {
    const plan = await buildMultiSidePlan(placed(glass()), msSettings({ sides: ['top', 'bottom'], stepDown: 2, stockThickness: 10 }))
    const bottom = plan.sides.find((s) => s.side === 'bottom')!
    const top = plan.sides.find((s) => s.side === 'top')!
    const cut = bottom.plans[bottom.plans.length - 1]
    const tabs = cut.tabs!.bridges
    expect(tabs.length).toBe(2)
    // A point in the cut-out channel at each bridge, 5 mm outside the r = 25 rim. The bottom
    // frame mirrors y; in design space (y down) the top sees the point at (x, −y).
    const probes = tabs.map((t) => {
      const m = t.pts[Math.floor(t.pts.length / 2)]
      const r = Math.hypot(m.x, m.y)
      return { x: (m.x * (r + 5)) / r, y: (-m.y * (r + 5)) / r }
    })
    const inside = (cs: { pts: { x: number; y: number }[] }[], p: { x: number; y: number }) => {
      let n = 0
      for (const c of cs)
        for (let i = 0, j = c.pts.length - 1; i < c.pts.length; j = i++) {
          const a = c.pts[i]
          const b = c.pts[j]
          if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) n++
        }
      return n % 2 === 1
    }
    // The bridges sit at the top surface (the far side of the bottom cut-out): every top layer
    // must keep the bit centre off them, while away from the bridges the channel is cut.
    const detail = top.plans[top.stages.findIndex((s) => s.role === 'detail')]
    for (const layer of detail.layers) for (const p of probes) expect(inside(layer.toolpath, p)).toBe(true)
    const away = { x: -probes[0].y, y: probes[0].x } // a quarter turn on: between the two bridges
    expect(inside(detail.layers[0].toolpath, away)).toBe(false)
  })
})

describe('cutoutBit', () => {
  const sel = { rough: 'SF1-8-16D', detail: 'SF1-8-6F3', engrave: 'SE1-2500-V60E' }
  it('takes the finer straight bit that reaches through, else the deepest-reaching with a flag', () => {
    const through = cutoutBit(sel, 20)
    expect(through.reaches).toBe(true)
    expect(through.bit?.id).toBe('SF1-8-6F3')
    const tooDeep = cutoutBit(sel, 500)
    expect(tooDeep.reaches).toBe(false)
    expect(tooDeep.bit).not.toBeNull()
    expect(cutoutBit({ rough: null, detail: null, engrave: sel.engrave }, 10).bit).toBeNull()
  })
})

describe('carve plan startDepth', () => {
  const flat = { id: 't-flat', name: 'test flat', type: 'flat', diameter: 6.35, fluteLength: 30 } as Parameters<typeof buildCarvePlan>[2]['bit']
  it('only produces layers below the start depth, with the prefix on every name', async () => {
    const plan = await buildCarvePlan(dome(), 20, {
      bit: flat,
      stepDown: 4,
      stockThickness: 12,
      startDepth: 6,
      margin: 5,
      throughCut: false,
      outputs: { contour: false, toolpath: true, pocket: false },
      units: 'mm',
      labelPrefix: 'Top · Rough',
    })
    expect(plan.layers.map((l) => l.depth)).toEqual([10, 12])
    expect(plan.layers.every((l) => l.depth > 6)).toBe(true)
    for (const s of plan.shapes) expect(s.name.startsWith('Top · Rough · ')).toBe(true)
  })
})

describe('autoStageBits', () => {
  it('picks a big rougher, a finer detail bit and a V-bit', () => {
    const sel = autoStageBits()
    expect(sel.rough).toBeTruthy()
    expect(sel.detail).toBeTruthy()
    expect(sel.engrave).toBeTruthy()
    expect(sel.rough).not.toBe(sel.detail)
  })
})

describe('createMeshSlicer', () => {
  it('candidate pruning gives the same sections as full slicing', () => {
    const mesh = dome()
    const slicer = createMeshSlicer(mesh)
    for (const z of [0.5, 3, 11.3, 19.5]) {
      const fast = slicer.slice(z)
      const full = sliceDetailed(mesh, z)
      expect(fast.contours.length).toBe(full.contours.length)
      expect(fast.openChains).toBe(full.openChains)
      for (let i = 0; i < fast.contours.length; i++)
        expect(fast.contours[i].pts.length).toBe(full.contours[i].pts.length)
    }
  })
})

describe('samplesPerLayer cap', () => {
  it('honours the cap for V-bits and stays at 1 for flat bits', () => {
    const v60 = BITS.find((b) => b.sku === 'SE1-2500-V60E')!
    const flat = BITS.find((b) => b.type === 'flat')!
    expect(samplesPerLayer(v60, 1.5)).toBeGreaterThan(12)
    expect(samplesPerLayer(v60, 1.5, 12)).toBe(12)
    expect(samplesPerLayer(flat, 5, 12)).toBe(1)
  })
})

describe('shared slice cache', () => {
  const flat = { id: 't-flat', name: 'test flat', type: 'flat', diameter: 6.35, fluteLength: 30 } as Parameters<typeof buildCarvePlan>[2]['bit']
  const settings = {
    bit: flat,
    stepDown: 4,
    stockThickness: 12,
    margin: 5,
    throughCut: false,
    outputs: { contour: false, toolpath: true, pocket: false },
    units: 'mm',
  } as const
  it('a plan built from a pre-populated cache matches a plan that slices itself', async () => {
    const mesh = dome()
    const solo = await buildCarvePlan(mesh, 20, { ...settings })
    // Pre-slice at exactly the depths the plan will need (as the multi-side planner does).
    const shared = new Map()
    for (const d of depthGrid(12, 4, 1)) shared.set(Math.round(d * 1e6), createMeshSlicer(mesh).slice(20 - Math.max(d, 1e-4)))
    const withCache = await buildCarvePlan(mesh, 20, { ...settings }, undefined, undefined, { slices: shared })
    expect(withCache.layers.map((l) => l.depth)).toEqual(solo.layers.map((l) => l.depth))
    expect(withCache.layers.map((l) => l.contours)).toEqual(solo.layers.map((l) => l.contours))
  })
})

describe('splitTabs on an outline with a hole', () => {
  it('puts bridges on the outer boundary only: a hole is cut through whole', async () => {
    const { splitTabs } = await import('../src/features/carve3d/carvePlan')
    const sq = (r: number, ccw: boolean) => {
      const pts = [{ x: -r, y: -r }, { x: r, y: -r }, { x: r, y: r }, { x: -r, y: r }]
      return { closed: true, pts: ccw ? pts : pts.reverse() }
    }
    const { through, tabs } = splitTabs([sq(50, true), sq(30, false)], 2, 5)
    expect(tabs).toHaveLength(2)
    // Every bridge sits on the outer square.
    for (const t of tabs) for (const p of t.pts) expect(Math.max(Math.abs(p.x), Math.abs(p.y))).toBeCloseTo(50)
    // The hole comes back whole, as one closed through-cut.
    expect(through.some((c) => c.closed && c.pts.length === 4)).toBe(true)
  })
})
