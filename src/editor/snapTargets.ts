import type { DocSettings, Pt, Shape, SnapKind } from '../model/types'
import { SNAP_KINDS } from '../model/types'
import { wbbox, world } from './geomCache'
import { snapToGridLines } from './grid'

export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
}

export interface SnapHit {
  pt: Pt
  guides: SnapGuideSpan[]
  kind: SnapKind | null
}

/** Whether a snap target is enabled (all are on unless the document turned them off). */
export function snapEnabled(settings: Pick<DocSettings, 'snap'>, kind: SnapKind): boolean {
  return settings.snap?.[kind] !== false
}

export function snapKindsOn(settings: Pick<DocSettings, 'snap'>): Record<SnapKind, boolean> {
  const out = {} as Record<SnapKind, boolean>
  for (const k of SNAP_KINDS) out[k] = snapEnabled(settings, k)
  return out
}

/** Turn angle (rad) above which a polyline vertex counts as a real corner rather than a step along a curve. */
const CORNER_TURN = (25 * Math.PI) / 180

/**
 * Which vertices of a contour are worth snapping to. Curves (rounded tips, circles, arcs) are stored as dense
 * polylines whose 10-20 degree steps are sampling noise, not features; offering each as a snap target buries the
 * real ones (e.g. a point cloud around y=0 makes the origin unreachable). Open ends and sharp corners stay.
 */
export function cornerFlags(c: { pts: Pt[]; closed: boolean }): boolean[] {
  const n = c.pts.length
  return c.pts.map((b, i) => {
    const a = c.pts[i - 1] ?? (c.closed ? c.pts[n - 1] : undefined)
    const d = c.pts[i + 1] ?? (c.closed ? c.pts[0] : undefined)
    if (!a || !d) return true
    let t = Math.atan2(d.y - b.y, d.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x)
    t = Math.abs(Math.atan2(Math.sin(t), Math.cos(t)))
    return t >= CORNER_TURN
  })
}

/**
 * Shaper Studio's snap distances in screen px. Its alignment helper pulls a moving edge or centre onto an object
 * line within 12 px and onto a grid line within 6 px.
 */
export const OBJECT_SNAP_PX = 12
export const GRID_SNAP_PX = 6

/** A line something can line up with: its world coordinate and the target's extent along the line (for the guide). */
export interface AlignLine {
  at: number
  lo: number
  hi: number
}

/** Alignment lines (vertical ones in `xs`, horizontal in `ys`) per enabled target. */
export function alignLines(shapes: Shape[], on: Record<SnapKind, boolean>): { xs: AlignLine[]; ys: AlignLine[] } {
  const xs: AlignLine[] = []
  const ys: AlignLine[] = []
  const pt = (q: Pt) => {
    xs.push({ at: q.x, lo: q.y, hi: q.y })
    ys.push({ at: q.y, lo: q.x, hi: q.x })
  }
  for (const s of shapes) {
    const b = wbbox(s)
    // As in Studio, a target's left, right and centre lines span the whole target.
    if (on.bounds) {
      xs.push({ at: b.minX, lo: b.minY, hi: b.maxY }, { at: b.maxX, lo: b.minY, hi: b.maxY })
      ys.push({ at: b.minY, lo: b.minX, hi: b.maxX }, { at: b.maxY, lo: b.minX, hi: b.maxX })
    }
    if (on.centers) {
      xs.push({ at: (b.minX + b.maxX) / 2, lo: b.minY, hi: b.maxY })
      ys.push({ at: (b.minY + b.maxY) / 2, lo: b.minX, hi: b.maxX })
    }
    if (on.points || on.midpoints) {
      for (const c of world(s)) {
        const n = c.pts.length
        const sharp = cornerFlags(c)
        for (let i = 0; i < n; i++) {
          if (!sharp[i]) continue
          const a = c.pts[i]
          if (on.points) pt(a)
          if (on.midpoints) {
            const j = i + 1 < n ? i + 1 : c.closed ? 0 : -1
            const nx = j >= 0 && sharp[j] ? c.pts[j] : undefined
            if (nx) pt({ x: (a.x + nx.x) / 2, y: (a.y + nx.y) / 2 })
          }
        }
      }
    }
  }
  if (on.origin) pt({ x: 0, y: 0 })
  return { xs, ys }
}

/** Alignment coordinates (world x / y) a moving or picked thing can line up with, per enabled target. */
export function alignCoords(shapes: Shape[], on: Record<SnapKind, boolean>): { xs: number[]; ys: number[] } {
  const { xs, ys } = alignLines(shapes, on)
  return { xs: xs.map((l) => l.at), ys: ys.map((l) => l.at) }
}

export interface AxisHit {
  /** Extra shift that puts the winning coordinate on the line. */
  shift: number
  at: number
  grid: boolean
  /** The object line hit (absent for grid lines). */
  line?: AlignLine
}

/**
 * Shaper's per-axis magnet. Every moving coordinate, moved by `delta`, is tested against the grid lines either side
 * (within `grid.tol`) and against every object line (within `tol`); the nearest wins, an object beating the grid on
 * a tie. `alignLines` lists the shared bounds and centre lines before the add-on points, so they win ties too.
 */
export function snapAxis(
  moving: number[],
  delta: number,
  lines: AlignLine[],
  tol: number,
  grid: { size: number; tol: number } | null,
): AxisHit | null {
  const g = grid ? snapToGridLines(moving, delta, grid.size, grid.tol) : null
  let best: (AxisHit & { d: number }) | null = g && { ...g, grid: true, d: Math.abs(g.shift) }
  for (const c of moving) {
    const m = c + delta
    for (const line of lines) {
      const d = Math.abs(line.at - m)
      // An object line beats the grid on a tie; among object lines the first listed (bounds, centres) keeps it.
      if (d < tol && (!best || d < best.d || (best.grid && d === best.d))) best = { shift: line.at - m, at: line.at, grid: false, line, d }
    }
  }
  if (!best) return null
  const { d: _d, ...hit } = best
  return hit
}

export interface SnapGuideSpan extends SnapGuide {
  /** World extent along the guide; absent for grid lines, which run across the view. */
  from?: number
  to?: number
  grid?: boolean
}

/** The guide for an axis hit: an object guide spans the moved thing and its target, as in Studio. */
export function guideFor(axis: 'x' | 'y', hit: AxisHit, lo: number, hi: number): SnapGuideSpan {
  if (hit.grid || !hit.line) return { axis, at: hit.at, grid: true }
  return { axis, at: hit.at, from: Math.min(lo, hit.line.lo), to: Math.max(hi, hit.line.hi) }
}

/**
 * Shaper's Shift constraint for a drag: within 18 degrees of a diagonal the move follows the diagonal (keeping its
 * length), otherwise it keeps only the nearer axis.
 */
export function orthoDelta(dx: number, dy: number): Pt {
  const a = Math.atan2(dy, dx) / Math.PI
  const len = Math.hypot(dx, dy)
  for (const q of [0.25, 0.75, -0.25, -0.75]) {
    if (Math.abs(a - q) < 0.1) return { x: Math.cos(Math.PI * q) * len, y: Math.sin(Math.PI * q) * len }
  }
  return Math.abs(a) < 0.25 || Math.abs(a) > 0.75 ? { x: dx, y: 0 } : { x: 0, y: dy }
}

export interface PointSnapOpts {
  /** Grid spacing and tolerance (world units) when Snap to grid is on. */
  grid?: { size: number; tol: number } | null
  /** Extra points to align with (e.g. the vertices of a path being drawn). */
  extra?: Pt[]
}

/**
 * Snap a world point to the enabled targets of the given shapes. Exact add-on targets come first (vertices,
 * midpoints, the origin), then the nearest spot on an edge; otherwise each axis is aligned on its own, as Studio
 * does, with the bounds and centre lines of the shapes, the add-on points and the grid.
 */
export function snapPoint(p: Pt, shapes: Shape[], on: Record<SnapKind, boolean>, tol: number, opts: PointSnapOpts = {}): SnapHit {
  let best: { pt: Pt; d: number; kind: SnapKind } | null = null
  const offer = (q: Pt, kind: SnapKind) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= tol && (!best || d < best.d)) best = { pt: q, d, kind }
  }
  if (on.origin) offer({ x: 0, y: 0 }, 'origin')
  for (const s of shapes) {
    const b = wbbox(s)
    if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue
    if (!on.points && !on.midpoints) continue
    for (const c of world(s)) {
      const n = c.pts.length
      const sharp = cornerFlags(c)
      for (let i = 0; i < n; i++) {
        if (!sharp[i]) continue
        const a = c.pts[i]
        if (on.points) offer(a, 'points')
        const j = i + 1 < n ? i + 1 : c.closed ? 0 : -1
        const nx = j >= 0 && sharp[j] ? c.pts[j] : undefined
        if (on.midpoints && nx) offer({ x: (a.x + nx.x) / 2, y: (a.y + nx.y) / 2 }, 'midpoints')
      }
    }
  }
  const hit = best as { pt: Pt; d: number; kind: SnapKind } | null
  if (hit) return { pt: hit.pt, kind: hit.kind, guides: [{ axis: 'x', at: hit.pt.x }, { axis: 'y', at: hit.pt.y }] }

  if (on.edges) {
    let e: { pt: Pt; d: number } | null = null
    for (const s of shapes) {
      const b = wbbox(s)
      if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue
      for (const c of world(s)) {
        const n = c.pts.length
        const segs = c.closed ? n : n - 1
        for (let i = 0; i < segs; i++) {
          const a = c.pts[i]
          const z = c.pts[(i + 1) % n]
          const dx = z.x - a.x
          const dy = z.y - a.y
          const l2 = dx * dx + dy * dy
          const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0
          const q = { x: a.x + t * dx, y: a.y + t * dy }
          const d = Math.hypot(q.x - p.x, q.y - p.y)
          if (d <= tol && (!e || d < e.d)) e = { pt: q, d }
        }
      }
    }
    if (e) return { pt: (e as { pt: Pt }).pt, kind: 'edges', guides: [] }
  }

  const { xs, ys } = alignLines(shapes, on)
  for (const q of opts.extra ?? []) {
    xs.push({ at: q.x, lo: q.y, hi: q.y })
    ys.push({ at: q.y, lo: q.x, hi: q.x })
  }
  const hx = snapAxis([p.x], 0, xs, tol, opts.grid ?? null)
  const hy = snapAxis([p.y], 0, ys, tol, opts.grid ?? null)
  const pt = { x: p.x + (hx?.shift ?? 0), y: p.y + (hy?.shift ?? 0) }
  const guides: SnapGuideSpan[] = []
  if (hx) guides.push(guideFor('x', hx, pt.y, pt.y))
  if (hy) guides.push(guideFor('y', hy, pt.x, pt.x))
  const objectHit = (hx && !hx.grid) || (hy && !hy.grid)
  return { pt, kind: objectHit ? 'bounds' : null, guides }
}
