import type { Contour, FreeOrigin, Pt, Shape } from '../model/types'
import { mapPen, penOf } from './pen'

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export const emptyBBox = (): BBox => ({ minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity })

export function bboxOfPts(pts: Pt[], b: BBox = emptyBBox()): BBox {
  for (const p of pts) {
    if (p.x < b.minX) b.minX = p.x
    if (p.y < b.minY) b.minY = p.y
    if (p.x > b.maxX) b.maxX = p.x
    if (p.y > b.maxY) b.maxY = p.y
  }
  return b
}

export function bboxOfContours(cs: Contour[], b: BBox = emptyBBox()): BBox {
  for (const c of cs) bboxOfPts(c.pts, b)
  return b
}

export const bboxValid = (b: BBox) => Number.isFinite(b.minX) && b.maxX >= b.minX

export const bboxW = (b: BBox) => b.maxX - b.minX
export const bboxH = (b: BBox) => b.maxY - b.minY
export const bboxCenter = (b: BBox): Pt => ({ x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 })

/** Where `p` sits within `b` as fractions of its size (the inverse of anchor → point on bounds). */
export function bboxFraction(b: BBox, p: Pt): FreeOrigin {
  return {
    fx: (p.x - b.minX) / Math.max(b.maxX - b.minX, 1e-9),
    fy: (p.y - b.minY) / Math.max(b.maxY - b.minY, 1e-9),
  }
}

/** Map a local point of a shape to world coordinates. */
export function toWorld(s: Pick<Shape, 'x' | 'y' | 'rotation' | 'sx' | 'sy'>, p: Pt): Pt {
  const a = (s.rotation * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const x = p.x * s.sx
  const y = p.y * s.sy
  return { x: s.x + x * cos - y * sin, y: s.y + x * sin + y * cos }
}

/** World-space contours of a shape. */
export function worldContours(s: Shape): Contour[] {
  return s.contours.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => toWorld(s, p)) }))
}

export function shapeBBox(s: Shape): BBox {
  return bboxOfContours(worldContours(s))
}

export function shapesBBox(shapes: Shape[]): BBox {
  const b = emptyBBox()
  for (const s of shapes) bboxOfContours(worldContours(s), b)
  return b
}

/** Local (unrotated, unscaled) bounding box of a shape's geometry. */
export function localBBox(s: Shape): BBox {
  return bboxOfContours(s.contours)
}

/**
 * Re-centre a shape's local geometry on its bbox centre and move the
 * difference into x/y, so rotation and scaling pivot around the visual centre.
 */
export function recenter(s: Shape): Shape {
  const b = localBBox(s)
  if (!bboxValid(b)) return s
  const c = bboxCenter(b)
  if (Math.abs(c.x) < 1e-9 && Math.abs(c.y) < 1e-9) return s
  const w = toWorld(s, c)
  return {
    ...s,
    x: w.x,
    y: w.y,
    contours: s.contours.map((ct) => ({ closed: ct.closed, pts: ct.pts.map((p) => ({ x: p.x - c.x, y: p.y - c.y })) })),
    ...(s.pen && { pen: mapPen(s.pen, (p) => ({ x: p.x - c.x, y: p.y - c.y })) }),
  }
}

/** Kinds whose contours are regenerated from params; baking turns them into plain paths. */
const PARAMETRIC_KINDS = new Set(['circle', 'ellipse', 'rect', 'polygon', 'triangle', 'template'])

/**
 * Bake the shape's transform into its contours (x/y/rotation/scale become identity-ish).
 * Parametric shapes become plain paths, because their params can't express the
 * rotation or the non-uniform scale that was just applied to the geometry.
 */
export function bake(s: Shape): Shape {
  const cs = worldContours(s)
  const b = bboxOfContours(cs)
  const c = bboxCenter(b)
  const parametric = PARAMETRIC_KINDS.has(s.kind)
  // Pen paths take the same transform, so a moved, scaled or rotated curve stays editable.
  const pen = penOf(s)
  return {
    ...s,
    pen: pen ? mapPen(pen, (p) => {
      const w = toWorld(s, p)
      return { x: w.x - c.x, y: w.y - c.y }
    }) : undefined,
    kind: parametric ? 'path' : s.kind,
    params: parametric ? undefined : s.params,
    x: c.x,
    y: c.y,
    rotation: 0,
    sx: 1,
    sy: 1,
    contours: cs.map((ct) => ({ closed: ct.closed, pts: ct.pts.map((p) => ({ x: p.x - c.x, y: p.y - c.y })) })),
  }
}

/** Even-odd point-in-polygon test over all closed contours. */
export function pointInContours(p: Pt, cs: Contour[]): boolean {
  let inside = false
  for (const c of cs) {
    if (!c.closed) continue
    const pts = c.pts
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]
      const b = pts[j]
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

/** Minimum distance from p to any contour segment. */
export function distToContours(p: Pt, cs: Contour[]): number {
  let best = Infinity
  for (const c of cs) {
    const n = c.pts.length
    const segs = c.closed ? n : n - 1
    for (let i = 0; i < segs; i++) {
      const a = c.pts[i]
      const b = c.pts[(i + 1) % n]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      let t = l2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y)
      if (d < best) best = d
    }
  }
  return best
}
