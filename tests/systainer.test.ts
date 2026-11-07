import { describe, expect, it } from 'vitest'
import { getItem, ITEMS, itemParams } from '../src/features/systainer/catalog'
import { defaultLayout, evaluate, FIT_CLEARANCE, insertShapes, insertThickness, posed, SHAPER_FOAM, type Layout, type Placed } from '../src/features/systainer/layout'
import { baseDepth, insertOutline, lidZ, SYS_FLOOR } from '../src/features/systainer/systainerModel'
import { boolean, signedArea, unionNonZero } from '../src/geometry/offset'

const place = (item: string, x: number, y: number, extra: Partial<Placed> = {}): Placed => ({ uid: `${item}@${x},${y}`, item, x, y, rot: 0, pose: 0, depth: null, ...extra })
const layout = (items: Placed[], patch: Partial<Layout> = {}): Layout => ({ ...defaultLayout(), ...patch, items })
const area = (cs: { pts: { x: number; y: number }[] }[]) => Math.abs(cs.reduce((a, c) => a + signedArea(c.pts), 0))
const bbox = (cs: { pts: { x: number; y: number }[] }[]) => {
  const pts = cs.flatMap((c) => c.pts)
  return { w: Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x)), h: Math.max(...pts.map((p) => p.y)) - Math.min(...pts.map((p) => p.y)) }
}

describe('systainer insert', () => {
  it('uses the ShaperHub T-Loc foam outline', () => {
    const b = bbox([insertOutline()])
    expect(b.w).toBeCloseTo(387.5, 0)
    expect(b.h).toBeCloseTo(284, 0)
    // SYS 1 base: floor to rim.
    expect(baseDepth(1)).toBeCloseTo(66.7, 6)
    expect(insertThickness({ size: 2, thickness: null })).toBe(SHAPER_FOAM)
    expect(insertThickness({ size: 1, thickness: 500 })).toBeCloseTo(lidZ(1) - SYS_FLOOR, 6)
  })

  it('every catalogue item builds, poses and casts a footprint', () => {
    for (const def of ITEMS)
      for (let i = 0; i < def.poses.length; i++) {
        const p = posed(def, i, itemParams(def))
        expect(p.height, `${def.id} pose ${i}`).toBeGreaterThan(0)
        expect(p.w * p.d, `${def.id} pose ${i}`).toBeGreaterThan(1)
      }
  })

  it('a custom box pockets to its size plus the fit clearance, flush with the foam', () => {
    const ev = evaluate(layout([place('custom-box', 0, 0, { params: { w: 100, d: 60, h: 30 } })], { fit: 'standard' }))
    const e = ev.items[0]
    expect(e.sink).toBeCloseTo(30, 3)
    expect(e.above).toBeCloseTo(0, 3)
    expect(e.pockets).toHaveLength(1)
    const c = FIT_CLEARANCE.standard
    const b = bbox(e.pockets[0].contours)
    expect(b.w).toBeCloseTo(100 + 2 * c, 1)
    expect(b.h).toBeCloseTo(60 + 2 * c, 1)
    expect(e.problems).toEqual([])
  })

  it('turning an item turns its pocket', () => {
    const ev = evaluate(layout([place('custom-box', 0, 0, { rot: 90, params: { w: 100, d: 60, h: 30 } })], { fit: 'standard' }))
    const b = bbox(ev.items[0].pockets[0].contours)
    expect(b.w).toBeCloseTo(60, 1)
    expect(b.h).toBeCloseTo(100, 1)
  })

  it('flipping the support arm mirrors its footprint', () => {
    const a = evaluate(layout([place('ws-support-arm', 0, 0, { pose: 0 })], { fit: 'standard' })).items[0].pockets.at(-1)!.contours
    const b = evaluate(layout([place('ws-support-arm', 0, 0, { pose: 1 })], { fit: 'standard' })).items[0].pockets.at(-1)!.contours
    const mirrored = b.map((c) => ({ closed: true, pts: c.pts.map((p) => ({ x: p.x, y: -p.y })) }))
    expect(area(boolean('xor', a, mirrored))).toBeLessThan(area(a) * 0.02)
    // Not the same shape unflipped: the L points the other way.
    expect(area(boolean('xor', a, b))).toBeGreaterThan(area(a) * 0.2)
  })

  it('steps the pocket where an item rests on two levels, at the hub inserts’ depths', () => {
    // Collet, nose down: Ø12 hole 19 mm deep inside a Ø21 ring 8 mm deep.
    const c = evaluate(layout([place('collet', 0, 0)], { fit: 'standard' })).items[0]
    expect(c.pockets.map((p) => +p.depth.toFixed(1))).toEqual([19, 8])
    expect(bbox(c.pockets[0].contours).w).toBeCloseTo(11, 0)
    expect(bbox(c.pockets[1].contours).w).toBeCloseTo(20, 0)
    // Angle Fence knob, screw down: Ø8 hole 28 deep in a Ø19 ring 13 deep.
    const k = evaluate(layout([place('ws-lock-screw', 0, 0)], { fit: 'standard' })).items[0]
    expect(k.pockets.map((p) => +p.depth.toFixed(1))).toEqual([28, 13])
    expect(area(k.pockets[0].contours)).toBeLessThan(area(k.pockets[1].contours) * 0.25)
  })

  it('models the hub tools at their traced sizes', () => {
    const size = (id: string, pose = 0) => {
      const def = getItem(id)!
      const p = posed(def, pose, itemParams(def))
      return [+p.w.toFixed(0), +p.d.toFixed(0), +p.height.toFixed(1)]
    }
    expect(size('ws-support-arm')).toEqual([187, 76, 12.5])
    expect(size('ws-angle-fence')).toEqual([160, 49, 9.5])
    expect(size('collet-wrench')).toEqual([169, 43, 6.5])
    expect(size('shapertape')).toEqual([79, 79, 19])
    expect(size('usb-gen1')).toEqual([42, 12, 4.5])
    // Standing, the support arm requests 50 mm; stock foam preserves the minimum floor instead.
    const ev = evaluate(layout([place('ws-support-arm', 0, 0, { pose: 2 })]))
    expect(ev.items[0].sink).toBeCloseTo(ev.maxDepth, 6)
  })

  it('uses the requested stepped default depths from the foam surface', () => {
    const ev = evaluate(layout([place('ws-t-wrench', 0, 0), place('ws-clamp', 0, 0)]))
    const key = ev.items[0]
    const clamp = ev.items[1]
    expect(key.pockets.map((p) => +p.depth.toFixed(1))).toEqual([8, 4])
    // The knob is 28 mm down; both the bolt channel and clamp arm are 20 mm down.
    expect(clamp.pockets.map((p) => +p.depth.toFixed(1))).toEqual([28, 20])
  })

  it('keeps default and manually set depths relative to the foam surface', () => {
    const items = [place('ws-support-arm', 0, 0), place('custom-box', 50, 0, { params: { w: 20, d: 20, h: 10 }, depth: 6 })]
    const thin = evaluate(layout(items, { thickness: 40 }))
    const thick = evaluate(layout(items, { thickness: 60 }))
    expect(thin.items.map((e) => e.sink)).toEqual([13, 6])
    expect(thick.items.map((e) => e.sink)).toEqual([13, 6])
    expect(thick.foamTop - thin.foamTop).toBeCloseTo(20, 6)
  })

  it('keeps a foam post in the tape roll core', () => {
    const e = evaluate(layout([place('shapertape', 0, 0)])).items[0]
    expect(e.pockets[0].contours.length).toBe(2)
  })

  it('upright bits sink deep enough for the lid to close', () => {
    const ev = evaluate(layout([place('bit-SE1-2500-1000C', 0, 0)]))
    const e = ev.items[0]
    expect(e.above).toBeLessThanOrEqual(ev.lidRoom)
    expect(e.problems).toEqual([])
  })

  it('flags overlaps, the wall and the lid', () => {
    const ev = evaluate(
      layout([
        place('custom-box', 0, 0, { params: { w: 80, d: 80, h: 20 } }),
        place('custom-box', 40, 0, { params: { w: 80, d: 80, h: 20 } }),
        place('custom-box', 185, 0, { params: { w: 40, d: 40, h: 20 } }),
        place('custom-box', 0, 100, { params: { w: 40, d: 40, h: 200 }, depth: 10 }),
      ]),
    )
    expect(ev.items[0].problems).toContain('Overlaps box.')
    expect(ev.items[2].problems).toContain('Runs into the Systainer wall.')
    expect(ev.items[3].problems.some((p) => p.includes('lid won’t close'))).toBe(true)
  })

  it('a thumb notch cuts as deep as the pocket it overlaps', () => {
    const ev = evaluate(layout([place('custom-box', 0, 0, { params: { w: 80, d: 40, h: 25 } }), place('thumb-notch', 40, 0)]))
    expect(ev.items[1].sink).toBeCloseTo(25, 3)
    expect(ev.items[1].problems).toEqual([])
  })

  it('exports the outline as an outside cut and every pocket at its depth', () => {
    const l = layout([place('custom-box', 0, 0, { params: { w: 100, d: 60, h: 30 } }), place('ws-angle-fence', 120, 0)])
    const ev = evaluate(l)
    const shapes = insertShapes(ev, l, 'mm')
    expect(shapes[0].cut).toMatchObject({ type: 'outside', depth: ev.thickness })
    const pockets = shapes.slice(1)
    expect(pockets).toHaveLength(ev.pockets.length)
    for (const s of pockets) expect(s.cut.type).toBe('pocket')
    expect(pockets.map((s) => s.cut.depth)).toEqual(ev.pockets.map((p) => +p.depth.toFixed(2)))
    // Canvas y runs down: the back of the Systainer (y > 0) ends up at the top.
    const outlineYs = shapes[0].contours[0].pts.map((p) => p.y + shapes[0].y)
    expect(Math.min(...outlineYs)).toBeCloseTo(-143.9, 1)
  })

  it('pockets of one item union cleanly for the foam (nested steps never cancel)', () => {
    const ev = evaluate(layout([place('ws-lock-screw', 0, 0)]))
    expect(ev.items[0].pockets.length).toBeGreaterThan(1)
    const holes = unionNonZero(ev.pockets.flatMap((p) => p.contours))
    expect(area(holes)).toBeCloseTo(area(ev.items[0].pockets.at(-1)!.contours), -1)
  })

  it('knows every item id it lists', () => {
    for (const def of ITEMS) expect(getItem(def.id)).toBe(def)
  })
})
