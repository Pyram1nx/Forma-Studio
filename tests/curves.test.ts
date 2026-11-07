import { describe, expect, it } from 'vitest'
import type { Contour, Pt } from '../src/model/types'
import { createBasic, paramGeometry, withParams } from '../src/editor/shapeFactory'
import { TEMPLATES } from '../src/geometry/templates'
import { flattenPen, penOf } from '../src/geometry/pen'
import { penBounds } from '../src/geometry/curves'
import { boxJointKind } from '../src/geometry/boxJoints'
import { parseDoc, serialize } from '../src/io/projectFile'
import { exportSVG } from '../src/io/svgExport'
import { newDoc as emptyDoc } from '../src/state/store'
import { bake } from '../src/geometry/transform'

const segDist = (p: Pt, a: Pt, b: Pt) => {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y)
}
/** Largest distance from any point of `from` to the polylines `to`. */
const maxDev = (from: Contour[], to: Contour[]) => {
  let worst = 0
  for (const c of from)
    for (const p of c.pts) {
      let best = Infinity
      for (const d of to) for (let i = 0; i < d.pts.length; i++) best = Math.min(best, segDist(p, d.pts[i], d.pts[(i + 1) % d.pts.length]))
      worst = Math.max(worst, best)
    }
  return worst
}

describe('make shapes are true curves', () => {
  it('a circle is four cubic arcs on the circle', () => {
    const s = createBasic('circle', 0, 0)
    const pen = penOf(s)!
    expect(pen).toBeTruthy()
    expect(pen[0].nodes).toHaveLength(4)
    expect(pen[0].nodes.every((n) => n.in && n.out && n.smooth)).toBe(true)
    const r = 25.4 / 2
    for (const p of s.contours[0].pts) expect(Math.abs(Math.hypot(p.x, p.y) - r)).toBeLessThan(0.01)
    const b = penBounds(pen)
    expect(b.maxX - b.minX).toBeCloseTo(25.4, 6)
  })

  it('an ellipse and a rounded rectangle are curves with exact bounds', () => {
    const e = penOf(createBasic('ellipse', 0, 0))!
    expect(e[0].nodes).toHaveLength(4)
    const rr = createBasic('roundrect', 0, 0)
    const pen = penOf(rr)!
    // Four corner arcs, joined by four straight edges.
    expect(pen[0].nodes).toHaveLength(8)
    const b = penBounds(pen)
    expect(b.maxX - b.minX).toBeCloseTo(25.4, 6)
    expect(b.maxY - b.minY).toBeCloseTo(25.4, 6)
  })

  it('rounded polygon corners are arcs and the shape stays centred', () => {
    const t = withParams(createBasic('triangle', 0, 0), { ...createBasic('triangle', 0, 0).params!, r: 3 })
    const pen = penOf(t)!
    // Three corner arcs (each 120 degrees, so two cubics apiece) and three straight edges.
    expect(pen[0].nodes.length).toBe(9)
    const b = penBounds(pen)
    expect((b.minX + b.maxX) / 2).toBeCloseTo(0, 6)
    expect((b.minY + b.maxY) / 2).toBeCloseTo(0, 6)
  })

  it('the default heart is a handful of curves that follow the Studio outline', () => {
    const t = TEMPLATES.find((x) => x.id === 'heart')!
    const pen = t.buildPen!({})!
    expect(pen[0].nodes.length).toBeLessThan(12)
    const flat = pen.map((pc) => flattenPen(pc))
    const ref = t.build({})
    expect(maxDev(ref, flat)).toBeLessThan(0.02)
    expect(maxDev(flat, ref)).toBeLessThan(0.02)
  })

  for (const t of TEMPLATES) {
    if (boxJointKind(t.id)) continue
    it(`template ${t.id} keeps its outline as curves`, () => {
      const params = { template: t.id, ...Object.fromEntries(t.params.map((q) => [q.key, q.default])) }
      const g = paramGeometry('template', params)!
      expect(g.pen).toBeTruthy()
      expect(penOf({ pen: g.pen, contours: g.contours })).toBeTruthy()
      const ref = t.build(Object.fromEntries(t.params.map((q) => [q.key, q.default])))
      // The curves sit on the true arcs, which bow up to the old sampling's chord error away from its edges.
      expect(maxDev(g.contours, ref)).toBeLessThan(0.05)
      expect(maxDev(ref, g.contours)).toBeLessThan(0.05)
      // Never more nodes than the polyline had points.
      const nodes = g.pen!.reduce((n, pc) => n + pc.nodes.length, 0)
      expect(nodes).toBeLessThanOrEqual(ref.reduce((n, c) => n + c.pts.length, 0))
    })
  }

  it('saves curves without their points and reopens them as curves', () => {
    const doc = { ...emptyDoc(), shapes: [createBasic('circle', 10, 10), createBasic('roundrect', 40, 10)] }
    const json = serialize(doc)
    const raw = JSON.parse(json)
    expect(raw.shapes.every((s: { contours: unknown[] }) => s.contours.length === 0)).toBe(true)
    const back = parseDoc(json)
    expect(back.shapes).toHaveLength(2)
    for (const s of back.shapes) expect(penOf(s)).toBeTruthy()
    expect(back.shapes[0].contours[0].pts.length).toBe(doc.shapes[0].contours[0].pts.length)
  })

  it('exports circles as cubic curves', () => {
    const doc = { ...emptyDoc(), shapes: [createBasic('circle', 10, 10)] }
    const svg = exportSVG(doc)
    const d = / d="([^"]+)"/.exec(svg)![1]
    expect(d.match(/C/g)).toHaveLength(4)
    expect(d).not.toMatch(/L/)
  })

  it('a baked (rotated, scaled) curve stays a curve; rewritten contours drop it', () => {
    const s = { ...createBasic('ellipse', 5, 5), rotation: 30, sx: 2 }
    const b = bake(s)
    expect(penOf(b)).toBeTruthy()
    expect(penOf({ ...b, contours: [{ closed: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }] }] })).toBeNull()
  })
})
