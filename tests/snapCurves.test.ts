import { describe, expect, it } from 'vitest'
import { cornerFlags } from '../src/editor/snapTargets'
import { TEMPLATES } from '../src/geometry/templates'

describe('snap targets on curves', () => {
  it('rounded compass star offers only its real corners, not every arc sample', () => {
    const star = TEMPLATES.find((t) => t.id === 'compass')!.build({})
    const total = star.reduce((n, c) => n + c.pts.length, 0)
    const sharp = star.reduce((n, c) => n + cornerFlags(c).filter(Boolean).length, 0)
    expect(total).toBeGreaterThan(80)
    expect(sharp).toBeLessThanOrEqual(total / 3)
    expect(sharp).toBeGreaterThanOrEqual(8)
  })

  it('keeps every vertex of a square and the ends of an open line', () => {
    const sq = { closed: true, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }] }
    expect(cornerFlags(sq)).toEqual([true, true, true, true])
    const line = { closed: false, pts: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }] }
    expect(cornerFlags(line)).toEqual([true, false, true])
  })
})
