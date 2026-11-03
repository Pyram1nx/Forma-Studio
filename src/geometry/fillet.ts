// Per-corner fillets for closed polygons. Each vertex gets its own radius; the fillet is the
// arc tangent to both edges at that vertex, as in Studio's Custom Radius view.
import type { Pt } from '../model/types'

const TAU = Math.PI * 2

/** Radii stored as a comma list, one per vertex (`null` when missing or the wrong length). */
export function parseRadii(v: unknown, n: number): number[] | null {
  if (typeof v !== 'string') return null
  const parts = v.split(',').map(Number)
  if (parts.length !== n || parts.some((x) => !Number.isFinite(x))) return null
  return parts.map((x) => Math.max(0, x))
}

export function formatRadii(rs: number[]): string {
  return rs.map((x) => +x.toFixed(6)).join(',')
}

/**
 * Largest fillet at vertex i: the tangent points may not pass half of either adjacent edge, so
 * a square's corners reach half its side (the same limit Studio puts on the uniform radius).
 */
export function maxFillet(pts: Pt[], i: number): number {
  const n = pts.length
  const p = pts[i]
  const a = pts[(i - 1 + n) % n]
  const b = pts[(i + 1) % n]
  const la = Math.hypot(a.x - p.x, a.y - p.y)
  const lb = Math.hypot(b.x - p.x, b.y - p.y)
  if (la < 1e-9 || lb < 1e-9) return 0
  const cos = ((a.x - p.x) * (b.x - p.x) + (a.y - p.y) * (b.y - p.y)) / (la * lb)
  const theta = Math.acos(Math.max(-1, Math.min(1, cos)))
  if (theta > Math.PI - 1e-6) return 0
  return (Math.min(la, lb) / 2) * Math.tan(theta / 2)
}

/** Rounds each vertex of a closed polygon by its own radius (clamped by `maxFillet`). */
export function filletPolygon(pts: Pt[], radii: number[]): Pt[] {
  const n = pts.length
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const p = pts[i]
    const r = Math.min(Math.max(0, radii[i] ?? 0), maxFillet(pts, i))
    if (r < 1e-9) {
      out.push(p)
      continue
    }
    const a = pts[(i - 1 + n) % n]
    const b = pts[(i + 1) % n]
    const u1 = unit(a.x - p.x, a.y - p.y)
    const u2 = unit(b.x - p.x, b.y - p.y)
    const theta = Math.acos(Math.max(-1, Math.min(1, u1.x * u2.x + u1.y * u2.y)))
    const t = r / Math.tan(theta / 2) // distance from the vertex to each tangent point
    const m = unit(u1.x + u2.x, u1.y + u2.y)
    const d = r / Math.sin(theta / 2) // vertex to arc centre
    const c = { x: p.x + m.x * d, y: p.y + m.y * d }
    const t1 = { x: p.x + u1.x * t, y: p.y + u1.y * t }
    const t2 = { x: p.x + u2.x * t, y: p.y + u2.y * t }
    const a1 = Math.atan2(t1.y - c.y, t1.x - c.x)
    let sweep = Math.atan2(t2.y - c.y, t2.x - c.x) - a1
    // The fillet is the short arc between the two tangent points.
    sweep = ((sweep + Math.PI) % TAU + TAU) % TAU - Math.PI
    const steps = Math.max(6, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * 12))
    for (let k = 0; k <= steps; k++) {
      const ang = a1 + (sweep * k) / steps
      out.push({ x: c.x + r * Math.cos(ang), y: c.y + r * Math.sin(ang) })
    }
  }
  return out
}

function unit(x: number, y: number): Pt {
  const l = Math.hypot(x, y) || 1
  return { x: x / l, y: y / l }
}

/** Sharp corners of a w×h rectangle centred on the origin: top-left, top-right, bottom-right, bottom-left. */
export function rectCorners(w: number, h: number): Pt[] {
  const hw = w / 2
  const hh = h / 2
  return [
    { x: -hw, y: -hh },
    { x: hw, y: -hh },
    { x: hw, y: hh },
    { x: -hw, y: hh },
  ]
}
