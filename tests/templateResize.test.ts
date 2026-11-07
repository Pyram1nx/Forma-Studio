import { describe, expect, it } from 'vitest'
import { createTemplate, normalizeParametric } from '../src/editor/shapeFactory'
import { TEMPLATES } from '../src/geometry/templates'
import { shapeBBox, bboxW, bboxH } from '../src/geometry/transform'
import { disallowedHandles } from '../src/editor/shapeFactory'
import { ownAnchorPoint } from '../src/editor/ops'
import { parseDoc } from '../src/io/projectFile'

// Box joints scale themselves; the keyhole follows Studio's own rule (only its slot length, tested below).
const NO_RESIZE = new Set(['boxJointBasic', 'boxJointPro', 'keyhole'])

describe('template resize links to params', () => {
  for (const t of TEMPLATES.filter((x) => !NO_RESIZE.has(x.id))) {
    it(`${t.id}: uniform drag scales the bounds and the params`, () => {
      const s = createTemplate(t.id, 0, 0, 'mm')!
      const b0 = shapeBBox(s)
      const n = normalizeParametric({ ...s, sx: 1.5, sy: 1.5 })
      expect(n.sx).toBe(1)
      expect(n.sy).toBe(1)
      const b1 = shapeBBox(n)
      expect(bboxW(b1) / bboxW(b0)).toBeCloseTo(1.5, 1)
      expect(bboxH(b1) / bboxH(b0)).toBeCloseTo(1.5, 1)
      expect(t.params.some((d) => d.axis && n.params![d.key] !== s.params![d.key])).toBe(true)
    })
  }

  it('bow tie width and height follow separate drags', () => {
    const s = createTemplate('bowtie', 0, 0, 'mm')!
    const n = normalizeParametric({ ...s, sx: 2, sy: 0.5 })
    expect(n.params!.width).toBeCloseTo(Number(s.params!.width) * 2)
    expect(n.params!.height).toBeCloseTo(Number(s.params!.height) * 0.5)
  })
})

describe('keyhole resizes like Shaper Studio', () => {
  const MM = 25.4
  const key = (units: 'in' | 'mm' = 'in') => createTemplate('keyhole', 10, 20, units)!

  it("uses Studio's defaults per unit, placed by its neck centre with the head below", () => {
    const s = key()
    expect(s.params!.slotLength).toBeCloseTo(0.35 * MM)
    expect(s.params!.headDiameter).toBeCloseTo(0.4133 * MM)
    expect(s.params!.slotWidth).toBeCloseTo(0.1969 * MM)
    const m = key('mm')
    expect([m.params!.slotLength, m.params!.headDiameter, m.params!.slotWidth]).toEqual([9, 10.5, 5])
    const b = shapeBBox(s)
    // Neck's round end centred on the shape's position; the head's far edge slotLength + head radius below.
    expect(s.x).toBe(10)
    expect(s.y).toBe(20)
    expect(b.minY).toBeCloseTo(20 - (0.1969 * MM) / 2, 1)
    expect(b.maxY).toBeCloseTo(20 + 0.35 * MM + (0.4133 * MM) / 2, 1)
  })

  it('only the bottom handle is offered', () => {
    expect([...disallowedHandles([key()])].sort()).toEqual(['bl', 'br', 'lm', 'rm', 'tl', 'tm', 'tr'])
  })

  it('pivots on the neck centre while the origin is the centre', () => {
    const s = key()
    expect(ownAnchorPoint([s], 'mc')).toEqual({ x: 10, y: 20 })
    expect(ownAnchorPoint([s], 'tl')).toBeNull()
  })

  it("a bottom drag about the neck lengthens the slot by the pointer's travel; nothing else changes", () => {
    const s = key()
    const L = Number(s.params!.slotLength)
    const h = Number(s.params!.headDiameter) / 2
    // The canvas scales about the neck (the anchor): dragging the bottom down by 7 mm.
    const dy = (L + h + 7) / (L + h)
    const n = normalizeParametric({ ...s, sy: dy, sx: 1 })
    expect(n.params!.slotLength).toBeCloseTo(L + 7)
    expect(n.params!.headDiameter).toBe(s.params!.headDiameter)
    expect(n.params!.slotWidth).toBe(s.params!.slotWidth)
    expect([n.x, n.y, n.sx, n.sy]).toEqual([10, 20, 1, 1])
    expect(shapeBBox(n).maxY).toBeCloseTo(shapeBBox(s).maxY + 7, 1)
  })

  it("follows Studio's formula and floor for any scale, and ignores width", () => {
    const s = key()
    const L = Number(s.params!.slotLength)
    const h = Number(s.params!.headDiameter) / 2
    expect(normalizeParametric({ ...s, sx: 3, sy: 1.25 }).params!.slotLength).toBeCloseTo((L + h) * 1.25 - h)
    const wide = normalizeParametric({ ...s, sx: 3, sy: 1 }).params!
    expect(wide.slotLength).toBeCloseTo(L)
    expect([wide.headDiameter, wide.slotWidth]).toEqual([s.params!.headDiameter, s.params!.slotWidth])
    expect(normalizeParametric({ ...s, sy: 0.1 }).params!.slotLength).toBeCloseTo(0.005 * MM)
  })

  it('old centred keyholes load flipped and placed by their neck, looking the same', () => {
    const s = key()
    // The previous geometry: head circle centred at the top, the whole outline centred on the position.
    const L = Number(s.params!.slotLength)
    const h = Number(s.params!.headDiameter) / 2
    const nr = Number(s.params!.slotWidth) / 2
    const top = -(h + L + nr) / 2
    const circ = (cy: number, r: number) => Array.from({ length: 64 }, (_, i) => ({ x: r * Math.cos((i / 64) * 2 * Math.PI), y: cy + r * Math.sin((i / 64) * 2 * Math.PI) }))
    const old = { ...s, pen: undefined, contours: [{ closed: true, pts: [...circ(top + h, h), ...circ(top + h + L, nr)] }] }
    const doc = parseDoc(JSON.stringify({ app: 'FormaStudio', version: 1, shapes: [old], groups: [], settings: {} }))
    const m = doc.shapes[0]
    expect(m.sy).toBe(-1)
    expect(m.x).toBeCloseTo(10)
    expect(m.y).toBeCloseTo(20 + top + h + L)
    const b = shapeBBox(m)
    expect(b.minY).toBeCloseTo(20 + top, 1)
    expect(b.maxY).toBeCloseTo(20 - top, 1)
  })

  it('draws true arcs that match the polyline outline, whatever the proportions', () => {
    const t = TEMPLATES.find((x) => x.id === 'keyhole')!
    const area = (pts: { x: number; y: number }[]) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y }, 0) / 2)
    // Normal, head swallowing the slot, neck wider than the head.
    for (const p of [{ slotLength: 9, headDiameter: 14, slotWidth: 5 }, { slotLength: 1, headDiameter: 14, slotWidth: 5 }, { slotLength: 9, headDiameter: 4, slotWidth: 6 }]) {
      const pen = t.buildPen!(p)!
      expect(pen).toHaveLength(1)
      const s = { ...createTemplate('keyhole', 0, 0, 'mm')!, params: { template: 'keyhole', ...p } }
      const exact = normalizeParametric({ ...s, sy: 1.0000001 })
      const poly = t.build(p)
      const be = shapeBBox(exact)
      expect(bboxW(be)).toBeCloseTo(Math.max(p.headDiameter, p.slotWidth), 3)
      expect(Math.abs(area(exact.contours[0].pts) - poly.reduce((a, c) => a + area(c.pts), 0)) / area(exact.contours[0].pts)).toBeLessThan(0.003)
    }
  })
})
