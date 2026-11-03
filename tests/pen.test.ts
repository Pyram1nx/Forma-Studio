import { describe, expect, it } from 'vitest'
import type { PenContour } from '../src/model/types'
import { cubicAt, deleteNode, flattenPen, moveHandle, nearestOnPen, penOf, penToD, segment, splitSegment, toggleSmooth } from '../src/geometry/pen'
import { bake } from '../src/geometry/transform'
import { penShapeFrom } from '../src/editor/canvas/usePen'
import { newDoc } from '../src/state/store'
import { parseDoc } from '../src/io/projectFile'

const curve: PenContour = {
  closed: false,
  nodes: [
    { x: 0, y: 0, out: { x: 10, y: -10 } },
    { x: 20, y: 0, in: { x: 10, y: -10 } },
  ],
}

describe('pen geometry', () => {
  it('keeps straight segments as single edges and flattens curves', () => {
    const line = flattenPen({ closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] })
    expect(line.pts).toEqual([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }])
    const c = flattenPen(curve)
    expect(c.pts.length).toBeGreaterThan(4)
    expect(c.pts[0]).toEqual({ x: 0, y: 0 })
    expect(c.pts[c.pts.length - 1].x).toBeCloseTo(20)
    // The curve bulges upward (negative y) to its control polygon's midpoint height.
    expect(Math.min(...c.pts.map((p) => p.y))).toBeCloseTo(-7.5, 1)
  })

  it('closes without repeating the first point and writes real curves to SVG', () => {
    const closed = { ...curve, closed: true }
    const c = flattenPen(closed)
    expect(c.closed).toBe(true)
    expect(c.pts[c.pts.length - 1]).not.toEqual(c.pts[0])
    expect(penToD([closed])).toBe('M0 0C10 -10 10 -10 20 0L0 0Z')
  })

  it('splits a segment without changing its shape', () => {
    const before = segment(curve, 0)
    const split = splitSegment(curve, 0, 0.3)
    expect(split.nodes).toHaveLength(3)
    const mid = split.nodes[1]
    const p = cubicAt(before, 0.3)
    expect(mid.x).toBeCloseTo(p.x)
    expect(mid.y).toBeCloseTo(p.y)
    // A point on the second half matches the original curve.
    const q = cubicAt(segment(split, 1), 0.5)
    const r = cubicAt(before, 0.3 + 0.7 * 0.5)
    expect(q.x).toBeCloseTo(r.x)
    expect(q.y).toBeCloseTo(r.y)
  })

  it('finds the nearest point on the path', () => {
    const hit = nearestOnPen([curve], { x: 10, y: -8 })!
    expect(hit.seg).toBe(0)
    expect(hit.t).toBeCloseTo(0.5, 2)
    expect(hit.d).toBeCloseTo(0.5, 2)
  })

  it('toggles smooth and corner nodes', () => {
    const tri: PenContour = { closed: false, nodes: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }] }
    const s = toggleSmooth(tri, 1)
    expect(s.nodes[1].smooth).toBe(true)
    expect(s.nodes[1].in!.y).toBeCloseTo(10)
    expect(s.nodes[1].out!.x).toBeGreaterThan(10)
    const c = toggleSmooth(s, 1)
    expect(c.nodes[1].in).toBeUndefined()
    expect(c.nodes[1].out).toBeUndefined()
  })

  it('mirrors the opposite handle of a smooth node unless broken', () => {
    const n = { x: 0, y: 0, in: { x: -5, y: 0 }, out: { x: 5, y: 0 }, smooth: true }
    const m = moveHandle(n, 'out', { x: 0, y: 10 }, false)
    expect(m.in!.x).toBeCloseTo(0)
    expect(m.in!.y).toBeCloseTo(-5)
    const b = moveHandle(n, 'out', { x: 0, y: 10 }, true)
    expect(b.in).toEqual({ x: -5, y: 0 })
    expect(b.smooth).toBe(false)
  })

  it('deletes nodes and opens a closed path left with two', () => {
    const tri: PenContour = { closed: true, nodes: [{ x: 0, y: 0 }, { x: 10, y: 10 }, { x: 20, y: 0 }] }
    expect(deleteNode(tri, 1)!.closed).toBe(false)
    expect(deleteNode({ closed: false, nodes: tri.nodes.slice(0, 2) }, 0)).toBeNull()
  })
})

describe('pen shapes', () => {
  it('are centred, keep their nodes through bake and survive save / open', () => {
    const s = penShapeFrom([{ x: 100, y: 100, out: { x: 110, y: 90 } }, { x: 120, y: 100, in: { x: 110, y: 90 } }, { x: 110, y: 120 }], true)!
    expect(s.cut.type).toBe('outside')
    expect(penOf(s)).not.toBeNull()
    const rotated = bake({ ...s, rotation: 90, sx: 2 })
    const pen = penOf(rotated)!
    // Contours flattened from the baked nodes match the baked contours' bounds.
    const ys = flattenPen(pen[0]).pts.map((p) => p.y)
    const cy = rotated.contours[0].pts.map((p) => p.y)
    expect(Math.min(...ys)).toBeCloseTo(Math.min(...cy), 1)
    expect(Math.max(...ys)).toBeCloseTo(Math.max(...cy), 1)

    const doc = { ...newDoc(), shapes: [s] }
    const back = parseDoc(JSON.stringify(doc)).shapes[0]
    expect(back.pen).toEqual(s.pen)
  })

  it('two straight nodes stay an open path', () => {
    const s = penShapeFrom([{ x: 0, y: 0 }, { x: 10, y: 0 }], true)!
    expect(s.contours[0].closed).toBe(false)
    expect(penOf(s)).not.toBeNull()
  })
})
