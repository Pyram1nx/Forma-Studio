// Create and regenerate parametric shapes.
import type { Contour, Shape, ShapeKind, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { uid } from '../model/ids'
import { newShapeCut } from '../state/prefs'
import { ellipse, polygon, polygonUnitSize, rect } from '../geometry/primitives'
import { paramDefault, TEMPLATES } from '../geometry/templates'
import { boxJointKind, DEFAULT_STOCK_ANCHOR } from '../geometry/boxJoints'
import { recenter } from '../geometry/transform'
import { filletPolygon, parseRadii, rectCorners } from '../geometry/fillet'

export type BasicShape = 'circle' | 'ellipse' | 'rect' | 'roundrect' | 'polygon' | 'triangle'

export const BASIC_SHAPES: { id: BasicShape; label: string }[] = [
  { id: 'circle', label: 'Circle' },
  { id: 'ellipse', label: 'Ellipse' },
  { id: 'rect', label: 'Rectangle' },
  { id: 'roundrect', label: 'Rounded Rectangle' },
  { id: 'polygon', label: 'Polygon' },
  { id: 'triangle', label: 'Triangle' },
]

const IN = MM_PER_IN

/** Corner radii of a vertex shape: the Custom Radius list (`cr`) when it fits the vertices, else the uniform `r`. */
export function cornerRadii(p: Record<string, number | string | boolean>, n: number): number[] {
  return parseRadii(p.cr, n) ?? new Array<number>(n).fill(Number(p.r ?? 0))
}

/** Rounds a vertex shape's corners; sharp corners are returned unchanged. */
function cornered(cs: Contour[], p: Record<string, number | string | boolean>): Contour[] {
  const pts = cs[0].pts
  const radii = cornerRadii(p, pts.length)
  if (!radii.some((r) => r > 0)) return cs
  // Studio keeps a polygon's bounding box where it was: rounding shrinks the box, so re-centre it on the origin.
  const rounded = filletPolygon(pts, radii)
  const xs = rounded.map((q) => q.x)
  const ys = rounded.map((q) => q.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  return [{ closed: true, pts: rounded.map((q) => ({ x: q.x - cx, y: q.y - cy })) }]
}

/** Rebuild contours from params for parametric kinds. Returns null if not parametric. */
export function buildFromParams(kind: ShapeKind, p: Record<string, number | string | boolean>): Contour[] | null {
  const w = Number(p.w)
  const h = Number(p.h)
  switch (kind) {
    case 'circle':
    case 'ellipse':
      return ellipse(w, h)
    case 'rect': {
      const radii = parseRadii(p.cr, 4)
      if (!radii) return rect(w, h, Number(p.r ?? 0))
      return [{ closed: true, pts: filletPolygon(rectCorners(w, h), radii) }]
    }
    case 'polygon':
      return cornered(polygon(Number(p.n ?? 5), w, h), p)
    case 'triangle':
      return cornered(polygon(3, w, h), p)
    case 'template': {
      const t = TEMPLATES.find((x) => x.id === p.template)
      if (!t) return null
      const vals: Record<string, number> = {}
      for (const d of t.params) vals[d.key] = Number(p[d.key] ?? d.default)
      return t.build(vals)
    }
  }
  return null
}

export function isParametric(s: Shape): boolean {
  return !!s.params && ['circle', 'ellipse', 'rect', 'polygon', 'triangle'].includes(s.kind)
}

/**
 * Turn the scale left by a resize drag into clean params, so the canvas and the settings panel agree:
 * w/h for basic shapes, and for templates every parameter flagged with an `axis` (box joints scale themselves).
 */
export function normalizeParametric(s: Shape): Shape {
  const ax = Math.abs(s.sx)
  const ay = Math.abs(s.sy)
  if (ax === 1 && ay === 1) return s
  let params: Record<string, number | string | boolean>
  if (isParametric(s)) params = { ...s.params!, w: Number(s.params!.w) * ax, h: Number(s.params!.h) * ay }
  else if (s.kind === 'template' && s.params && !boxJointKind(String(s.params.template))) {
    const t = TEMPLATES.find((x) => x.id === s.params!.template)
    if (!t) return s
    params = { ...s.params }
    for (const d of t.params) {
      if (!d.axis) continue
      const f = d.axis === 'x' ? ax : d.axis === 'y' ? ay : Math.min(ax, ay)
      params[d.key] = Number(params[d.key] ?? d.default) * f
    }
  } else return s
  const contours = buildFromParams(s.kind, params)
  if (!contours) return s
  // Templates are not always centred on their bounds, so keep the resized geometry's centre where it was.
  // The compass is the exception: its origin is the star's centre, whatever its tips do to the bounds.
  if (s.params?.template === 'compass') return { ...s, params, contours, sx: Math.sign(s.sx) || 1, sy: Math.sign(s.sy) || 1 }
  return recenter({ ...s, params, contours, sx: Math.sign(s.sx) || 1, sy: Math.sign(s.sy) || 1 })
}

export function createBasic(id: BasicShape, x: number, y: number): Shape {
  const base = { id: uid(), x, y, rotation: 0, sx: 1, sy: 1, cut: newShapeCut() }
  switch (id) {
    case 'circle':
      return { ...base, name: 'Circle', kind: 'circle', params: { w: IN, h: IN }, contours: ellipse(IN, IN) }
    case 'ellipse':
      return { ...base, name: 'Ellipse', kind: 'ellipse', params: { w: IN * 1.5, h: IN }, contours: ellipse(IN * 1.5, IN) }
    case 'rect':
      return { ...base, name: 'Rectangle', kind: 'rect', params: { w: IN, h: IN, r: 0 }, contours: rect(IN, IN) }
    case 'roundrect':
      return { ...base, name: 'Rounded Rectangle', kind: 'rect', params: { w: IN, h: IN, r: IN / 8 }, contours: rect(IN, IN, IN / 8) }
    case 'polygon':
    {
      // Studio's polygon: a pentagon on a circle of radius 0.5 in.
      const u = polygonUnitSize(5)
      const w = u.w * 0.5 * IN
      const h = u.h * 0.5 * IN
      return { ...base, name: 'Polygon', kind: 'polygon', params: { w, h, n: 5 }, contours: polygon(5, w, h) }
    }
    case 'triangle':
      return { ...base, name: 'Triangle', kind: 'triangle', params: { w: IN, h: IN * 0.866 }, contours: polygon(3, IN, IN * 0.866) }
  }
}

export function createTemplate(templateId: string, x: number, y: number, units: Units = 'in'): Shape | null {
  const t = TEMPLATES.find((tp) => tp.id === templateId)
  if (!t) return null
  const params: Record<string, number | string> = { template: t.id }
  const vals: Record<string, number> = {}
  for (const d of t.params) params[d.key] = vals[d.key] = paramDefault(d, units)
  const joint = boxJointKind(t.id)
  if (joint) params.anchor = DEFAULT_STOCK_ANCHOR
  const s: Shape = {
    id: uid(),
    name: t.name,
    kind: 'template',
    params,
    contours: t.build(vals),
    x: 0,
    y: 0,
    rotation: 0,
    sx: 1,
    sy: 1,
    // Box joints are inside cuts; Studio's pocket path always carries a 1/4 in tool, whatever the bit diameter
    // param, so the preset bit does not apply there (the preset depth does).
    cut: joint ? { ...newShapeCut('inside'), bitDia: 6.35 } : newShapeCut(),
  }
  // Box joints keep the board centred on the shape's origin, so their guides and stock anchors line up; the
  // compass keeps its star centre there, so its position stays put when the number of points changes.
  if (joint || t.id === 'compass') return { ...s, x, y }
  const r = recenter(s)
  return { ...r, x, y }
}
