// True curve geometry (cubic Béziers, as pen contours) for the shapes the editor makes: circles and
// ellipses, filleted corners, and arcs recovered from template outlines. A circle is four curves
// instead of a hundred points, so it draws, exports and saves as real vector geometry; the polyline
// `contours` are flattened from these curves for offsetting, booleans and hit testing.
import type { Contour, PenContour, PenNode, Pt } from '../model/types'
import { maxFillet } from './fillet'
import { arcCentre, pathOps, segCount } from './svgPath'
import { unionNonZero } from './offset'

/** Max distance (mm) between a cubic arc and the true circle. A quarter-circle cubic stays under it up to r ≈ 37 mm. */
const ARC_TOL = 0.01
const TAU = Math.PI * 2

/** One segment of a path: a cubic when it has control points, otherwise a straight line. */
export interface Seg {
  p0: Pt
  c1?: Pt
  c2?: Pt
  p3: Pt
}

const near = (a: Pt, b: Pt, eps = 1e-9) => Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps

/**
 * Cubic segments for an elliptical arc centred on c, from angle a0 through `sweep` (radians, either sign).
 * Each piece spans at most 90 degrees, fewer when the radius is large enough for the cubic's error to matter.
 */
export function arcSegs(c: Pt, rx: number, ry: number, a0: number, sweep: number, tol = ARC_TOL): Seg[] {
  const r = Math.max(Math.abs(rx), Math.abs(ry))
  // A cubic's deviation from its arc is 2.7e-4 r at 90 degrees and grows with the sweep to the 6th power.
  const maxStep = Math.min(Math.PI / 2, (Math.PI / 2) * Math.pow(tol / (2.7e-4 * Math.max(r, 1e-9)), 1 / 6))
  const n = Math.max(1, Math.ceil(Math.abs(sweep) / maxStep - 1e-9))
  const step = sweep / n
  const k = (4 / 3) * Math.tan(step / 4)
  const at = (a: number): Pt => ({ x: c.x + rx * Math.cos(a), y: c.y + ry * Math.sin(a) })
  const segs: Seg[] = []
  for (let i = 0; i < n; i++) {
    const a = a0 + step * i
    const b = a + step
    const p0 = at(a)
    const p3 = at(b)
    segs.push({
      p0,
      c1: { x: p0.x - k * rx * Math.sin(a), y: p0.y + k * ry * Math.cos(a) },
      c2: { x: p3.x + k * rx * Math.sin(b), y: p3.y - k * ry * Math.cos(b) },
      p3,
    })
  }
  return segs
}

/** Join consecutive segments into a pen contour (a closed one ends where it starts). */
export function segsToPen(segs: Seg[], closed: boolean): PenContour {
  const nodes: PenNode[] = []
  for (const s of segs) {
    if (near(s.p0, s.p3) && !s.c1 && !s.c2) continue
    const prev = nodes[nodes.length - 1]
    if (!prev || !near(prev, s.p0, 1e-6)) nodes.push({ x: s.p0.x, y: s.p0.y })
    const from = nodes[nodes.length - 1]
    if (s.c1) from.out = { ...s.c1 }
    const to: PenNode = { x: s.p3.x, y: s.p3.y }
    if (s.c2) to.in = { ...s.c2 }
    nodes.push(to)
  }
  if (closed && nodes.length > 1 && near(nodes[0], nodes[nodes.length - 1], 1e-6)) {
    const last = nodes.pop()!
    if (last.in) nodes[0].in = last.in
  }
  for (const n of nodes) if (n.in && n.out && collinear(n, n.in, n.out)) n.smooth = true
  return { nodes, closed }
}

/** Handles on opposite sides of their anchor along one line: a smooth node. */
function collinear(n: Pt, a: Pt, b: Pt): boolean {
  const ux = a.x - n.x
  const uy = a.y - n.y
  const vx = b.x - n.x
  const vy = b.y - n.y
  const la = Math.hypot(ux, uy)
  const lb = Math.hypot(vx, vy)
  if (la < 1e-12 || lb < 1e-12) return false
  return Math.abs(ux * vy - uy * vx) / (la * lb) < 1e-6 && ux * vx + uy * vy < 0
}

/** A w×h ellipse centred on (0,0) as four (or more) cubic arcs, starting at the right-hand point like the old polyline. */
export function ellipsePen(w: number, h: number): PenContour[] {
  return [segsToPen(arcSegs({ x: 0, y: 0 }, w / 2, h / 2, 0, TAU), true)]
}

/** A full circle (for template holes and the like). */
export function circlePen(cx: number, cy: number, r: number): PenContour {
  return segsToPen(arcSegs({ x: cx, y: cy }, r, r, 0, TAU), true)
}

/**
 * A closed polygon with each vertex rounded by its own radius: the same geometry as `filletPolygon`
 * (tangent arcs clamped by `maxFillet`), but with the arcs as true curves.
 */
export function filletPen(pts: Pt[], radii: number[]): PenContour[] {
  const n = pts.length
  // Each vertex: where the path arrives (entry), the arc if rounded, and where it leaves (exit).
  const corners = pts.map((p, i) => {
    const r = Math.min(Math.max(0, radii[i] ?? 0), maxFillet(pts, i))
    if (r < 1e-9) return { entry: p, exit: p, arc: null as Seg[] | null }
    const a = pts[(i - 1 + n) % n]
    const b = pts[(i + 1) % n]
    const u1 = unit(a.x - p.x, a.y - p.y)
    const u2 = unit(b.x - p.x, b.y - p.y)
    const theta = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)))
    const t = r / Math.tan(theta / 2)
    const m = unit(u1.x + u2.x, u1.y + u2.y)
    const d = r / Math.sin(theta / 2)
    const c = { x: p.x + m.x * d, y: p.y + m.y * d }
    const t1 = { x: p.x + u1.x * t, y: p.y + u1.y * t }
    const t2 = { x: p.x + u2.x * t, y: p.y + u2.y * t }
    const a1 = Math.atan2(t1.y - c.y, t1.x - c.x)
    let sweep = Math.atan2(t2.y - c.y, t2.x - c.x) - a1
    sweep = (((sweep + Math.PI) % TAU) + TAU) % TAU - Math.PI
    const arc = arcSegs(c, r, r, a1, sweep)
    // Pin the arc ends to the exact tangent points so the straight edges meet them with no gap.
    arc[0].p0 = t1
    arc[arc.length - 1].p3 = t2
    return { entry: t1, exit: t2, arc }
  })
  const segs: Seg[] = []
  for (let i = 0; i < n; i++) {
    const k = corners[i]
    if (k.arc) segs.push(...k.arc)
    const next = corners[(i + 1) % n]
    if (!near(k.exit, next.entry, 1e-9)) segs.push({ p0: k.exit, p3: next.entry })
  }
  if (!segs.length) return [segsToPen(pts.map((p, i) => ({ p0: p, p3: pts[(i + 1) % n] })), true)]
  return [segsToPen(segs, true)]
}

function unit(x: number, y: number): Pt {
  const l = Math.hypot(x, y) || 1
  return { x: x / l, y: y / l }
}

/** Every straight edge of a polygon, as line segments. */
export function polygonPen(pts: Pt[]): PenContour {
  return segsToPen(pts.map((p, i) => ({ p0: p, p3: pts[(i + 1) % pts.length] })), true)
}

// ---- arc recovery ------------------------------------------------------------------------------
// Template outlines are built with booleans and offsets on polylines. Their round parts are arcs
// sampled onto circles (circle holes, Clipper's round joins), so the arcs can be found again: runs of
// four or more points that sit on one circle and turn gently the same way become true arcs. Any other
// vertex is kept as a straight edge, exactly as before, so recovery never bends a real corner.

/** Points further than this (mm) from the fitted circle end an arc run. */
const RECOVER_EPS = 0.01
/**
 * An edge whose chord sits further than this (mm) from its arc is a straight line, not a sampled arc: a long
 * edge running off the end of a round may have both its ends on the circle and still be straight.
 */
const MAX_SAGITTA = 0.05
/** A vertex turning more than this is a corner, never part of an arc (a 10-gon's 36 degrees stays sharp). */
const MAX_ARC_TURN = (35 * Math.PI) / 180

function turnAt(a: Pt, b: Pt, c: Pt): number {
  const x1 = b.x - a.x
  const y1 = b.y - a.y
  const x2 = c.x - b.x
  const y2 = c.y - b.y
  return Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2)
}

function circleThrough(a: Pt, b: Pt, c: Pt): { c: Pt; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-12) return null
  const a2 = a.x * a.x + a.y * a.y
  const b2 = b.x * b.x + b.y * b.y
  const c2 = c.x * c.x + c.y * c.y
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d
  const r = Math.hypot(a.x - x, a.y - y)
  return Number.isFinite(r) && r < 1e5 ? { c: { x, y }, r } : null
}

/** The circle through q[i..j] (inclusive), if every point is on it and every inner vertex turns gently one way. */
function arcFit(q: Pt[], i: number, j: number, turns: number[]): { c: Pt; r: number } | null {
  const sign = Math.sign(turns[i + 1])
  for (let k = i + 1; k < j; k++) {
    const t = turns[k]
    if (Math.sign(t) !== sign || Math.abs(t) < 1e-4 || Math.abs(t) > MAX_ARC_TURN) return null
  }
  const fit = circleThrough(q[i], q[(i + j) >> 1], q[j])
  if (!fit) return null
  for (let k = i; k <= j; k++) if (Math.abs(Math.hypot(q[k].x - fit.c.x, q[k].y - fit.c.y) - fit.r) > RECOVER_EPS) return null
  for (let k = i; k < j; k++) {
    const half = Math.hypot(q[k + 1].x - q[k].x, q[k + 1].y - q[k].y) / 2
    if (half >= fit.r || fit.r - Math.sqrt(fit.r * fit.r - half * half) > MAX_SAGITTA) return null
  }
  return fit
}

function arcBetween(q: Pt[], i: number, j: number, fit: { c: Pt; r: number }): Seg[] {
  const ang = (p: Pt) => Math.atan2(p.y - fit.c.y, p.x - fit.c.x)
  let sweep = 0
  for (let k = i; k < j; k++) {
    let d = ang(q[k + 1]) - ang(q[k])
    d = Math.atan2(Math.sin(d), Math.cos(d))
    sweep += d
  }
  const segs = arcSegs(fit.c, fit.r, fit.r, ang(q[i]), sweep)
  segs[0].p0 = q[i]
  segs[segs.length - 1].p3 = q[j]
  return segs
}

/** A closed polyline as lines and recovered arcs (see above). */
export function recoverCurves(c: Contour): PenContour {
  const pts = c.pts
  const n = pts.length
  if (!c.closed || n < 4) return segsToPen(pts.slice(1).map((p, i) => ({ p0: pts[i], p3: p })), false)
  const turnsAll = pts.map((p, i) => turnAt(pts[(i - 1 + n) % n], p, pts[(i + 1) % n]))
  // Start the walk at a corner, so no arc is split by the seam.
  let start = turnsAll.findIndex((t) => Math.abs(t) > MAX_ARC_TURN || Math.abs(t) < 1e-4)
  if (start < 0) {
    // Nothing but gentle turns: a whole circle, if every point is on one.
    const fit = circleThrough(pts[0], pts[Math.floor(n / 3)], pts[Math.floor((2 * n) / 3)])
    if (fit && pts.every((p) => Math.abs(Math.hypot(p.x - fit.c.x, p.y - fit.c.y) - fit.r) <= RECOVER_EPS)) {
      const a0 = Math.atan2(pts[0].y - fit.c.y, pts[0].x - fit.c.x)
      return segsToPen(arcSegs(fit.c, fit.r, fit.r, a0, Math.sign(turnsAll[0]) * TAU), true)
    }
    start = 0
  }
  const q = [...pts.slice(start), ...pts.slice(0, start), pts[start]]
  const turns = [...turnsAll.slice(start), ...turnsAll.slice(0, start), turnsAll[start]]
  const segs: Seg[] = []
  let i = 0
  while (i < n) {
    let best = -1
    let bestFit: { c: Pt; r: number } | null = null
    for (let j = i + 3; j <= n; j++) {
      const fit = arcFit(q, i, j, turns)
      if (!fit) break
      best = j
      bestFit = fit
    }
    if (bestFit) {
      segs.push(...arcBetween(q, i, best, bestFit))
      i = best
    } else {
      segs.push({ p0: q[i], p3: q[i + 1] })
      i++
    }
  }
  return segsToPen(segs, true)
}

/** Recover curves for every contour of a template outline. */
export function recoverAll(cs: Contour[]): PenContour[] {
  return cs.map(recoverCurves)
}

// ---- bounds ------------------------------------------------------------------------------------

/** Exact bounding box of pen contours (cubic extrema, not just the control points). */
export function penBounds(pens: PenContour[]): { minX: number; minY: number; maxX: number; maxY: number } {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  const add = (p: Pt) => {
    if (p.x < b.minX) b.minX = p.x
    if (p.y < b.minY) b.minY = p.y
    if (p.x > b.maxX) b.maxX = p.x
    if (p.y > b.maxY) b.maxY = p.y
  }
  for (const pc of pens) {
    const ns = pc.nodes
    const segs = ns.length < 2 ? 0 : pc.closed ? ns.length : ns.length - 1
    if (ns.length) add(ns[0])
    for (let i = 0; i < segs; i++) {
      const a = ns[i]
      const z = ns[(i + 1) % ns.length]
      add(z)
      if (!a.out && !z.in) continue
      const p0 = a
      const p1 = a.out ?? a
      const p2 = z.in ?? z
      const p3 = z
      for (const axis of ['x', 'y'] as const) {
        for (const t of cubicExtrema(p0[axis], p1[axis], p2[axis], p3[axis])) {
          const u = 1 - t
          add({
            x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
            y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
          })
        }
      }
    }
  }
  return b
}

/** Parameters in (0,1) where a 1-D cubic has zero derivative. */
function cubicExtrema(p0: number, p1: number, p2: number, p3: number): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3
  const b = 2 * (p0 - 2 * p1 + p2)
  const c = p1 - p0
  const out: number[] = []
  if (Math.abs(a) < 1e-12) {
    if (Math.abs(b) > 1e-12) out.push(-c / b)
  } else {
    const disc = b * b - 4 * a * c
    if (disc >= 0) {
      const s = Math.sqrt(disc)
      out.push((-b + s) / (2 * a), (-b - s) / (2 * a))
    }
  }
  return out.filter((t) => t > 0 && t < 1)
}

// ---- SVG path data ------------------------------------------------------------------------------

/** Relative error allowed when an SVG arc is drawn as cubics (1e-5 of its radius: invisible at any zoom). */
const SVG_ARC_REL_TOL = 1e-5

/**
 * SVG path data as pen contours, one per subpath, with nothing flattened: lines and cubics are kept as
 * they are, quadratics become the identical cubic, and arcs become cubics within 1e-5 of their radius.
 * A subpath is closed only when the data closes it (Z), as SVG draws it.
 */
export function parsePathPen(d: string): PenContour[] {
  const out: PenContour[] = []
  let segs: Seg[] = []
  let pos: Pt = { x: 0, y: 0 }
  let start: Pt = { x: 0, y: 0 }
  let open = false
  const flush = (closed: boolean) => {
    if (segs.length) {
      const pc = segsToPen(segs, closed)
      if (pc.nodes.length >= 2) out.push({ ...pc, closed: closed && pc.nodes.length >= 2 })
    }
    segs = []
    open = false
  }
  for (const o of pathOps(d)) {
    if (o.op === 'M') {
      flush(false)
      pos = start = o.p
      open = true
      continue
    }
    if (o.op === 'Z') {
      if (open && (pos.x !== start.x || pos.y !== start.y)) segs.push({ p0: pos, p3: start })
      flush(true)
      pos = start
      continue
    }
    // Drawing after Z without a new M starts a subpath at the old start.
    open = true
    if (o.op === 'L') segs.push({ p0: pos, p3: o.p })
    else if (o.op === 'C') segs.push({ p0: pos, c1: o.p1, c2: o.p2, p3: o.p })
    else if (o.op === 'Q') {
      segs.push({
        p0: pos,
        c1: { x: pos.x + ((o.p1.x - pos.x) * 2) / 3, y: pos.y + ((o.p1.y - pos.y) * 2) / 3 },
        c2: { x: o.p.x + ((o.p1.x - o.p.x) * 2) / 3, y: o.p.y + ((o.p1.y - o.p.y) * 2) / 3 },
        p3: o.p,
      })
    } else {
      const a = arcCentre(pos, o.rx, o.ry, o.phi, o.large, o.sweep, o.p)
      if (!a) segs.push({ p0: pos, p3: o.p })
      else {
        const cos = Math.cos(a.phi)
        const sin = Math.sin(a.phi)
        const rot = (q: Pt): Pt => ({ x: cos * q.x - sin * q.y + a.cx, y: sin * q.x + cos * q.y + a.cy })
        const pieces = arcSegs({ x: 0, y: 0 }, a.rx, a.ry, a.t1, a.dt, SVG_ARC_REL_TOL * Math.max(a.rx, a.ry))
        pieces.forEach((g, i) => segs.push({ p0: i ? rot(g.p0) : pos, c1: rot(g.c1!), c2: rot(g.c2!), p3: i === pieces.length - 1 ? o.p : rot(g.p3) }))
      }
    }
    pos = o.p
  }
  flush(false)
  return out
}

// ---- union that keeps curves --------------------------------------------------------------------
// Overlapping closed outlines (the parts of a glyph, touching letters) have to be merged into one clean
// outline for cutting. The merge itself runs on polylines, but every vertex it returns is either one of
// our own flattened points or a crossing on one of our chords, so each stretch of the result can be traced
// back to the curve it came from and rebuilt from that curve: only the crossings are new points.

/** Flattening used for the union (mm). Crossings are found on these chords, so this bounds their error. */
const UNION_TOL = 0.02

interface Traced {
  pc: PenContour
  pts: Pt[]
  /** Curve position of each point: segment index + t. */
  pos: number[]
  nseg: number
}

function traceFlatten(pc: PenContour): Traced {
  const ns = pc.nodes
  const nseg = pc.closed ? ns.length : ns.length - 1
  const pts: Pt[] = []
  const pos: number[] = []
  for (let k = 0; k < nseg; k++) {
    const a = ns[k]
    const b = ns[(k + 1) % ns.length]
    pts.push({ x: a.x, y: a.y })
    pos.push(k)
    if (!a.out && !b.in) continue
    const c1 = a.out ?? a
    const c2 = b.in ?? b
    const len = Math.hypot(c1.x - a.x, c1.y - a.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(b.x - c2.x, b.y - c2.y)
    const n = segCount(len, UNION_TOL)
    for (let i = 1; i < n; i++) {
      pts.push(cubicPt(a, c1, c2, b, i / n))
      pos.push(k + i / n)
    }
  }
  return { pc, pts, pos, nseg }
}

function cubicPt(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t: number): Pt {
  const u = 1 - t
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  }
}

const lerpPt = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })

/** The part of a cubic between t0 and t1 (de Casteljau, twice). */
function subCubic(p0: Pt, p1: Pt, p2: Pt, p3: Pt, t0: number, t1: number): [Pt, Pt, Pt, Pt] {
  const split = (q0: Pt, q1: Pt, q2: Pt, q3: Pt, t: number): [[Pt, Pt, Pt, Pt], [Pt, Pt, Pt, Pt]] => {
    const a = lerpPt(q0, q1, t)
    const b = lerpPt(q1, q2, t)
    const c = lerpPt(q2, q3, t)
    const d = lerpPt(a, b, t)
    const e = lerpPt(b, c, t)
    const f = lerpPt(d, e, t)
    return [
      [q0, a, d, f],
      [f, e, c, q3],
    ]
  }
  const left = t1 < 1 ? split(p0, p1, p2, p3, t1)[0] : ([p0, p1, p2, p3] as [Pt, Pt, Pt, Pt])
  if (t0 <= 0) return left
  return split(left[0], left[1], left[2], left[3], t1 > 0 ? t0 / t1 : 0)[1]
}

/** Curve position at a fractional flattened index. */
function posAt(tr: Traced, f: number): number {
  const n = tr.pts.length
  const j = Math.floor(f)
  const frac = f - j
  const a = tr.pos[((j % n) + n) % n]
  const b = j + 1 >= n ? tr.nseg : tr.pos[j + 1]
  return a + (b - a) * frac
}

/** Segments of contour `tr` from curve position a forward to b (b may wrap past the end). */
function curveBetween(tr: Traced, a: number, b: number): Seg[] {
  const ns = tr.pc.nodes
  if (b < a) b += tr.nseg
  const out: Seg[] = []
  for (let k = Math.floor(a); k < b - 1e-12; k++) {
    const t0 = Math.max(a - k, 0)
    const t1 = Math.min(b - k, 1)
    if (t1 - t0 < 1e-12) continue
    const s = ((k % tr.nseg) + tr.nseg) % tr.nseg
    const p = ns[s]
    const q = ns[(s + 1) % ns.length]
    if (!p.out && !q.in) out.push({ p0: lerpPt(p, q, t0), p3: lerpPt(p, q, t1) })
    else {
      const [c0, c1, c2, c3] = subCubic(p, p.out ?? p, q.in ?? q, q, t0, t1)
      out.push({ p0: c0, c1, c2, p3: c3 })
    }
  }
  return out
}

const reverseSegs = (segs: Seg[]): Seg[] => segs.slice().reverse().map((g) => ({ p0: g.p3, c1: g.c2, c2: g.c1, p3: g.p0 }))

function segDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y)
}

/**
 * Nonzero union of closed pen contours that keeps their curves: outlines that do not overlap anything come
 * back untouched, merged ones are rebuilt from the pieces of the original curves between the crossings.
 * Open contours pass through unchanged.
 */
export function unionCurves(pens: PenContour[]): PenContour[] {
  const closed = pens.filter((pc) => pc.closed && pc.nodes.length >= 2)
  const open = pens.filter((pc) => !pc.closed)
  const traced = closed.map(traceFlatten).filter((t) => t.pts.length >= 3)
  const merged = unionNonZero(traced.map((t) => ({ pts: t.pts, closed: true })))
  const key = (p: Pt) => Math.round(p.x * 1000) + ',' + Math.round(p.y * 1000)
  const byKey = new Map<string, { c: number; f: number }[]>()
  traced.forEach((t, c) =>
    t.pts.forEach((p, i) => {
      const k = key(p)
      const list = byKey.get(k)
      if (list) list.push({ c, f: i })
      else byKey.set(k, [{ c, f: i }])
    }),
  )
  // Where on our own polylines a merged vertex sits: one of our points, or a crossing on one of our chords.
  const locate = (p: Pt): { c: number; f: number }[] => {
    const hit = byKey.get(key(p))
    if (hit) return hit
    const out: { c: number; f: number }[] = []
    traced.forEach((t, c) => {
      const n = t.pts.length
      for (let i = 0; i < n; i++) {
        const a = t.pts[i]
        const b = t.pts[(i + 1) % n]
        if (segDistance(p, a, b) > 0.002) continue
        const dx = b.x - a.x
        const dy = b.y - a.y
        const l2 = dx * dx + dy * dy
        out.push({ c, f: i + (l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0) })
      }
    })
    return out
  }

  const result: PenContour[] = []
  for (const u of merged) {
    const pts = u.pts
    const n = pts.length
    const where = pts.map(locate)
    // Each merged edge: the contour it runs along and in which direction, if it follows one of ours.
    type Edge = { c: number; fa: number; fb: number; dir: 1 | -1 } | null
    const edges: Edge[] = pts.map((p, i) => {
      const q = pts[(i + 1) % n]
      for (const a of where[i])
        for (const b of where[(i + 1) % n]) {
          if (a.c !== b.c) continue
          const t = traced[a.c]
          const N = t.pts.length
          for (const dir of [1, -1] as const) {
            const span = (((b.f - a.f) * dir) % N + N) % N
            if (span < 1e-9) continue
            if (span > 1 + 1e-6) {
              // Clipper drops points that sit on a straight run; allow that, never a cut corner.
              if (span > 16) continue
              let ok = true
              for (let s = 1; s < span; s++) {
                const idx = (((Math.ceil(a.f) + (dir > 0 ? s - 1 : -(s - 1))) % N) + N) % N
                if (segDistance(t.pts[idx], p, q) > 0.002) ok = false
              }
              if (!ok) continue
            }
            return { c: a.c, fa: a.f, fb: b.f, dir }
          }
        }
      return null
    })
    const cont = (e: Edge, g: Edge) => !!e && !!g && e.c === g.c && e.dir === g.dir && Math.abs(e.fb - g.fa) < 1e-6
    // Untouched outline: every edge follows one contour all the way round. Give back the original.
    if (edges.every((e, i) => cont(e, edges[(i + 1) % n])) && edges[0] && new Set(edges.map((e) => e!.c)).size === 1) {
      const pc = traced[edges[0].c].pc
      result.push(edges[0].dir > 0 ? pc : segsToPen(reverseSegs(penSegs(pc)), true))
      continue
    }
    // Start at a break between runs so no run is split by the seam.
    let s0 = edges.findIndex((e, i) => !cont(edges[(i - 1 + n) % n], e))
    if (s0 < 0) s0 = 0
    const segs: Seg[] = []
    for (let k = 0; k < n; ) {
      const i = (s0 + k) % n
      const e = edges[i]
      if (!e) {
        segs.push({ p0: pts[i], p3: pts[(i + 1) % n] })
        k++
        continue
      }
      let len = 1
      while (k + len < n && cont(edges[(s0 + k + len - 1) % n], edges[(s0 + k + len) % n])) len++
      const last = edges[(s0 + k + len - 1) % n]!
      const tr = traced[e.c]
      const a = posAt(tr, e.fa)
      const b = posAt(tr, last.fb)
      let piece = e.dir > 0 ? curveBetween(tr, a, b) : reverseSegs(curveBetween(tr, b, a))
      if (!piece.length) piece = [{ p0: pts[i], p3: pts[(s0 + k + len) % n] }]
      // Pin the ends to the merged outline's vertices (they differ only at crossings, by under the flattening).
      const start = pts[i]
      const end = pts[(s0 + k + len) % n]
      const f = piece[0]
      if (f.c1) f.c1 = { x: f.c1.x + start.x - f.p0.x, y: f.c1.y + start.y - f.p0.y }
      f.p0 = start
      const l = piece[piece.length - 1]
      if (l.c2) l.c2 = { x: l.c2.x + end.x - l.p3.x, y: l.c2.y + end.y - l.p3.y }
      l.p3 = end
      segs.push(...piece)
      k += len
    }
    const pc = segsToPen(segs, true)
    // Safety: the rebuilt outline must follow the merged polyline; otherwise keep the polyline itself.
    result.push(followsPolyline(pc, pts) ? pc : polygonPen(pts))
  }
  return [...result, ...open]
}

function penSegs(pc: PenContour): Seg[] {
  const ns = pc.nodes
  const nseg = pc.closed ? ns.length : ns.length - 1
  const out: Seg[] = []
  for (let k = 0; k < nseg; k++) {
    const a = ns[k]
    const b = ns[(k + 1) % ns.length]
    out.push(a.out || b.in ? { p0: a, c1: a.out ?? a, c2: b.in ?? b, p3: b } : { p0: a, p3: b })
  }
  return out
}

/** Every vertex of the polyline lies within the flattening tolerance of the curve. */
function followsPolyline(pc: PenContour, pts: Pt[]): boolean {
  const t = traceFlatten(pc)
  const m = t.pts.length
  if (m < 3) return false
  for (const p of pts) {
    let best = Infinity
    for (let i = 0; i < m && best > UNION_TOL * 2; i++) best = Math.min(best, segDistance(p, t.pts[i], t.pts[(i + 1) % m]))
    if (best > UNION_TOL * 2) return false
  }
  return true
}
