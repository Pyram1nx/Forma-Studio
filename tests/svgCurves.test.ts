import { describe, expect, it } from 'vitest'
import type { PenContour, Pt, Shape, SvgSource } from '../src/model/types'
import { DEFAULT_CUT } from '../src/model/types'
import { circlePen, parsePathPen, penBounds, unionCurves } from '../src/geometry/curves'
import { cubicAt, flattenPen, mapPen, penGeometry, penOf, segment } from '../src/geometry/pen'
import { bake } from '../src/geometry/transform'
import { shapeFromWorld } from '../src/model/factory'
import { elementPen, liveSource } from '../src/io/svgSource'
import { exportSVG } from '../src/io/svgExport'
import { newDoc } from '../src/state/store'

/** A shape as the SVG importer builds it, for an element with the given attributes. */
function imported(tag: SvgSource['tag'], attrs: Record<string, string>, m: SvgSource['m'] = [1, 0, 0, 1, 0, 0], cutType: SvgSource['cutType'] = 'outside'): Shape {
  const local = elementPen(tag, (k) => attrs[k] ?? null, 1)
  const g = penGeometry(mapPen(local, (p) => ({ x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] })))
  const svgSource: SvgSource = { tag, attrs, m, unit: 1, fill: 'rgb(0, 0, 0)', stroke: 'none', fillRule: 'nonzero', cutType }
  return shapeFromWorld('import', 'x', g.contours, { pen: g.pen, cut: { ...DEFAULT_CUT, type: cutType, offset: 0.5 }, meta: { source: 'svg', svgSource } })
}

const exported = (s: Shape) => exportSVG({ ...newDoc(), shapes: [s] })

describe('SVG path data as curves', () => {
  it('keeps cubics exactly and turns quadratics into the identical cubic', () => {
    const [c] = parsePathPen('M0 0C10 0 10 10 0 10Z')
    expect(c.closed).toBe(true)
    expect(c.nodes[0].out).toEqual({ x: 10, y: 0 })
    expect(c.nodes[1].in).toEqual({ x: 10, y: 10 })
    const [q] = parsePathPen('M0 0Q10 0 10 10')
    const seg = segment(q, 0)
    for (const t of [0.25, 0.5, 0.8]) {
      const u = 1 - t
      const want = { x: u * u * 0 + 2 * u * t * 10 + t * t * 10, y: 2 * u * t * 0 + t * t * 10 }
      const got = cubicAt(seg, t)
      expect(got.x).toBeCloseTo(want.x, 10)
      expect(got.y).toBeCloseTo(want.y, 10)
    }
  })

  it('draws arcs as cubics that stay on the circle', () => {
    const [c] = parsePathPen('M-10 0A10 10 0 0 1 10 0A10 10 0 0 1 -10 0Z')
    for (const p of flattenPen(c, 0.001).pts) expect(Math.abs(Math.hypot(p.x, p.y) - 10)).toBeLessThan(1e-3)
  })
})

describe('imported SVG elements export as they came in', () => {
  it('writes a path back with its d untouched, placed by a transform', () => {
    const d = 'M 10,10 c 5,-8 15,-8 20,0 s 15,8 20,0 q 5,10 -10,20 a 5 5 0 1 1 -20 0 z'
    const s = { ...imported('path', { d }), x: 40, y: 7, rotation: 15 }
    expect(liveSource(s)).toBeTruthy()
    const svg = exported(s)
    expect(svg).toContain(`d="${d}"`)
    expect(svg).toMatch(/<path [^>]*transform="matrix\(/)
    // The file's own paint and fill rule, and the offset stated rather than baked in.
    expect(svg).toContain('fill="rgb(0, 0, 0)"')
    expect(svg).toContain('fill-rule="nonzero"')
    expect(svg).toContain('shaper:cutOffset="0.01969in"')
  })

  it('keeps circles, rects and polygons as their own elements', () => {
    expect(exported(imported('circle', { cx: '5', cy: '5', r: '4' }))).toMatch(/<circle id="[^"]+" cx="5" cy="5" r="4" /)
    expect(exported(imported('rect', { x: '0', y: '0', width: '10', height: '5', rx: '1' }))).toMatch(/<rect id="[^"]+" x="0" y="0" width="10" height="5" rx="1" /)
    expect(exported(imported('polygon', { points: '0,0 10,0 5,8' }))).toContain('points="0,0 10,0 5,8"')
  })

  it('stays the same element after baking a rotation and a scale', () => {
    const s = { ...imported('ellipse', { cx: '0', cy: '0', rx: '6', ry: '3' }, [0.5, 0, 0, 0.5, 3, 4]), rotation: 30, sx: 2, sy: 1.5 }
    expect(liveSource(bake(s))).toBeTruthy()
  })

  it('a changed cut type uses Shaper colours; a reshaped outline exports as curves', () => {
    const s = imported('circle', { cx: '5', cy: '5', r: '4' })
    expect(exported({ ...s, cut: { ...s.cut, type: 'pocket' } })).toContain('fill="#7F7F7F"')
    const reshaped = { ...s, ...penGeometry([circlePen(0, 0, 2)]), cut: { ...s.cut, offset: 0 } }
    expect(liveSource(reshaped)).toBeNull()
    const svg = exported(reshaped)
    expect(svg).toMatch(/<path [^>]*d="M[^"]*C/)
  })
})

describe('union that keeps curves', () => {
  const nodes = (pcs: PenContour[]) => pcs.reduce((n, pc) => n + pc.nodes.length, 0)

  it('gives untouched outlines back unchanged', () => {
    const a = circlePen(0, 0, 5)
    const b = circlePen(20, 0, 5)
    const out = unionCurves([a, b])
    expect(out).toHaveLength(2)
    expect(out).toContain(a)
    expect(out).toContain(b)
  })

  it('rebuilds a merged outline from the original curves', () => {
    const out = unionCurves([circlePen(0, 0, 5), circlePen(6, 0, 5)])
    expect(out).toHaveLength(1)
    // Two partial circles: a handful of curves, not hundreds of points.
    expect(nodes(out)).toBeLessThan(16)
    const b = penBounds(out)
    expect(b.minX).toBeCloseTo(-5, 3)
    expect(b.maxX).toBeCloseTo(11, 3)
    expect(b.maxY - b.minY).toBeCloseTo(10, 3)
    // Every point of the outline is on one of the two circles.
    const on = (p: Pt) => Math.min(Math.abs(Math.hypot(p.x, p.y) - 5), Math.abs(Math.hypot(p.x - 6, p.y) - 5))
    for (const p of flattenPen(out[0], 0.005).pts) expect(on(p)).toBeLessThan(0.02)
    expect(penOf(penGeometry(out) as Shape)).toBeTruthy()
  })
})
