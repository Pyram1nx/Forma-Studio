// Pen tool geometry: Bézier nodes -> flattened contours and SVG path data, plus the editing
// operations of the node editor (split a segment, delete a node, toggle smooth / corner).
// Pen paths live in `Shape.pen`, in the same local frame as `Shape.contours`, which are
// always regenerated from them so cutting, hit testing and export keep working on polylines.
import type { Contour, PenContour, PenNode, Pt, Shape } from '../model/types'
import { cubic } from './svgPath'

/** Max chord deviation when flattening pen curves, in mm (the same as SVG import). */
const PEN_TOL = 0.05

const at = (n: PenNode): Pt => ({ x: n.x, y: n.y })
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** Number of segments of a pen contour (a closed one also runs from the last node back to the first). */
export const segmentCount = (pc: PenContour) => (pc.nodes.length < 2 ? 0 : pc.closed ? pc.nodes.length : pc.nodes.length - 1)

/** Segment i as cubic control points; a side without a handle has its control point on the anchor. */
export function segment(pc: PenContour, i: number): [Pt, Pt, Pt, Pt] {
  const a = pc.nodes[i]
  const b = pc.nodes[(i + 1) % pc.nodes.length]
  return [at(a), a.out ?? at(a), b.in ?? at(b), at(b)]
}

const straight = (pc: PenContour, i: number) => !pc.nodes[i].out && !pc.nodes[(i + 1) % pc.nodes.length].in

/** A point on a cubic. */
export function cubicAt([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

/** Flatten a pen contour to a polyline contour (straight segments stay single edges). */
export function flattenPen(pc: PenContour, tol = PEN_TOL): Contour {
  const n = pc.nodes
  if (!n.length) return { pts: [], closed: false }
  const pts: Pt[] = [at(n[0])]
  for (let i = 0; i < segmentCount(pc); i++) {
    if (straight(pc, i)) pts.push(at(n[(i + 1) % n.length]))
    else {
      const [p0, p1, p2, p3] = segment(pc, i)
      cubic(pts, p0, p1, p2, p3, tol)
    }
  }
  // A closed contour does not repeat its first point.
  if (pc.closed && pts.length > 1) pts.pop()
  return { pts, closed: pc.closed && pts.length >= 3 }
}

const num = (v: number) => String(Math.round(v * 1000) / 1000)

/** SVG path data with real curves, optionally mapped (e.g. local -> world). */
export function penToD(pens: PenContour[], map: (p: Pt) => Pt = (p) => p): string {
  let d = ''
  for (const pc of pens) {
    if (!pc.nodes.length) continue
    const m = (p: Pt) => {
      const q = map(p)
      return num(q.x) + ' ' + num(q.y)
    }
    d += 'M' + m(pc.nodes[0])
    for (let i = 0; i < segmentCount(pc); i++) {
      const [, c1, c2, p3] = segment(pc, i)
      d += straight(pc, i) ? 'L' + m(p3) : 'C' + m(c1) + ' ' + m(c2) + ' ' + m(p3)
    }
    if (pc.closed) d += 'Z'
  }
  return d
}

/** Every anchor and handle of the paths run through `f` (an affine map keeps the curves exact). */
export function mapPen(pens: PenContour[], f: (p: Pt) => Pt): PenContour[] {
  return pens.map((pc) => ({
    closed: pc.closed,
    nodes: pc.nodes.map((n) => {
      const q: PenNode = { ...f(n) }
      if (n.in) q.in = f(n.in)
      if (n.out) q.out = f(n.out)
      if (n.smooth) q.smooth = true
      return q
    }),
  }))
}

/**
 * The shape's pen paths, if they still describe its contours. Operations that rewrite contours
 * without knowing about pen data leave it stale; such a shape is edited as a plain path.
 */
export function penOf(s: Shape): PenContour[] | null {
  const p = s.pen
  if (!p || p.length !== s.contours.length) return null
  for (let i = 0; i < p.length; i++) if (p[i].closed !== s.contours[i].closed || p[i].nodes.length < 2) return null
  return p
}

/** The shape with new pen paths and the contours flattened from them. */
export function withPen(s: Shape, pen: PenContour[]): Shape {
  return { ...s, pen, contours: pen.map((pc) => flattenPen(pc)) }
}

/** The closest point on any segment of the paths, by sampling and then refining t. */
export function nearestOnPen(pens: PenContour[], p: Pt): { contour: number; seg: number; t: number; pt: Pt; d: number } | null {
  let best: { contour: number; seg: number; t: number; pt: Pt; d: number } | null = null
  pens.forEach((pc, ci) => {
    for (let i = 0; i < segmentCount(pc); i++) {
      const c = segment(pc, i)
      const N = 32
      let bt = 0
      let bd = Infinity
      for (let k = 0; k <= N; k++) {
        const q = cubicAt(c, k / N)
        const d = Math.hypot(q.x - p.x, q.y - p.y)
        if (d < bd) {
          bd = d
          bt = k / N
        }
      }
      // Narrow in around the best sample.
      let step = 1 / N
      for (let r = 0; r < 12; r++) {
        step /= 2
        for (const t of [bt - step, bt + step]) {
          if (t < 0 || t > 1) continue
          const q = cubicAt(c, t)
          const d = Math.hypot(q.x - p.x, q.y - p.y)
          if (d < bd) {
            bd = d
            bt = t
          }
        }
      }
      if (!best || bd < best.d) best = { contour: ci, seg: i, t: bt, pt: cubicAt(c, bt), d: bd }
    }
  })
  return best
}

/** Insert a node at t on segment i without changing the curve's shape (de Casteljau). */
export function splitSegment(pc: PenContour, i: number, t: number): PenContour {
  const nodes = pc.nodes.map((n) => ({ ...n }))
  const j = (i + 1) % nodes.length
  const a = nodes[i]
  const b = nodes[j]
  let mid: PenNode
  if (straight(pc, i)) {
    mid = { ...lerp(a, b, t) }
  } else {
    const [p0, p1, p2, p3] = segment(pc, i)
    const q0 = lerp(p0, p1, t)
    const q1 = lerp(p1, p2, t)
    const q2 = lerp(p2, p3, t)
    const r0 = lerp(q0, q1, t)
    const r1 = lerp(q1, q2, t)
    mid = { ...lerp(r0, r1, t), in: r0, out: r1, smooth: true }
    if (a.out) a.out = q0
    if (b.in) b.in = q2
  }
  nodes.splice(i + 1, 0, mid)
  return { closed: pc.closed, nodes }
}

/** Remove node i. A closed path left with two nodes opens; fewer than two nodes leaves nothing (null). */
export function deleteNode(pc: PenContour, i: number): PenContour | null {
  const nodes = pc.nodes.filter((_, k) => k !== i)
  if (nodes.length < 2) return null
  return { closed: pc.closed && nodes.length >= 3, nodes }
}

/**
 * Corner <-> smooth. A node with handles loses them; a corner gets handles along the line between
 * its neighbours, a third of the way to each (the usual auto-smooth).
 */
export function toggleSmooth(pc: PenContour, i: number): PenContour {
  const nodes = pc.nodes.map((n) => ({ ...n }))
  const n = nodes[i]
  if (n.in || n.out) {
    delete n.in
    delete n.out
    delete n.smooth
    return { closed: pc.closed, nodes }
  }
  const len = nodes.length
  const prev = i > 0 ? nodes[i - 1] : pc.closed ? nodes[len - 1] : null
  const next = i < len - 1 ? nodes[i + 1] : pc.closed ? nodes[0] : null
  const from = prev ?? n
  const to = next ?? n
  let dx = to.x - from.x
  let dy = to.y - from.y
  const dl = Math.hypot(dx, dy)
  if (dl < 1e-9) return { closed: pc.closed, nodes }
  dx /= dl
  dy /= dl
  if (prev) {
    const l = Math.hypot(n.x - prev.x, n.y - prev.y) / 3
    n.in = { x: n.x - dx * l, y: n.y - dy * l }
  }
  if (next) {
    const l = Math.hypot(next.x - n.x, next.y - n.y) / 3
    n.out = { x: n.x + dx * l, y: n.y + dy * l }
  }
  n.smooth = !!(prev && next)
  return { closed: pc.closed, nodes }
}

/**
 * Move one handle of a node. A smooth node turns its other handle to stay collinear (keeping that
 * handle's length); `breakIt` (Alt) frees the handle and makes the node a corner.
 */
export function moveHandle(n: PenNode, side: 'in' | 'out', p: Pt, breakIt: boolean): PenNode {
  const q: PenNode = { ...n, [side]: p }
  const other = side === 'in' ? 'out' : 'in'
  if (breakIt) {
    q.smooth = false
    return q
  }
  if (n.smooth && n[other]) {
    const o = n[other]!
    const ol = Math.hypot(o.x - n.x, o.y - n.y)
    const dl = Math.hypot(p.x - n.x, p.y - n.y)
    if (dl > 1e-9) q[other] = { x: n.x - ((p.x - n.x) / dl) * ol, y: n.y - ((p.y - n.y) / dl) * ol }
  }
  return q
}

/** Move an anchor and carry its handles with it. */
export function moveNode(n: PenNode, p: Pt): PenNode {
  const dx = p.x - n.x
  const dy = p.y - n.y
  const q: PenNode = { ...n, x: p.x, y: p.y }
  if (n.in) q.in = { x: n.in.x + dx, y: n.in.y + dy }
  if (n.out) q.out = { x: n.out.x + dx, y: n.out.y + dy }
  return q
}

/** Validate untrusted pen data from a file; null when unusable. */
export function parsePen(raw: unknown): PenContour[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const ok = (v: unknown): v is Pt => !!v && typeof v === 'object' && Number.isFinite((v as Pt).x) && Number.isFinite((v as Pt).y)
  const out: PenContour[] = []
  for (const c of raw) {
    if (!c || typeof c !== 'object' || !Array.isArray((c as PenContour).nodes)) return undefined
    const nodes: PenNode[] = []
    for (const n of (c as PenContour).nodes) {
      if (!ok(n)) return undefined
      const q: PenNode = { x: n.x, y: n.y }
      if (ok(n.in)) q.in = { x: n.in.x, y: n.in.y }
      if (ok(n.out)) q.out = { x: n.out.x, y: n.out.y }
      if (n.smooth === true) q.smooth = true
      nodes.push(q)
    }
    out.push({ nodes, closed: (c as PenContour).closed === true })
  }
  return out.length ? out : undefined
}
