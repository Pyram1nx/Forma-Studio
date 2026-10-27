// Default-parameter geometry of the shape templates, checked against Shaper Studio's own
// output (bounding box and summed area, in inches). Values were read from Studio's canvas.
import { describe, expect, it } from 'vitest'
import { TEMPLATES } from '../src/geometry/templates'
import type { Contour } from '../src/model/types'

const MM = 25.4

function measure(contours: Contour[]) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let area = 0
  for (const c of contours) {
    let a = 0
    for (let i = 0; i < c.pts.length; i++) {
      const p = c.pts[i]
      const q = c.pts[(i + 1) % c.pts.length]
      a += p.x * q.y - q.x * p.y
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
    area += Math.abs(a / 2)
  }
  return { w: (maxX - minX) / MM, h: (maxY - minY) / MM, area: area / MM / MM }
}

const studio: Record<string, { w: number; h: number; area: number }> = {
  barbell: { w: 2, h: 0.5, area: 0.659 },
  keyhole: { w: 0.413, h: 0.655, area: 0.1791 },
  linearHoles: { w: 12.121, h: 4.565, area: 3.8966 },
  linearRectangles: { w: 5, h: 0.75, area: 1.5 },
  radialHoles: { w: 4.8694, h: 4.8694, area: 0.3928 },
}

describe('template defaults match Shaper Studio', () => {
  for (const [id, want] of Object.entries(studio)) {
    it(id, () => {
      const t = TEMPLATES.find((x) => x.id === id)!
      const got = measure(t.build({}))
      expect(got.w).toBeCloseTo(want.w, 2)
      expect(got.h).toBeCloseTo(want.h, 2)
      // Circles are polygons here, so allow a fraction of a percent on area.
      expect(Math.abs(got.area - want.area) / want.area).toBeLessThan(0.005)
    })
  }
})
