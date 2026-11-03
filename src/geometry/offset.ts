// Thin wrapper around Clipper (clipper-lib) for polygon offsetting and booleans.
// Clipper works on integers, so mm coordinates are scaled by SCALE (1 unit = 1 µm).
import ClipperLib from 'clipper-lib'
import type { Contour, Pt } from '../model/types'

const SCALE = 1000

type IntPath = { X: number; Y: number }[]

function toInt(pts: Pt[]): IntPath {
  return pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))
}

function fromInt(path: IntPath): Pt[] {
  return path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }))
}

function closedPaths(contours: Contour[]): IntPath[] {
  return clean(contours)
    .filter((c) => c.closed)
    .map((c) => toInt(c.pts))
}

function toContours(paths: IntPath[]): Contour[] {
  return paths.filter((p) => p.length >= 3).map((p) => ({ pts: fromInt(p), closed: true }))
}

export type JoinStyle = 'round' | 'miter' | 'square'

const JOIN = {
  round: ClipperLib.JoinType.jtRound,
  miter: ClipperLib.JoinType.jtMiter,
  square: ClipperLib.JoinType.jtSquare,
}

/** Drop non-finite points and contours too short to mean anything. */
function clean(contours: Contour[]): Contour[] {
  const out: Contour[] = []
  for (const c of contours) {
    if (!c || !Array.isArray(c.pts)) continue
    const pts = c.pts.filter((p) => p && Number.isFinite(p.x) && Number.isFinite(p.y))
    if (pts.length < (c.closed ? 3 : 2)) continue
    out.push({ pts, closed: !!c.closed })
  }
  return out
}

/**
 * Offset contours by `delta` mm (positive grows, negative shrinks closed shapes).
 * Closed contours are unioned with even-odd first, so holes stay holes.
 *
 * Open contours (polylines) have no inside or outside, so they are always
 * stroked: the result is the outline of a band of radius |delta| around the
 * line, whatever the sign of delta. The output of both parts is unioned.
 *
 * Never throws: degenerate input (empty, non-finite, single points) yields [].
 */
export function offsetContours(contours: Contour[], delta: number, join: JoinStyle = 'round'): Contour[] {
  try {
    if (!Number.isFinite(delta)) return []
    const cs = clean(contours)
    if (Math.abs(delta) < 1e-6) return cs.map((c) => ({ pts: c.pts.slice(), closed: c.closed }))
    const closed = cs.filter((c) => c.closed)
    const open = cs.filter((c) => !c.closed)
    const parts: IntPath[] = []
    if (closed.length) {
      const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE)
      co.AddPaths(normalize(closed), JOIN[join], ClipperLib.EndType.etClosedPolygon)
      const out: IntPath[] = []
      co.Execute(out, delta * SCALE)
      parts.push(...out)
    }
    if (open.length) {
      const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE)
      for (const c of open) co.AddPath(toInt(c.pts), JOIN[join], ClipperLib.EndType.etOpenRound)
      const out: IntPath[] = []
      co.Execute(out, Math.abs(delta) * SCALE)
      parts.push(...out)
    }
    if (!parts.length) return []
    if (closed.length && open.length) {
      const c = new ClipperLib.Clipper()
      c.AddPaths(parts, ClipperLib.PolyType.ptSubject, true)
      const merged: IntPath[] = []
      c.Execute(ClipperLib.ClipType.ctUnion, merged, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
      return toContours(merged)
    }
    return toContours(parts)
  } catch {
    return []
  }
}

/** Offset an open polyline as a centred stroke of width `width` mm. */
export function strokeOutline(contours: Contour[], width: number): Contour[] {
  try {
    if (!Number.isFinite(width) || width <= 0) return []
    const co = new ClipperLib.ClipperOffset(2, 0.02 * SCALE)
    for (const c of clean(contours)) {
      co.AddPath(toInt(c.pts), JOIN.round, c.closed ? ClipperLib.EndType.etClosedLine : ClipperLib.EndType.etOpenRound)
    }
    const out: IntPath[] = []
    co.Execute(out, (width / 2) * SCALE)
    return toContours(out)
  } catch {
    return []
  }
}

/** Union all closed contours using even-odd fill (so holes stay holes). */
export function normalize(contours: Contour[], fill: 'evenodd' | 'nonzero' = 'evenodd'): IntPath[] {
  const c = new ClipperLib.Clipper()
  c.AddPaths(closedPaths(contours), ClipperLib.PolyType.ptSubject, true)
  const out: IntPath[] = []
  const ft = fill === 'evenodd' ? ClipperLib.PolyFillType.pftEvenOdd : ClipperLib.PolyFillType.pftNonZero
  c.Execute(ClipperLib.ClipType.ctUnion, out, ft, ft)
  return out
}

/**
 * Merge overlapping closed contours with non-zero fill, the rule fonts are drawn with: glyphs
 * built from overlapping parts become one clean outline, and opposite-winding contours stay holes.
 * Open contours are returned untouched.
 */
export function unionNonZero(contours: Contour[]): Contour[] {
  try {
    const closed = clean(contours).filter((c) => c.closed)
    const open = contours.filter((c) => !c.closed)
    const c = new ClipperLib.Clipper()
    c.AddPaths(closed.map((k) => toInt(k.pts)), ClipperLib.PolyType.ptSubject, true)
    const out: IntPath[] = []
    c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    return [...toContours(out), ...open]
  } catch {
    return contours
  }
}

export type BoolOp = 'union' | 'difference' | 'intersection' | 'xor'

const CLIP = {
  union: ClipperLib.ClipType.ctUnion,
  difference: ClipperLib.ClipType.ctDifference,
  intersection: ClipperLib.ClipType.ctIntersection,
  xor: ClipperLib.ClipType.ctXor,
}

/** Boolean operation between two sets of closed contours (even-odd within each set). */
export function boolean(op: BoolOp, subject: Contour[], clip: Contour[]): Contour[] {
  try {
    const c = new ClipperLib.Clipper()
    c.AddPaths(normalize(clean(subject)), ClipperLib.PolyType.ptSubject, true)
    c.AddPaths(normalize(clean(clip)), ClipperLib.PolyType.ptClip, true)
    const out: IntPath[] = []
    c.Execute(CLIP[op], out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    return toContours(out)
  } catch {
    return []
  }
}

/** Signed area in mm² (positive = clockwise in screen space / y-down). */
export function signedArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify(pts: Pt[], tol: number, closed = false): Pt[] {
  if (pts.length < 3) return pts.slice()
  const src = closed ? [...pts, pts[0]] : pts
  const keep = new Uint8Array(src.length)
  keep[0] = keep[src.length - 1] = 1
  const stack: [number, number][] = [[0, src.length - 1]]
  const tol2 = tol * tol
  while (stack.length) {
    const [a, b] = stack.pop()!
    let maxD = 0
    let idx = -1
    const A = src[a]
    const B = src[b]
    const dx = B.x - A.x
    const dy = B.y - A.y
    const len2 = dx * dx + dy * dy || 1e-12
    for (let i = a + 1; i < b; i++) {
      const P = src[i]
      let t = ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      const ex = A.x + t * dx - P.x
      const ey = A.y + t * dy - P.y
      const d = ex * ex + ey * ey
      if (d > maxD) {
        maxD = d
        idx = i
      }
    }
    if (idx >= 0 && maxD > tol2) {
      keep[idx] = 1
      stack.push([a, idx], [idx, b])
    }
  }
  const out = src.filter((_, i) => keep[i])
  if (closed) out.pop()
  return out
}

/**
 * Split a set of closed contours into connected regions. Each region is its outer
 * boundary followed by its holes, so a ring is one region and two separate blobs are two.
 */
export function splitRegions(contours: Contour[]): Contour[][] {
  try {
    const c = new ClipperLib.Clipper()
    // Strictly simple: a region pinched at touching points (square minus its inscribed
    // circle) splits into its separate pieces instead of staying one self-touching outline.
    c.StrictlySimple = true
    c.AddPaths(closedPaths(contours), ClipperLib.PolyType.ptSubject, true)
    const tree = new ClipperLib.PolyTree()
    c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    const out: Contour[][] = []
    // An island inside a hole is a new region, so walk the tree two levels at a time.
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        const region: Contour[] = [{ pts: fromInt(n.Contour()), closed: true }]
        const inner: any[] = []
        for (const hole of n.Childs()) {
          region.push({ pts: fromInt(hole.Contour()), closed: true })
          inner.push(...hole.Childs())
        }
        if (region[0].pts.length >= 3) out.push(region)
        walk(inner)
      }
    }
    walk(tree.Childs())
    return out
  } catch {
    return []
  }
}

/**
 * The fragments of a set of overlapping shapes: every distinct piece the outlines cut the
 * plane into (e.g. two overlapping squares give the overlap and the two crescents).
 * Slivers under `minArea` mm² are dropped.
 */
export function fragments(shapes: Contour[][], minArea = 0.01): Contour[][] {
  let cells: Contour[][] = []
  for (const p of shapes) {
    const next: Contour[][] = []
    let rest = p
    for (const cell of cells) {
      const inside = boolean('intersection', cell, p)
      const outside = boolean('difference', cell, p)
      if (inside.length) next.push(inside)
      if (outside.length) next.push(outside)
      rest = rest.length ? boolean('difference', rest, cell) : rest
    }
    if (rest.length) next.push(rest)
    cells = next
  }
  return cells
    .flatMap((cell) => splitRegions(cell))
    .filter((r) => Math.abs(r.reduce((a, c) => a + signedArea(c.pts), 0)) >= minArea)
}
