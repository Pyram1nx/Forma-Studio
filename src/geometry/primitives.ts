// Basic parametric shapes. All sizes in mm, centred on (0,0).
import type { Contour, Pt } from '../model/types'

const segs = (r: number) => Math.max(24, Math.min(360, Math.ceil(r * 8)))

export function ellipse(w: number, h: number): Contour[] {
  const rx = w / 2
  const ry = h / 2
  const n = segs(Math.max(rx, ry))
  const pts: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2
    pts.push({ x: rx * Math.cos(a), y: ry * Math.sin(a) })
  }
  return [{ pts, closed: true }]
}

export function rect(w: number, h: number, r = 0): Contour[] {
  const hw = w / 2
  const hh = h / 2
  r = Math.max(0, Math.min(r, hw, hh))
  if (r < 1e-6) {
    return [{ closed: true, pts: [{ x: -hw, y: -hh }, { x: hw, y: -hh }, { x: hw, y: hh }, { x: -hw, y: hh }] }]
  }
  const pts: Pt[] = []
  const n = Math.max(6, Math.ceil(segs(r) / 4))
  const corner = (cx: number, cy: number, a0: number) => {
    for (let i = 0; i <= n; i++) {
      const a = a0 + (i / n) * (Math.PI / 2)
      pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
    }
  }
  corner(hw - r, -hh + r, -Math.PI / 2)
  corner(hw - r, hh - r, 0)
  corner(-hw + r, hh - r, Math.PI / 2)
  corner(-hw + r, -hh + r, Math.PI)
  return [{ pts, closed: true }]
}

/** Unit-circumradius regular polygon, as in Studio: always a flat edge at the bottom (odd counts point up). */
function regularPolygon(n: number): Pt[] {
  const raw: Pt[] = []
  for (let i = 0; i < n; i++) {
    const a = Math.PI / 2 + Math.PI / n + (i / n) * Math.PI * 2
    raw.push({ x: Math.cos(a), y: Math.sin(a) })
  }
  return raw
}

/** Width and height of a regular n-gon with circumradius 1 (a pentagon is 1.902 × 1.809). */
export function polygonUnitSize(n: number): { w: number; h: number } {
  const xs = regularPolygon(n).map((p) => p.x)
  const ys = regularPolygon(n).map((p) => p.y)
  return { w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) }
}

/** Regular polygon with `n` sides fitted in a w×h box (flat edge at the bottom). */
export function polygon(n: number, w: number, h: number): Contour[] {
  return [{ pts: fitTo(regularPolygon(n), w, h), closed: true }]
}

export function star(points: number, w: number, h: number, inner = 0.45): Contour[] {
  const raw: Pt[] = []
  for (let i = 0; i < points * 2; i++) {
    const a = -Math.PI / 2 + (i / (points * 2)) * Math.PI * 2
    const r = i % 2 ? inner : 1
    raw.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return [{ pts: fitTo(raw, w, h), closed: true }]
}

/** Scale and centre points so their bbox is exactly w×h. */
export function fitTo(pts: Pt[], w: number, h: number): Pt[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const p of pts) {
    minX = Math.min(minX, p.x)
    minY = Math.min(minY, p.y)
    maxX = Math.max(maxX, p.x)
    maxY = Math.max(maxY, p.y)
  }
  const sx = w / (maxX - minX || 1)
  const sy = h / (maxY - minY || 1)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return pts.map((p) => ({ x: (p.x - cx) * sx, y: (p.y - cy) * sy }))
}

/** Fit a whole set of contours (keeping proportions between them) into w×h. */
export function fitContours(cs: Contour[], w: number, h: number): Contour[] {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const c of cs)
    for (const p of c.pts) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  const sx = w / (maxX - minX || 1)
  const sy = h / (maxY - minY || 1)
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  return cs.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: (p.x - cx) * sx, y: (p.y - cy) * sy })) }))
}
