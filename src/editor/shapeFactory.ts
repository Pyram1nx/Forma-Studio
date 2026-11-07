// Create and regenerate parametric shapes.
import type { Contour, PenContour, Pt, Shape, ShapeKind, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'
import { uid } from '../model/ids'
import { newShapeCut } from '../state/prefs'
import { polygon, polygonUnitSize } from '../geometry/primitives'
import { ellipsePen, filletPen, penBounds, polygonPen, recoverAll } from '../geometry/curves'
import { mapPen, penGeometry } from '../geometry/pen'
import { paramDefault, TEMPLATES } from '../geometry/templates'
import { boxJointKind, DEFAULT_STOCK_ANCHOR } from '../geometry/boxJoints'
import { recenter } from '../geometry/transform'
import { parseRadii, rectCorners } from '../geometry/fillet'

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

/** A vertex shape with its corners rounded as true arcs; sharp corners stay straight. */
function cornered(pts: Pt[], p: Record<string, number | string | boolean>): PenContour[] {
  const radii = cornerRadii(p, pts.length)
  if (!radii.some((r) => r > 0)) return [polygonPen(pts)]
  // Studio keeps a polygon's bounding box where it was: rounding shrinks the box, so re-centre it on the origin.
  const rounded = filletPen(pts, radii)
  const b = penBounds(rounded)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  return mapPen(rounded, (q) => ({ x: q.x - cx, y: q.y - cy }))
}

/** Template geometry: its own curves where it has them, else arcs recovered from its outline. */
function templateGeometry(id: string, vals: Record<string, number>): { contours: Contour[]; pen?: PenContour[] } | null {
  const t = TEMPLATES.find((x) => x.id === id)
  if (!t) return null
  const exact = t.buildPen?.(vals)
  if (exact) return penGeometry(exact)
  const contours = t.build(vals)
  // Box joints are matched to Studio's own pockets point for point, so they keep their polylines.
  if (boxJointKind(id) || !contours.length) return { contours }
  return penGeometry(recoverAll(contours))
}

/**
 * Geometry for a parametric kind: true curves (`pen`) and the contours flattened from them.
 * Returns null if the kind is not parametric.
 */
export function paramGeometry(kind: ShapeKind, p: Record<string, number | string | boolean>): { contours: Contour[]; pen?: PenContour[] } | null {
  const w = Number(p.w)
  const h = Number(p.h)
  switch (kind) {
    case 'circle':
    case 'ellipse':
      return penGeometry(ellipsePen(w, h))
    case 'rect': {
      const radii = parseRadii(p.cr, 4) ?? new Array<number>(4).fill(Math.max(0, Number(p.r ?? 0)))
      return penGeometry(filletPen(rectCorners(w, h), radii))
    }
    case 'polygon':
      return penGeometry(cornered(polygon(Number(p.n ?? 5), w, h)[0].pts, p))
    case 'triangle':
      return penGeometry(cornered(polygon(3, w, h)[0].pts, p))
    case 'template': {
      const t = TEMPLATES.find((x) => x.id === p.template)
      if (!t) return null
      const vals: Record<string, number> = {}
      for (const d of t.params) vals[d.key] = Number(p[d.key] ?? d.default)
      return templateGeometry(t.id, vals)
    }
  }
  return null
}

/** Rebuild contours from params for parametric kinds. Returns null if not parametric. */
export function buildFromParams(kind: ShapeKind, p: Record<string, number | string | boolean>): Contour[] | null {
  return paramGeometry(kind, p)?.contours ?? null
}

/** The shape with new params and the geometry built from them (unchanged if the kind is not parametric). */
export function withParams<S extends Shape>(s: S, params: Record<string, number | string | boolean>): S {
  const g = paramGeometry(s.kind, params)
  return g ? { ...s, params, contours: g.contours, pen: g.pen } : s
}

/** The template behind a template shape, if any. */
export function templateOf(s: Pick<Shape, 'kind' | 'params'>) {
  return s.kind === 'template' ? TEMPLATES.find((t) => t.id === s.params?.template) : undefined
}

/** A template whose local origin is its anchor (Studio's custom anchor, e.g. the keyhole's neck centre). */
export function hasOwnAnchor(s: Pick<Shape, 'kind' | 'params'>): boolean {
  return !!templateOf(s)?.ownAnchor
}

/** The resize handles Studio hides for the selection: every selected template's restrictions together. */
export function disallowedHandles(shapes: readonly Pick<Shape, 'kind' | 'params'>[]): Set<string> {
  return new Set(shapes.flatMap((s) => templateOf(s)?.resizeRestrictions ?? []))
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
    if (t.afterScale) {
      // Studio's own rule for the template; the shape's origin was already scaled about the anchor.
      const vals: Record<string, number> = {}
      for (const d of t.params) vals[d.key] = Number(params[d.key] ?? d.default)
      Object.assign(params, t.afterScale(vals, { dx: ax, dy: ay }))
    } else
      for (const d of t.params) {
        if (!d.axis) continue
        const f = d.axis === 'x' ? ax : d.axis === 'y' ? ay : Math.min(ax, ay)
        params[d.key] = Number(params[d.key] ?? d.default) * f
      }
  } else return s
  const g = paramGeometry(s.kind, params)
  if (!g) return s
  const next = { ...s, params, contours: g.contours, pen: g.pen, sx: Math.sign(s.sx) || 1, sy: Math.sign(s.sy) || 1 }
  // Templates are not always centred on their bounds, so keep the resized geometry's centre where it was.
  // The exceptions keep their own origin: the compass's star centre, and templates with their own anchor
  // (the keyhole's neck centre), which Studio scales about the anchor like any position.
  if (s.params?.template === 'compass' || hasOwnAnchor(s)) return next
  return recenter(next)
}

export function createBasic(id: BasicShape, x: number, y: number): Shape {
  const base = { id: uid(), x, y, rotation: 0, sx: 1, sy: 1, cut: newShapeCut() }
  const make = (name: string, kind: ShapeKind, params: Record<string, number>): Shape => withParams({ ...base, name, kind, params, contours: [] }, params)
  switch (id) {
    case 'circle':
      return make('Circle', 'circle', { w: IN, h: IN })
    case 'ellipse':
      // Studio's ellipse: 1 x 0.5 in (25.4 x 12.7 mm; sizes do not change with the document's units).
      return make('Ellipse', 'ellipse', { w: IN, h: IN / 2 })
    case 'rect':
      return make('Rectangle', 'rect', { w: IN, h: IN, r: 0 })
    case 'roundrect':
      // Studio's rounded rectangle: 1 in square with a 0.2 in corner radius.
      return make('Rounded Rectangle', 'rect', { w: IN, h: IN, r: IN * 0.2 })
    case 'polygon': {
      // Studio's polygon: a pentagon on a circle of radius 0.5 in.
      const u = polygonUnitSize(5)
      return make('Polygon', 'polygon', { w: u.w * 0.5 * IN, h: u.h * 0.5 * IN, n: 5 })
    }
    case 'triangle':
      return make('Triangle', 'triangle', { w: IN, h: IN * 0.866 })
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
  const geom = templateGeometry(t.id, vals)!
  const s: Shape = {
    id: uid(),
    name: t.name,
    kind: 'template',
    params,
    contours: geom.contours,
    pen: geom.pen,
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
  // Templates with their own anchor are placed by it, as Studio places them.
  if (joint || t.id === 'compass' || t.ownAnchor) return { ...s, x, y }
  const r = recenter(s)
  return { ...r, x, y }
}
