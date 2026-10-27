// Box joint basic / pro, checked against Shaper Studio's own generators and shapes placed in a
// live Studio design (docs/research/box-joints-studio.md). Our frame is y-down with the board
// centred on (0,0): board top at y = -T/2. `sx` converts our x to Studio's 0..W frame.
import { beforeEach, describe, expect, it } from 'vitest'
import { boxJointGuides, boxJointPocket, clampBoxJoint, proSegments, scaleBoxJointParams } from '../src/geometry/boxJoints'
import { TEMPLATES } from '../src/geometry/templates'
import type { Contour, Shape } from '../src/model/types'
import { activeOrigin, newDoc, useStore } from '../src/state/store'
import { createTemplate } from '../src/editor/shapeFactory'
import { placeBoxJoint, stockAnchorWorld, setBoxJointAnchor, updateBoxJoint } from '../src/editor/boxJointGuides'
import { anchorPoint, resizeSelection, selectionBBox } from '../src/editor/ops'

const IN = 25.4

function bbox(cs: Contour[]) {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const c of cs)
    for (const p of c.pts) {
      b.minX = Math.min(b.minX, p.x)
      b.minY = Math.min(b.minY, p.y)
      b.maxX = Math.max(b.maxX, p.x)
      b.maxY = Math.max(b.maxY, p.y)
    }
  return b
}

const hasVertex = (cs: Contour[], x: number, y: number) => cs.some((c) => c.pts.some((p) => Math.abs(p.x - x) < 1e-6 && Math.abs(p.y - y) < 1e-6))

const basic = (o: Record<string, number> = {}) => ({ side: 0, length: 254, thickness: 19.05, bitDiameter: 8, fingers: 5, glueGap: 0, guides: 1, ...o })
const pro = (o: Record<string, number> = {}) => ({
  side: 0,
  length: 10 * IN,
  thickness: 0.75 * IN,
  bitDiameter: 0.25 * IN,
  fingers: 5,
  pinFactor: -0.75,
  glueGap: 0,
  guides: 1,
  ...o,
})

describe('box joint basic (Studio buildPocketModel$1)', () => {
  const W = 254
  const T = 19.05
  const sx = (x: number) => x + W / 2

  it('side A: pocket over pins 1..3, pin tops r above, floor r below, channel 2·bit under', () => {
    const cs = boxJointPocket('basic', basic())
    expect(cs).toHaveLength(1)
    expect(cs[0].closed).toBe(true)
    const b = bbox(cs)
    expect(sx(b.minX)).toBeCloseTo(50.8, 6)
    expect(sx(b.maxX)).toBeCloseTo(203.2, 6)
    expect(b.minY).toBeCloseTo(-T / 2 - 4, 6) // pin tops 4 above the board top
    expect(b.maxY).toBeCloseTo(T / 2 + 4 + 16, 6) // channel 16 below the floor
    // The floor between the removed pins sits 4 below the board bottom, with sharp (concave) corners.
    expect(hasVertex(cs, 101.6 - W / 2, T / 2 + 4)).toBe(true)
    expect(hasVertex(cs, 152.4 - W / 2, T / 2 + 4)).toBe(true)
    // Convex corners are filleted with radius 4: the tangent points sit 4 in from the corner.
    expect(hasVertex(cs, 50.8 - W / 2, -T / 2)).toBe(true)
    expect(hasVertex(cs, 50.8 + 4 - W / 2, -T / 2 - 4)).toBe(true)
    expect(hasVertex(cs, 50.8 - W / 2, -T / 2 - 4)).toBe(false)
  })

  it('side A guides: pins 0, 2, 4, each 50.8 × 19.05 with an "A" 9.525 tall', () => {
    const g = boxJointGuides('basic', basic())
    expect(g.map((x) => x.pin)).toEqual([0, 2, 4])
    for (const x of g) {
      const r = bbox([x.rect])
      expect(r.maxX - r.minX).toBeCloseTo(50.8, 6)
      expect(r.maxY - r.minY).toBeCloseTo(19.05, 6)
      expect(sx(r.minX)).toBeCloseTo(x.pin * 50.8, 6)
      expect(r.minY).toBeCloseTo(-T / 2, 6)
      const l = bbox([x.letter])
      expect(l.maxY - l.minY).toBeCloseTo(9.525, 6)
      expect(l.maxX - l.minX).toBeCloseTo((9.525 * 50) / 80, 6)
      // Centred in the pin box.
      expect((l.minX + l.maxX) / 2).toBeCloseTo((r.minX + r.maxX) / 2, 6)
      expect((l.minY + l.maxY) / 2).toBeCloseTo(0, 6)
      // Open polyline with the closing point repeated: Studio's 7-point A.
      expect(x.letter.closed).toBe(false)
      expect(x.letter.pts).toHaveLength(7)
      // The apex is at the top (y-down: smallest y).
      expect(x.letter.pts[4].y).toBeCloseTo(l.minY, 6)
    }
  })

  it('side B: pocket spans the full width removing pins 0, 2, 4; guides on pins 1, 3 with "B"', () => {
    const p = basic({ side: 1 })
    const b = bbox(boxJointPocket('basic', p))
    expect(sx(b.minX)).toBeCloseTo(0, 6)
    expect(sx(b.maxX)).toBeCloseTo(254, 6)
    const g = boxJointGuides('basic', p)
    expect(g.map((x) => x.pin)).toEqual([1, 3])
    expect(g[0].letter.pts).toHaveLength(12) // Studio's B
  })

  it('even pin count: side A removes 1, 3 (to the right edge), side B removes 0, 2', () => {
    const a = bbox(boxJointPocket('basic', basic({ fingers: 4 })))
    expect(sx(a.minX)).toBeCloseTo(63.5, 6)
    expect(sx(a.maxX)).toBeCloseTo(254, 6)
    expect(boxJointGuides('basic', basic({ fingers: 4 })).map((x) => x.pin)).toEqual([0, 2])
    const b = bbox(boxJointPocket('basic', basic({ fingers: 4, side: 1 })))
    expect(sx(b.minX)).toBeCloseTo(0, 6)
    expect(sx(b.maxX)).toBeCloseTo(190.5, 6)
    expect(boxJointGuides('basic', basic({ fingers: 4, side: 1 })).map((x) => x.pin)).toEqual([1, 3])
  })

  it('glue gap widens each removed pin by gap/2 per side; guides keep the nominal pins', () => {
    const cs = boxJointPocket('basic', basic({ glueGap: 2 }))
    const b = bbox(cs)
    expect(sx(b.minX)).toBeCloseTo(50.8 - 1, 6)
    expect(sx(b.maxX)).toBeCloseTo(203.2 + 1, 6)
    expect(hasVertex(cs, 101.6 + 1 - W / 2, T / 2 + 4)).toBe(true)
    expect(hasVertex(cs, 152.4 - 1 - W / 2, T / 2 + 4)).toBe(true)
    const g = bbox([boxJointGuides('basic', basic({ glueGap: 2 }))[0].rect])
    expect(g.maxX - g.minX).toBeCloseTo(50.8, 6)
  })

  it('hidden guides: no guide paths at all', () => {
    expect(boxJointGuides('basic', basic({ guides: 0 }))).toEqual([])
    expect(boxJointGuides('pro', pro({ guides: 0 }))).toEqual([])
  })
})

describe('box joint pro (Studio computeSegments + buildPocketModel)', () => {
  const W = 10 * IN
  const T = 0.75 * IN
  const sx = (x: number) => (x + W / 2) / IN

  it('default inch widths', () => {
    const { widths, bounds } = proSegments(W, 5, 0.25 * IN, -0.75)
    const want = [0.70625, 3.940625, 0.70625, 3.940625, 0.70625]
    widths.forEach((w, i) => expect(w / IN).toBeCloseTo(want[i], 9))
    const left = [0, 0.70625, 4.646875, 5.353125, 9.29375]
    bounds.forEach((x, i) => expect(x / IN).toBeCloseTo(left[i], 9))
    expect(widths.reduce((a, b) => a + b, 0)).toBeCloseTo(W, 9)
  })

  it('defaults (inches): pocket .70625 → 9.29375, pin tops .125 above, channel .5 under the floor', () => {
    const cs = boxJointPocket('pro', pro())
    const b = bbox(cs)
    expect(sx(b.minX)).toBeCloseTo(0.70625, 9)
    expect(sx(b.maxX)).toBeCloseTo(9.29375, 9)
    expect((b.minY + T / 2) / IN).toBeCloseTo(-0.125, 9)
    expect((b.maxY - T / 2) / IN).toBeCloseTo(0.125 + 0.5, 9)
    // Floor between pins 1 and 3 (over pin 2), r below the board bottom.
    expect(hasVertex(cs, 4.646875 * IN - W / 2, T / 2 + 0.125 * IN)).toBe(true)
    expect(hasVertex(cs, 5.353125 * IN - W / 2, T / 2 + 0.125 * IN)).toBe(true)
  })

  it('defaults guides: 3 boxes .70625 × .75 at x 0, 4.646875, 9.29375', () => {
    const g = boxJointGuides('pro', pro())
    expect(g.map((x) => x.pin)).toEqual([0, 2, 4])
    const xs = [0, 4.646875, 9.29375]
    g.forEach((x, i) => {
      const r = bbox([x.rect])
      expect(sx(r.minX)).toBeCloseTo(xs[i], 9)
      expect((r.maxX - r.minX) / IN).toBeCloseTo(0.70625, 9)
      expect((r.maxY - r.minY) / IN).toBeCloseTo(0.75, 9)
      const l = bbox([x.letter])
      expect((l.maxY - l.minY) / IN).toBeCloseTo(0.70625 / 2, 9)
    })
  })

  it('ratio 0 gives equal pins; ratio +1 makes the odd-index pins 1.1·bit', () => {
    const bit = 0.25 * IN
    for (const w of proSegments(W, 5, bit, 0).widths) expect(w).toBeCloseTo(W / 5, 9)
    const one = proSegments(W, 5, bit, 1).widths
    expect(one[1]).toBeCloseTo(1.1 * bit, 9)
    expect(one[3]).toBeCloseTo(1.1 * bit, 9)
    expect(one[0]).toBeCloseTo((W - 2 * 1.1 * bit) / 3, 9)
    const minus = proSegments(W, 5, bit, -1).widths
    expect(minus[0]).toBeCloseTo(1.1 * bit, 9)
  })

  it('glue gap widens each removed pin by gap/2 per side', () => {
    const gap = 0.05 * IN
    const b = bbox(boxJointPocket('pro', pro({ glueGap: gap })))
    expect(sx(b.minX)).toBeCloseTo(0.70625 - 0.025, 9)
    expect(sx(b.maxX)).toBeCloseTo(9.29375 + 0.025, 9)
  })

  it('side B removes pins 0, 2, 4 with guides on 1, 3', () => {
    const b = bbox(boxJointPocket('pro', pro({ side: 1 })))
    expect(sx(b.minX)).toBeCloseTo(0, 9)
    expect(sx(b.maxX)).toBeCloseTo(10, 9)
    expect(boxJointGuides('pro', pro({ side: 1 })).map((x) => x.pin)).toEqual([1, 3])
  })
})

describe('box joint clamping (Studio validation)', () => {
  it('pin count: max floor(W / (bit·1.1)), min 2, rounded', () => {
    expect(clampBoxJoint('basic', pro({ fingers: 99 }), 'in').fingers).toBe(36)
    expect(clampBoxJoint('pro', pro({ fingers: 99 }), 'in').fingers).toBe(36)
    expect(clampBoxJoint('basic', pro({ fingers: 1 }), 'in').fingers).toBe(2)
    expect(clampBoxJoint('basic', pro({ fingers: 4.6 }), 'in').fingers).toBe(5)
  })

  it('bit diameter at most the thickness', () => {
    const v = clampBoxJoint('basic', pro({ bitDiameter: 30 }), 'in')
    expect(v.bitDiameter).toBeCloseTo(0.75 * IN, 9)
    // …and the pin count is re-validated against the new bit.
    expect(clampBoxJoint('basic', pro({ bitDiameter: 30, fingers: 20 }), 'in').fingers).toBe(Math.floor(254 / (19.05 * 1.1)))
  })

  it('glue gap: basic below W/N, pro below (W − 1.1·bit·N)/(N − 1)', () => {
    const b = clampBoxJoint('basic', pro({ glueGap: 1000 }), 'in')
    expect(b.glueGap).toBeCloseTo(254 / 5 - 1e-6 * IN, 9)
    const p = clampBoxJoint('pro', pro({ glueGap: 1000 }), 'in')
    expect(p.glueGap).toBeCloseTo((254 - 6.35 * 1.1 * 5) / 4 - 1e-6 * IN, 9)
    expect(clampBoxJoint('pro', pro({ glueGap: -3 }), 'in').glueGap).toBe(0)
  })

  it('pin factor within [-1, 1]; sizes at least MIN_SIZE', () => {
    expect(clampBoxJoint('pro', pro({ pinFactor: 3 }), 'in').pinFactor).toBe(1)
    expect(clampBoxJoint('pro', pro({ pinFactor: -3 }), 'in').pinFactor).toBe(-1)
    expect(clampBoxJoint('basic', basic({ thickness: -1 }), 'mm').thickness).toBeCloseTo(0.005, 9)
    expect(clampBoxJoint('basic', basic({ length: 0 }), 'in').length).toBeCloseTo(0.005 * IN, 9)
  })

  it('scaling: bit never scales; uniform scales W, T, gap; otherwise W, gap by x and T by y', () => {
    const u = scaleBoxJointParams(basic({ glueGap: 1 }), 2, 2)
    expect([u.length, u.thickness, u.glueGap, u.bitDiameter]).toEqual([508, 38.1, 2, 8])
    const n = scaleBoxJointParams(basic({ glueGap: 1 }), 2, 3)
    expect([n.length, n.thickness, n.glueGap, n.bitDiameter]).toEqual([508, 19.05 * 3, 2, 8])
  })
})

describe('box joint templates', () => {
  it('panel order and pin factor slider', () => {
    const b = TEMPLATES.find((t) => t.id === 'boxJointBasic')!
    const p = TEMPLATES.find((t) => t.id === 'boxJointPro')!
    expect(b.params.map((q) => q.key)).toEqual(['side', 'length', 'thickness', 'bitDiameter', 'fingers', 'glueGap', 'guides'])
    expect(p.params.map((q) => q.key)).toEqual(['side', 'length', 'thickness', 'bitDiameter', 'fingers', 'pinFactor', 'glueGap', 'guides'])
    expect(p.params.map((q) => q.label)).toEqual(['side', 'width', 'thickness', 'bit diameter', 'pin count', 'pin factor', 'glue gap', 'show guides'])
    const f = p.params.find((q) => q.key === 'pinFactor')!
    expect([f.kind, f.min, f.max, f.step, f.default]).toEqual(['slider', -1, 1, 0.05, -0.75])
    expect(f.marks).toEqual([0])
  })

  it('defaults follow the document units', () => {
    const bi = createTemplate('boxJointBasic', 0, 0, 'in')!
    expect([bi.params!.length, bi.params!.thickness, bi.params!.bitDiameter, bi.params!.fingers]).toEqual([254, 19.05, 6.35, 5])
    const bm = createTemplate('boxJointBasic', 0, 0, 'mm')!
    expect([bm.params!.length, bm.params!.thickness, bm.params!.bitDiameter]).toEqual([200, 20, 6])
    const pm = createTemplate('boxJointPro', 0, 0, 'mm')!
    expect([pm.params!.length, pm.params!.thickness, pm.params!.bitDiameter, pm.params!.pinFactor]).toEqual([200, 19.05, 6, -0.75])
    // Inside cut with Studio's 1/4 in pocket tool (whatever the bit param); the board stays centred on the origin.
    expect(pm.cut.type).toBe('inside')
    expect(pm.cut.bitDia).toBe(6.35)
    expect(bbox(pm.contours).minX).toBeCloseTo(-100 + proSegments(200, 5, 6, -0.75).widths[0], 6)
  })
})

describe('box joint in the editor', () => {
  beforeEach(() => useStore.getState().setDoc(newDoc('t')))

  const place = (id: string) => {
    const s = createTemplate(id, 100, 50, useStore.getState().doc.units)!
    placeBoxJoint(s)
    return useStore.getState().doc.shapes.find((x) => x.meta?.role === 'outline')!
  }
  const outline = () => useStore.getState().doc.shapes.find((x) => x.meta?.role === 'outline')!
  const guides = () => useStore.getState().doc.shapes.filter((x) => x.meta?.role === 'guide')
  const labels = () => useStore.getState().doc.shapes.filter((x) => x.meta?.role === 'guideLabel')
  const anchorWorld = () => {
    const { doc, selection } = useStore.getState()
    const sel = doc.shapes.filter((s) => selection.includes(s.id))
    return anchorPoint(selectionBBox(sel)!, activeOrigin(doc, selection)!)
  }
  const stockTopLeft = (o: Shape) => ({ x: o.x - Number(o.params!.length) / 2, y: o.y - Number(o.params!.thickness) / 2 })

  for (const id of ['boxJointBasic', 'boxJointPro']) {
    it(`${id}: placed as a group with guides on the kept pins, anchored at the stock top-left`, () => {
      const o = place(id)
      expect(guides()).toHaveLength(3)
      expect(labels()).toHaveLength(3)
      expect(guides().every((g) => g.cut.type === 'guide' && g.groupId === o.groupId)).toBe(true)
      expect(useStore.getState().selection).toHaveLength(7)
      const a = anchorWorld()
      const want = stockTopLeft(o)
      expect(a.x).toBeCloseTo(want.x, 6)
      expect(a.y).toBeCloseTo(want.y, 6)
    })

    it(`${id}: side, guides and pin count re-sync the guides and keep the anchor on the stock`, () => {
      const o = place(id)
      updateBoxJoint(o.id, { side: 1 })
      expect(guides()).toHaveLength(2)
      expect(labels().every((l) => l.name === 'B')).toBe(true)
      // Still one group selected, the anchor still on the stock's top-left corner.
      expect(useStore.getState().selection).toHaveLength(5)
      let a = anchorWorld()
      expect(a.x).toBeCloseTo(stockTopLeft(outline()).x, 6)
      expect(a.y).toBeCloseTo(stockTopLeft(outline()).y, 6)
      updateBoxJoint(o.id, { guides: 0 })
      expect(guides()).toHaveLength(0)
      expect(labels()).toHaveLength(0)
      a = anchorWorld()
      expect(a.x).toBeCloseTo(stockTopLeft(outline()).x, 6)
      updateBoxJoint(o.id, { guides: 1, fingers: 99 })
      // Clamped to floor(W / 1.1·bit) in the panel's value.
      const n = Number(outline().params!.fingers)
      expect(n).toBe(Math.floor(Number(outline().params!.length) / (Number(outline().params!.bitDiameter) * 1.1)))
      expect(guides()).toHaveLength(Math.floor(n / 2)) // side B keeps the odd pins
      // The pocket's tool stays at 1/4 in when the bit diameter param changes (as in Studio).
      updateBoxJoint(o.id, { bitDiameter: 3 })
      expect(outline().params!.bitDiameter).toBe(3)
      expect(outline().cut.bitDia).toBe(6.35)
      // Undo restores the earlier guides with the whole group still selected.
      useStore.getState().undo()
      const { doc, selection } = useStore.getState()
      expect(selection.length).toBe(doc.shapes.filter((s) => s.groupId === o.groupId).length)
    })

    it(`${id}: stock anchors`, () => {
      const o = place(id)
      setBoxJointAnchor(o.id, 'stock-center')
      let a = anchorWorld()
      expect(a.x).toBeCloseTo(outline().x, 6)
      expect(a.y).toBeCloseTo(outline().y, 6)
      setBoxJointAnchor(o.id, 'stock-bottom-right')
      updateBoxJoint(o.id, { side: 1 })
      a = anchorWorld()
      const w = stockAnchorWorld(outline(), 'stock-bottom-right')
      expect(a.x).toBeCloseTo(w.x, 6)
      expect(a.y).toBeCloseTo(w.y, 6)
    })

    it(`${id}: resizing goes into the params (never stretched); the bit stays`, () => {
      const o = place(id)
      const ids = useStore.getState().selection
      const b = selectionBBox(useStore.getState().doc.shapes)!
      resizeSelection(ids, (b.maxX - b.minX) * 0.5, null, 'tl')
      const s = outline()
      expect(s.sx).toBe(1)
      expect(s.sy).toBe(1)
      expect(Number(s.params!.length)).toBeCloseTo(Number(o.params!.length) * 0.5, 6)
      expect(Number(s.params!.thickness)).toBeCloseTo(Number(o.params!.thickness), 6)
      expect(s.params!.bitDiameter).toBe(o.params!.bitDiameter)
      expect(s.kind).toBe('template')
      expect(guides()).toHaveLength(3)
      const g = bbox([guides()[0].contours[0]])
      expect(g.maxY - g.minY).toBeCloseTo(Number(o.params!.thickness), 6)
    })
  }
})
