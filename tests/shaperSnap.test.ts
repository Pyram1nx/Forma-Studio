import { describe, expect, it } from 'vitest'
import type { Shape } from '../src/model/types'
import { DEFAULT_CUT } from '../src/model/types'
import { alignLines, guideFor, orthoDelta, snapAxis, snapPoint, type AlignLine } from '../src/editor/snapTargets'

const ALL = { points: true, midpoints: true, edges: true, bounds: true, centers: true, origin: true }
const SHARED = { points: false, midpoints: false, edges: false, bounds: true, centers: true, origin: false }

function square(x: number, y: number, size = 10): Shape {
  const h = size / 2
  return {
    id: 'sq' + x + ',' + y,
    name: 'Square',
    kind: 'path',
    contours: [{ pts: [{ x: -h, y: -h }, { x: h, y: -h }, { x: h, y: h }, { x: -h, y: h }], closed: true }],
    x,
    y,
    rotation: 0,
    sx: 1,
    sy: 1,
    cut: { ...DEFAULT_CUT },
  } as Shape
}

describe("Shaper Studio's alignment (shared Bounding box / Centers targets)", () => {
  it('offers left, right and centre lines spanning the target', () => {
    const { xs, ys } = alignLines([square(0, 0)], SHARED)
    expect(xs.map((l) => l.at).sort((a, b) => a - b)).toEqual([-5, 0, 5])
    expect(ys.map((l) => l.at).sort((a, b) => a - b)).toEqual([-5, 0, 5])
    expect(xs.every((l) => l.lo === -5 && l.hi === 5)).toBe(true)
  })

  it('aligns any moving edge or centre, the nearest one winning', () => {
    const lines: AlignLine[] = [{ at: 5, lo: -5, hi: 5 }]
    // A box spanning 20..30 moved by -14: its left edge sits at 6, 1 from the target's right edge.
    const hit = snapAxis([20, 30, 25], -14, lines, 2, null)
    expect(hit?.at).toBe(5)
    expect(hit!.shift).toBeCloseTo(-1)
  })

  it('lets grid and object lines compete by distance', () => {
    const lines: AlignLine[] = [{ at: 3, lo: 0, hi: 0 }]
    // 9.6 is 0.4 from the 10 mm grid line and 6.6 from the object line.
    expect(snapAxis([9.6], 0, lines, 12, { size: 10, tol: 1 })?.grid).toBe(true)
    // 3.5 is 0.5 from the object line; the nearest grid line is beyond the grid tolerance.
    expect(snapAxis([3.5], 0, lines, 12, { size: 10, tol: 1 })?.grid).toBe(false)
  })

  it('prefers the object line on a tie with the grid', () => {
    const lines: AlignLine[] = [{ at: 10, lo: 0, hi: 0 }]
    expect(snapAxis([9.5], 0, lines, 1, { size: 10, tol: 1 })?.grid).toBe(false)
  })

  it('draws an object guide over the moved thing and its target', () => {
    const g = guideFor('x', { shift: 0, at: 5, grid: false, line: { at: 5, lo: -5, hi: 5 } }, 10, 30)
    expect(g).toEqual({ axis: 'x', at: 5, from: -5, to: 30 })
    expect(guideFor('y', { shift: 0, at: 10, grid: true }, 0, 1)).toEqual({ axis: 'y', at: 10, grid: true })
  })

  it('snaps a free point per axis, landing on a corner when both axes align', () => {
    const hit = snapPoint({ x: 5.5, y: -4.6 }, [square(0, 0)], SHARED, 1)
    expect(hit.pt).toEqual({ x: 5, y: -5 })
    expect(hit.guides).toHaveLength(2)
  })

  it('aligns a free point with extra points (the path being drawn)', () => {
    const hit = snapPoint({ x: 40.3, y: 80 }, [], SHARED, 1, { extra: [{ x: 40, y: 0 }] })
    expect(hit.pt).toEqual({ x: 40, y: 80 })
  })

  it('snaps a free point to the grid when there is nothing else', () => {
    const hit = snapPoint({ x: 24.6, y: 13 }, [], SHARED, 1, { grid: { size: 25.4, tol: 1 } })
    expect(hit.pt.x).toBeCloseTo(25.4)
    expect(hit.pt.y).toBe(13)
  })

  it('keeps the add-on exact targets ahead of alignment', () => {
    // Near a vertex, Points wins as before.
    const hit = snapPoint({ x: 5.4, y: 5.3 }, [square(0, 0)], ALL, 1)
    expect(hit.kind).toBe('points')
    expect(hit.pt).toEqual({ x: 5, y: 5 })
  })
})

describe("Shaper Studio's Shift constraint", () => {
  it('keeps the nearer axis away from the diagonals', () => {
    expect(orthoDelta(10, 1)).toEqual({ x: 10, y: 0 })
    expect(orthoDelta(-1, -10)).toEqual({ x: 0, y: -10 })
  })
  it('follows a diagonal within 18 degrees of it, keeping the length', () => {
    const d = orthoDelta(10, 7)
    expect(d.x).toBeCloseTo(d.y)
    expect(Math.hypot(d.x, d.y)).toBeCloseTo(Math.hypot(10, 7))
  })
})

describe('ties between targets', () => {
  it('keeps the bounds line (spanning the target) over an add-on point on the same coordinate', () => {
    const { xs } = alignLines([square(0, 0)], ALL)
    const hit = snapAxis([5.5], 0, xs, 1, null)
    expect(hit?.line).toEqual({ at: 5, lo: -5, hi: 5 })
  })
})
