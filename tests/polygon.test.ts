import { describe, expect, it } from 'vitest'
import { polygon, polygonUnitSize } from '../src/geometry/primitives'

const bbox = (n: number, w: number, h: number) => {
  const pts = polygon(n, w, h)[0].pts
  const xs = pts.map((p) => p.x)
  const ys = pts.map((p) => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), pts }
}

// Measured on Shaper Studio's polygon: circumradius 0.5 in, a flat edge at the bottom.
describe('polygon (Studio)', () => {
  const size = (n: number) => ({ w: polygonUnitSize(n).w * 0.5, h: polygonUnitSize(n).h * 0.5 })
  it.each([
    [3, 0.866, 0.75],
    [4, 0.707, 0.707],
    [5, 0.951, 0.905],
    [6, 1.0, 0.866],
    [8, 0.924, 0.924],
    [16, 0.981, 0.981],
  ])('%i sides is %f × %f in', (n, w, h) => {
    expect(size(n).w).toBeCloseTo(w, 3)
    expect(size(n).h).toBeCloseTo(h, 3)
  })
  it('keeps a flat bottom, and points up for odd counts', () => {
    const six = bbox(6, 1, 0.866).pts
    const maxY = Math.max(...six.map((p) => p.y))
    expect(six.filter((p) => Math.abs(p.y - maxY) < 1e-9)).toHaveLength(2)
    const five = bbox(5, 1, 1).pts
    const minY = Math.min(...five.map((p) => p.y))
    expect(five.filter((p) => Math.abs(p.y - minY) < 1e-9)).toHaveLength(1)
  })
})
