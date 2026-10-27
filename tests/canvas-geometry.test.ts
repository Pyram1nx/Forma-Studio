import { describe, expect, it } from 'vitest'
import type { Contour } from '../src/model/types'
import { DEFAULT_CUT } from '../src/model/types'
import { bboxOfContours } from '../src/geometry/transform'
import {
  axisFactor,
  computeCutGeometry,
  cornerFactor,
  edgeFactor,
  handleUsable,
  depthLevel,
  isMouseWheelDelta,
  textPillWidth,
  wheelZoomFactor,
} from '../src/editor/canvas/canvasMath'

const IN = 25.4
const BIT = 3.175 // 1/8 in
const square: Contour[] = [{ closed: true, pts: [{ x: 0, y: 0 }, { x: IN, y: 0 }, { x: IN, y: IN }, { x: 0, y: IN }] }]
const size = (cs: Contour[]) => {
  const b = bboxOfContours(cs)
  return { w: b.maxX - b.minX, h: b.maxY - b.minY, cx: (b.minX + b.maxX) / 2, cy: (b.minY + b.maxY) / 2 }
}
const area = (cs: Contour[]) =>
  cs.reduce((sum, c) => {
    let a = 0
    for (let i = 0; i < c.pts.length; i++) {
      const p = c.pts[i]
      const q = c.pts[(i + 1) % c.pts.length]
      a += p.x * q.y - q.x * p.y
    }
    return sum + Math.abs(a / 2)
  }, 0)

describe('depthLevel', () => {
  it('maps depths to review levels', () => {
    expect(depthLevel(0.25 * IN)).toBe(3)
    expect(depthLevel(0.5 * IN)).toBe(5)
    expect(depthLevel(null)).toBe(0)
    expect(depthLevel(undefined)).toBe(0)
    expect(depthLevel(20 * IN)).toBe(7)
    expect(depthLevel(1000)).toBe(7)
  })
})

describe('computeCutGeometry', () => {
  const cut = { ...DEFAULT_CUT, bitDia: BIT }

  it('outside centre path sits one bit radius outside the square', () => {
    const g = computeCutGeometry(square, { ...cut, type: 'outside' })
    expect(size(g.centre).w).toBeCloseTo(IN + BIT, 2)
    expect(size(g.centre).h).toBeCloseTo(IN + BIT, 2)
    // Swept band spans from the outline out to the bit edge (2r).
    expect(size(g.swept).w).toBeCloseTo(IN + 2 * BIT, 2)
  })

  it('inside centre path sits one bit radius inside the square', () => {
    const g = computeCutGeometry(square, { ...cut, type: 'inside' })
    expect(size(g.centre).w).toBeCloseTo(IN - BIT, 2)
    expect(size(g.swept).w).toBeCloseTo(IN, 2)
  })

  it('online centre path is the outline itself', () => {
    const g = computeCutGeometry(square, { ...cut, type: 'online' })
    expect(size(g.centre).w).toBeCloseTo(IN, 2)
    expect(size(g.swept).w).toBeCloseTo(IN + BIT, 2)
  })

  it('pocket clears the whole square (bit edge reaches the outline)', () => {
    const g = computeCutGeometry(square, { ...cut, type: 'pocket' })
    expect(size(g.centre).w).toBeCloseTo(IN - BIT, 2)
    expect(size(g.swept).w).toBeCloseTo(IN, 1)
    expect(area(g.swept) / (IN * IN)).toBeGreaterThan(0.98)
  })

  it('guides and collapsed offsets produce no geometry', () => {
    expect(computeCutGeometry(square, { ...cut, type: 'guide' }).centreD).toBe('')
    const tiny: Contour[] = [{ closed: true, pts: [{ x: 0, y: 0 }, { x: 2, y: 0 }, { x: 2, y: 2 }, { x: 0, y: 2 }] }]
    const g = computeCutGeometry(tiny, { ...cut, type: 'inside', bitDia: 6 })
    expect(g.centre).toHaveLength(0)
    expect(g.centreD).toBe('')
  })

  it('open paths are treated as online', () => {
    const open: Contour[] = [{ closed: false, pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }]
    expect(computeCutGeometry(open, { ...cut, type: 'outside' }).type).toBe('online')
  })
})

describe('input helpers', () => {
  it('axisFactor keeps degenerate axes at 1 and clamps tiny factors', () => {
    expect(axisFactor(50, 10, 10)).toBe(1)
    expect(axisFactor(20, 0, 10)).toBeCloseTo(2)
    expect(axisFactor(0, 0, 10)).toBe(1e-3)
  })

  it('anchor scaling: corner projects travel on the anchor-handle line, edges use one axis', () => {
    // Centre anchor (50,50), corner handle at (100,100): +10,+10 travel grows 1.2x.
    expect(cornerFactor({ x: 10, y: 10 }, { x: 50, y: 50 }, { x: 100, y: 100 })).toBeCloseTo(1.2)
    // Anchor in the interior, handle up-left of it.
    expect(cornerFactor({ x: -20, y: -20 }, { x: 20, y: 20 }, { x: 0, y: 0 })).toBeCloseTo(2)
    expect(edgeFactor(25, 0, 100)).toBeCloseTo(1.25)
    expect(edgeFactor(5, 10, 10)).toBe(1)
  })

  it('handles on the anchor row or column are unusable', () => {
    const tl = { x: 0, y: 0 }
    expect(handleUsable('tl', { x: 0, y: 0 }, tl)).toBe(false)
    expect(handleUsable('tm', { x: 50, y: 0 }, tl)).toBe(false)
    expect(handleUsable('lm', { x: 0, y: 50 }, tl)).toBe(false)
    expect(handleUsable('br', { x: 100, y: 100 }, tl)).toBe(true)
    expect(handleUsable('tm', { x: 50, y: 0 }, { x: 50, y: 50 })).toBe(true)
  })

  it('wheel heuristic treats trackpad-like deltas as pan', () => {
    expect(isMouseWheelDelta({ deltaMode: 0, deltaX: 0, deltaY: 100 })).toBe(true)
    expect(isMouseWheelDelta({ deltaMode: 1, deltaX: 0, deltaY: 3 })).toBe(true)
    expect(isMouseWheelDelta({ deltaMode: 0, deltaX: 0, deltaY: 7.5 })).toBe(false)
    expect(isMouseWheelDelta({ deltaMode: 0, deltaX: 4, deltaY: 100 })).toBe(false)
  })

  it('zoom factor is clamped per event', () => {
    expect(wheelZoomFactor(-1000, 0, true)).toBe(1.25)
    expect(wheelZoomFactor(1000, 0, false)).toBe(0.8)
    expect(wheelZoomFactor(0, 0, true)).toBe(1)
  })

  it('label pills grow with text length', () => {
    expect(textPillWidth('1.000 in')).toBeGreaterThan(textPillWidth('1 in'))
  })
})

describe('mixed closed and open contours', () => {
  const open: Contour = { closed: false, pts: [{ x: 60, y: 0 }, { x: 100, y: 0 }] }
  const cut = (type: 'outside' | 'inside' | 'pocket' | 'online', offset = 0) => ({ ...DEFAULT_CUT, type, bitDia: BIT, offset, depth: 3 })

  it('inside cut offsets only the closed contour and keeps the open one on-line', () => {
    const g = computeCutGeometry([...square, open], cut('inside'))
    const openOut = g.centre.filter((c) => !c.closed)
    expect(openOut).toHaveLength(1)
    expect(openOut[0].pts).toEqual(open.pts)
    const closedOut = g.centre.filter((c) => c.closed)
    expect(size(closedOut).w).toBeCloseTo(IN - BIT, 1)
  })

  it('outside cut grows the closed contour and leaves the open one unchanged', () => {
    const g = computeCutGeometry([...square, open], cut('outside'))
    expect(g.centre.filter((c) => !c.closed)[0].pts).toEqual(open.pts)
    expect(size(g.centre.filter((c) => c.closed)).w).toBeCloseTo(IN + BIT, 1)
  })

  it('pocket keeps the open subpath as a centre line', () => {
    const g = computeCutGeometry([...square, open], cut('pocket'))
    expect(g.centre.filter((c) => !c.closed)[0].pts).toEqual(open.pts)
  })

  it('an all-open shape is cut on-line whatever the stored type', () => {
    const g = computeCutGeometry([open], cut('inside'))
    expect(g.type).toBe('online')
    expect(g.centre).toEqual([open])
  })
})

describe('depth 0 means unset', () => {
  it('depthLevel treats 0 and negative depths as level 0', () => {
    expect(depthLevel(0)).toBe(0)
    expect(depthLevel(-3)).toBe(0)
  })
})
