import { describe, expect, it } from 'vitest'
import { createTemplate, normalizeParametric } from '../src/editor/shapeFactory'
import { TEMPLATES } from '../src/geometry/templates'
import { shapeBBox, bboxW, bboxH } from '../src/geometry/transform'

const NO_RESIZE = new Set(['boxJointBasic', 'boxJointPro'])

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
