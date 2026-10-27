// Create and regenerate parametric shapes.
import type { Contour, Shape, ShapeKind, Units } from '../model/types'
import { DEFAULT_CUT, MM_PER_IN } from '../model/types'
import { uid } from '../model/ids'
import { ellipse, polygon, rect } from '../geometry/primitives'
import { paramDefault, TEMPLATES } from '../geometry/templates'
import { boxJointKind, DEFAULT_STOCK_ANCHOR } from '../geometry/boxJoints'
import { recenter } from '../geometry/transform'

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

/** Rebuild contours from params for parametric kinds. Returns null if not parametric. */
export function buildFromParams(kind: ShapeKind, p: Record<string, number | string | boolean>): Contour[] | null {
  const w = Number(p.w)
  const h = Number(p.h)
  switch (kind) {
    case 'circle':
    case 'ellipse':
      return ellipse(w, h)
    case 'rect':
      return rect(w, h, Number(p.r ?? 0))
    case 'polygon':
      return polygon(Number(p.n ?? 5), w, h)
    case 'triangle':
      return polygon(3, w, h)
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

export function createBasic(id: BasicShape, x: number, y: number): Shape {
  const base = { id: uid(), x, y, rotation: 0, sx: 1, sy: 1, cut: { ...DEFAULT_CUT } }
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
      return { ...base, name: 'Polygon', kind: 'polygon', params: { w: IN, h: IN, n: 6 }, contours: polygon(6, IN, IN) }
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
    // Box joints are inside cuts; Studio's pocket path always carries a 1/4 in tool, whatever the bit diameter param.
    cut: joint ? { ...DEFAULT_CUT, type: 'inside', bitDia: 6.35 } : { ...DEFAULT_CUT },
  }
  // Box joints keep the board centred on the shape's origin, so their guides and stock anchors line up.
  if (joint) return { ...s, x, y }
  const r = recenter(s)
  return { ...r, x, y }
}
