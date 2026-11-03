import { describe, expect, it } from 'vitest'
import { fragments } from '../src/geometry/offset'
import { ellipse, rect } from '../src/geometry/primitives'
import type { Contour } from '../src/model/types'

const sq = (x: number, y: number, s: number): Contour[] => [
  { closed: true, pts: [{ x, y }, { x: x + s, y }, { x: x + s, y: y + s }, { x, y: y + s }] },
]

describe('fragments', () => {
  it('cuts two overlapping squares into overlap + two crescents', () => {
    expect(fragments([sq(0, 0, 20), sq(10, 10, 20)])).toHaveLength(3)
  })
  it('keeps disjoint shapes as separate fragments', () => {
    expect(fragments([sq(0, 0, 10), sq(50, 0, 10)])).toHaveLength(2)
  })
  it('treats a fully contained shape as a hole plus an island', () => {
    const f = fragments([sq(0, 0, 30), sq(10, 10, 10)])
    expect(f).toHaveLength(2)
    expect(f.some((r) => r.length === 2)).toBe(true)
  })
  it('splits the four corners left by an inscribed circle into separate pieces', () => {
    // Circle touches the square only at 4 tangent points, so the corners are not connected.
    expect(fragments([rect(10, 10), ellipse(10, 10)])).toHaveLength(5)
  })
})
