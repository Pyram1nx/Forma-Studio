// Planar regions for the joint engine: sets of closed rings (outer rings and holes, opposite
// windings, non-zero fill), with the booleans and round offsets a router bit implies.
//
// The two operations that model cutting:
//  - opening(waste, r): what a bit of radius r actually removes when told to clear `waste`
//    (it cannot reach into the waste's convex corners, which stay as fillets of radius r on the part);
//  - dilate(region, g): a region grown by g all round (glue gaps, clearances).
//
// Clipper works on integers: 1 unit = 1 µm.
import ClipperLib from 'clipper-lib'
import type { Contour, Pt } from '../../model/types'

const S = 1000
/** Arc tolerance for round offsets, mm. Fine enough that a 2 mm bit's corner reads as a curve. */
const ARC_TOL = 0.01

type IntPath = { X: number; Y: number }[]

/** A closed ring of points (mm); the last point does not repeat the first. */
export type Ring = Pt[]
/** Outer rings and holes, opposite windings; filled non-zero. */
export type Region = Ring[]

const toInt = (r: Ring): IntPath => r.map((p) => ({ X: Math.round(p.x * S), Y: Math.round(p.y * S) }))
const fromInt = (p: IntPath): Ring => p.map((q) => ({ x: q.X / S, y: q.Y / S }))
const out = (paths: IntPath[]): Region => paths.filter((p) => p.length >= 3).map(fromInt)

function ringArea(r: Ring): number {
  let a = 0
  for (let i = 0, n = r.length; i < n; i++) {
    const p = r[i]
    const q = r[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** A simple polygon as a region (either winding in, positive winding out). */
export function poly(pts: Pt[]): Region {
  if (pts.length < 3) return []
  return [ringArea(pts) < 0 ? pts.slice().reverse() : pts.slice()]
}

export function rect(x0: number, y0: number, x1: number, y1: number): Region {
  return poly([
    { x: Math.min(x0, x1), y: Math.min(y0, y1) },
    { x: Math.max(x0, x1), y: Math.min(y0, y1) },
    { x: Math.max(x0, x1), y: Math.max(y0, y1) },
    { x: Math.min(x0, x1), y: Math.max(y0, y1) },
  ])
}

/** Segments for an arc of radius r so the chord sags at most ARC_TOL. */
function arcSteps(r: number, sweep: number): number {
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - ARC_TOL / Math.max(r, ARC_TOL))))
  return Math.max(8, Math.ceil(Math.abs(sweep) / Math.max(step, 0.02)))
}

/**
 * A stadium (slot) centred at (cx, cy): two half circles of radius r joined by straight sides,
 * `len` long along x between the circle centres. len = 0 is a circle.
 */
export function stadium(cx: number, cy: number, len: number, r: number): Region {
  if (r <= 0) return []
  const h = Math.max(0, len) / 2
  const n = arcSteps(r, Math.PI)
  const pts: Pt[] = []
  for (let i = 0; i <= n; i++) {
    const t = -Math.PI / 2 + (Math.PI * i) / n
    pts.push({ x: cx + h + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  for (let i = 0; i <= n; i++) {
    const t = Math.PI / 2 + (Math.PI * i) / n
    pts.push({ x: cx - h + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  return poly(h > 0 ? pts : pts.slice(0, -1))
}

function run(op: number, a: Region, b: Region): Region {
  try {
    const c = new ClipperLib.Clipper()
    c.AddPaths(a.map(toInt), ClipperLib.PolyType.ptSubject, true)
    if (b.length) c.AddPaths(b.map(toInt), ClipperLib.PolyType.ptClip, true)
    const res: IntPath[] = []
    c.Execute(op, res, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    return out(res)
  } catch {
    return []
  }
}

export const union = (...rs: Region[]): Region => run(ClipperLib.ClipType.ctUnion, rs.flat(), [])
export const diff = (a: Region, b: Region): Region => run(ClipperLib.ClipType.ctDifference, a, b)
export const inter = (a: Region, b: Region): Region => run(ClipperLib.ClipType.ctIntersection, a, b)

/** Grow (d > 0) or shrink (d < 0) with round corners. */
export function offset(r: Region, d: number): Region {
  if (Math.abs(d) < 1e-6) return union(r)
  try {
    const co = new ClipperLib.ClipperOffset(2, ARC_TOL * S)
    co.AddPaths(r.map(toInt), ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
    const res: IntPath[] = []
    co.Execute(res, d * S)
    return out(res)
  } catch {
    return []
  }
}

/** What a bit of radius r clears when it is told to clear `waste`. */
export const opening = (waste: Region, r: number): Region => (r > 1e-6 ? offset(offset(waste, -r), r) : union(waste))

/** Net area, mm² (holes subtract). */
export const area = (r: Region): number => r.reduce((s, ring) => s + ringArea(ring), 0)

export interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export function bounds(r: Region): Bounds {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const ring of r)
    for (const p of ring) {
      if (p.x < b.minX) b.minX = p.x
      if (p.y < b.minY) b.minY = p.y
      if (p.x > b.maxX) b.maxX = p.x
      if (p.y > b.maxY) b.maxY = p.y
    }
  return b
}

/** Non-zero winding test. */
export function contains(r: Region, p: Pt): boolean {
  let w = 0
  for (const ring of r) {
    for (let i = 0, n = ring.length; i < n; i++) {
      const a = ring[i]
      const b = ring[(i + 1) % n]
      if (a.y <= p.y) {
        if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++
      } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--
    }
  }
  return w !== 0
}

/** One connected piece: its outer ring (positive winding) and its holes (negative winding). */
export interface Piece {
  outer: Ring
  holes: Ring[]
}

/** Split a region into its connected pieces, each with its own holes. */
export function pieces(r: Region): Piece[] {
  try {
    const c = new ClipperLib.Clipper()
    c.AddPaths(r.map(toInt), ClipperLib.PolyType.ptSubject, true)
    const tree = new ClipperLib.PolyTree()
    c.Execute(ClipperLib.ClipType.ctUnion, tree, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
    const res: Piece[] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const walk = (node: any) => {
      for (const outerNode of node.Childs()) {
        const outer = fromInt(outerNode.Contour())
        const holes: Ring[] = []
        for (const holeNode of outerNode.Childs()) {
          holes.push(fromInt(holeNode.Contour()))
          walk(holeNode)
        }
        if (outer.length >= 3) res.push({ outer: ringArea(outer) < 0 ? outer.reverse() : outer, holes: holes.map((h) => (ringArea(h) > 0 ? h.reverse() : h)) })
      }
    }
    walk(tree)
    return res
  } catch {
    return []
  }
}

/** A piece back as a region. */
export const pieceRegion = (p: Piece): Region => [p.outer, ...p.holes]

/** Closed contours for shapes and SVG previews. */
export const toContours = (r: Region): Contour[] => r.map((ring) => ({ closed: true, pts: ring.slice() }))

/**
 * Run a region out across the sides of a stock rectangle it touches: wherever it meets a side,
 * the strip it occupies there is extended straight out by `runOut`, so a pocket cut to it clears
 * the board's faces cleanly instead of stopping on them.
 */
export function runOut(r: Region, stock: Bounds, runOutBy: number): Region {
  const d = 0.002
  const add: Region[] = []
  const sides: { slab: Region; ext: (b: Bounds) => Region }[] = [
    { slab: rect(stock.minX - 1, stock.minY - 1, stock.maxX + 1, stock.minY + d), ext: (b) => rect(b.minX, stock.minY - runOutBy, b.maxX, stock.minY + d) },
    { slab: rect(stock.minX - 1, stock.maxY - d, stock.maxX + 1, stock.maxY + 1), ext: (b) => rect(b.minX, stock.maxY - d, b.maxX, stock.maxY + runOutBy) },
    { slab: rect(stock.minX - 1, stock.minY - 1, stock.minX + d, stock.maxY + 1), ext: (b) => rect(stock.minX - runOutBy, b.minY, stock.minX + d, b.maxY) },
    { slab: rect(stock.maxX - d, stock.minY - 1, stock.maxX + 1, stock.maxY + 1), ext: (b) => rect(stock.maxX - d, b.minY, stock.maxX + runOutBy, b.maxY) },
  ]
  for (const s of sides) for (const p of pieces(inter(r, s.slab))) add.push(s.ext(bounds([p.outer])))
  return union(r, ...add)
}
