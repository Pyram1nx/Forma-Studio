import { describe, expect, it } from 'vitest'
import { snapToGridLines } from '../src/editor/grid'

describe('grid magnet (as in Shaper Studio)', () => {
  it('pulls an edge onto a grid line within tolerance and reports the line', () => {
    // A 10 mm box centred at 0 spans -5..5; moved 4.8 mm its right edge sits at 9.8, 0.2 from the 10 line.
    const hit = snapToGridLines([-5, 0, 5], 4.8, 10, 0.5)
    expect(hit?.at).toBe(10)
    expect(hit!.shift).toBeCloseTo(0.2)
  })
  it('does nothing when every edge is farther than the tolerance', () => {
    expect(snapToGridLines([-5, 0, 5], 2, 10, 0.5)).toBeNull()
  })
  it('lets the closest candidate win', () => {
    const hit = snapToGridLines([0, 3], 0.4, 10, 0.5)
    expect(hit?.at).toBe(0)
  })
})
