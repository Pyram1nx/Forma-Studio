import type { DocSettings, Pt, Shape, SnapKind } from '../model/types'
import { SNAP_KINDS } from '../model/types'
import { wbbox, world } from './geomCache'

export interface SnapGuide {
  axis: 'x' | 'y'
  at: number
}

export interface SnapHit {
  pt: Pt
  guides: SnapGuide[]
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

/** Alignment coordinates (world x / y) a moving or picked thing can line up with, per enabled target. */
export function alignCoords(shapes: Shape[], on: Record<SnapKind, boolean>): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const s of shapes) {
    const b = wbbox(s)
    if (on.bounds) {
      xs.push(b.minX, b.maxX)
      ys.push(b.minY, b.maxY)
    }
    if (on.centers) {
      xs.push((b.minX + b.maxX) / 2)
      ys.push((b.minY + b.maxY) / 2)
    }
    if (on.points || on.midpoints) {
      for (const c of world(s)) {
        const n = c.pts.length
        for (let i = 0; i < n; i++) {
          const a = c.pts[i]
          if (on.points) {
            xs.push(a.x)
            ys.push(a.y)
          }
          if (on.midpoints) {
            const nx = c.pts[i + 1] ?? (c.closed ? c.pts[0] : undefined)
            if (nx) {
              xs.push((a.x + nx.x) / 2)
              ys.push((a.y + nx.y) / 2)
            }
          }
        }
      }
    }
  }
  if (on.origin) {
    xs.push(0)
    ys.push(0)
  }
  return { xs, ys }
}

/**
 * Snap a world point to the enabled targets of the given shapes. Order: exact points (vertices, midpoints,
 * centres, bounds corners, origin), then the nearest spot on an edge, then axis alignment with any of those.
 */
export function snapPoint(p: Pt, shapes: Shape[], on: Record<SnapKind, boolean>, tol: number): SnapHit {
  let best: { pt: Pt; d: number; kind: SnapKind } | null = null
  const offer = (q: Pt, kind: SnapKind) => {
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d <= tol && (!best || d < best.d)) best = { pt: q, d, kind }
  }
  if (on.origin) offer({ x: 0, y: 0 }, 'origin')
  for (const s of shapes) {
    const b = wbbox(s)
    if (p.x < b.minX - tol || p.x > b.maxX + tol || p.y < b.minY - tol || p.y > b.maxY + tol) continue
    if (on.bounds) {
      offer({ x: b.minX, y: b.minY }, 'bounds')
      offer({ x: b.maxX, y: b.minY }, 'bounds')
      offer({ x: b.minX, y: b.maxY }, 'bounds')
      offer({ x: b.maxX, y: b.maxY }, 'bounds')
    }
    if (on.centers) offer({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }, 'centers')
    for (const c of world(s)) {
      const n = c.pts.length
      for (let i = 0; i < n; i++) {
        const a = c.pts[i]
        if (on.points) offer(a, 'points')
        const nx = c.pts[i + 1] ?? (c.closed ? c.pts[0] : undefined)
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

  const { xs, ys } = alignCoords(shapes, on)
  let bx: number | null = null
  let by: number | null = null
  for (const x of xs) if (Math.abs(x - p.x) <= tol && (bx === null || Math.abs(x - p.x) < Math.abs(bx - p.x))) bx = x
  for (const y of ys) if (Math.abs(y - p.y) <= tol && (by === null || Math.abs(y - p.y) < Math.abs(by - p.y))) by = y
  const guides: SnapGuide[] = []
  if (bx !== null) guides.push({ axis: 'x', at: bx })
  if (by !== null) guides.push({ axis: 'y', at: by })
  return { pt: { x: bx ?? p.x, y: by ?? p.y }, kind: guides.length ? 'points' : null, guides }
}
