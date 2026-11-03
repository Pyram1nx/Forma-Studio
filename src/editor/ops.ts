// Editing operations shared by the panels and the canvas. Locked shapes are never
// moved, resized, rotated, mirrored, deleted or boolean'd (offset may read them).
import type { Contour, FreeOrigin, Pt, Shape } from '../model/types'
import { editableIds, useStore } from '../state/store'
import { newShapeCut } from '../state/prefs'
import { bake, bboxValid, recenter, type BBox } from '../geometry/transform'
import { boolean, offsetContours, type JoinStyle } from '../geometry/offset'
import { uid } from '../model/ids'
import { normalizeParametric } from './shapeFactory'
import { wbbox, world } from './geomCache'
import { boxJointPartsOf, scaleBoxJoint, syncBoxJointGuides } from './boxJointGuides'

export type Anchor = `${'t' | 'm' | 'b'}${'l' | 'c' | 'r'}`

/** Arrow-key nudges closer together than this (ms) are one undo step. */
export const NUDGE_MERGE_MS = 600

export function selectionBBox(shapes: Shape[]): BBox | null {
  if (!shapes.length) return null
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const s of shapes) {
    const sb = wbbox(s)
    b.minX = Math.min(b.minX, sb.minX)
    b.minY = Math.min(b.minY, sb.minY)
    b.maxX = Math.max(b.maxX, sb.maxX)
    b.maxY = Math.max(b.maxY, sb.maxY)
  }
  return bboxValid(b) ? b : null
}

/**
 * The box anchors are measured against. A lone compass pivots on its star centre, not on its bounds (a star
 * with an odd number of points is lopsided), so its box is symmetric around the shape's origin.
 */
export function anchorBBox(shapes: Shape[], b: BBox): BBox {
  const s = shapes.length === 1 ? shapes[0] : undefined
  if (s?.kind !== 'template' || s.params?.template !== 'compass') return b
  const hx = Math.max(s.x - b.minX, b.maxX - s.x)
  const hy = Math.max(s.y - b.minY, b.maxY - s.y)
  return { minX: s.x - hx, maxX: s.x + hx, minY: s.y - hy, maxY: s.y + hy }
}

/** A pivot: one of the nine bounds points, or a free point given as fractions of the bounds. */
export type AnchorRef = Anchor | FreeOrigin

export function anchorPoint(b: BBox, a: AnchorRef): Pt {
  if (typeof a !== 'string') return { x: b.minX + a.fx * (b.maxX - b.minX), y: b.minY + a.fy * (b.maxY - b.minY) }
  const x = a[1] === 'l' ? b.minX : a[1] === 'r' ? b.maxX : (b.minX + b.maxX) / 2
  const y = a[0] === 't' ? b.minY : a[0] === 'b' ? b.maxY : (b.minY + b.maxY) / 2
  return { x, y }
}

/**
 * Resize the editable part of the selection to w×h mm keeping `anchor` fixed.
 * Rotated shapes are baked first, so the scaled bounding box is exact in world
 * space; a rotated parametric shape therefore becomes a plain path (its rotated
 * geometry is kept).
 */
export function resizeSelection(ids: string[], w: number | null, h: number | null, anchor: AnchorRef) {
  const st = useStore.getState()
  const target = editableIds(ids, st.doc)
  const shapes = st.doc.shapes.filter((s) => target.includes(s.id))
  const b = selectionBBox(shapes)
  if (!b) return
  const bw = b.maxX - b.minX
  const bh = b.maxY - b.minY
  const fx = w != null && bw > 1e-9 ? w / bw : 1
  const fy = h != null && bh > 1e-9 ? h / bh : 1
  const a = anchorPoint(b, anchor)
  // Box joints take the scale into their params (never stretched); their guides are rebuilt after.
  const joints = boxJointPartsOf(st.doc, target)
  st.updateShapes(target, (s0) => {
    if (joints.outlines.has(s0.id)) return scaleBoxJoint(s0, fx, fy, a, st.doc.units)
    if (joints.guides.has(s0.id)) return s0
    const s = s0.rotation % 360 !== 0 ? bake(s0) : s0
    return normalizeParametric({
      ...s,
      x: a.x + (s.x - a.x) * fx,
      y: a.y + (s.y - a.y) * fy,
      sx: s.sx * fx,
      sy: s.sy * fy,
    })
  })
  for (const id of joints.outlines) syncBoxJointGuides(id)
}

/** Set absolute rotation (single) or rotate by delta around the anchor (multi). */
export function rotateSelection(ids: string[], deg: number, anchor: AnchorRef, absolute: boolean) {
  const st = useStore.getState()
  const target = editableIds(ids, st.doc)
  const shapes = st.doc.shapes.filter((s) => target.includes(s.id))
  const b = selectionBBox(shapes)
  if (!b) return
  const delta = absolute && shapes.length === 1 ? deg - shapes[0].rotation : deg
  const piv = anchorPoint(anchorBBox(shapes, b), anchor)
  const r = (delta * Math.PI) / 180
  const cos = Math.cos(r)
  const sin = Math.sin(r)
  st.updateShapes(target, (s) => {
    const dx = s.x - piv.x
    const dy = s.y - piv.y
    return { ...s, x: piv.x + dx * cos - dy * sin, y: piv.y + dx * sin + dy * cos, rotation: (((s.rotation + delta) % 360) + 360) % 360 }
  })
}

/**
 * Move the editable selection by (dx, dy) mm. Consecutive nudges within
 * NUDGE_MERGE_MS share a single undo checkpoint, so holding an arrow key is one undo step.
 */
export function nudgeSelection(dx: number, dy: number) {
  const st = useStore.getState()
  const target = editableIds(st.selection, st.doc)
  if (!target.length) return
  const now = Date.now()
  if (now - st.lastNudge > NUDGE_MERGE_MS) st.checkpoint()
  st.patchShapes(target, (s) => ({ ...s, x: s.x + dx, y: s.y + dy }))
  useStore.setState({ lastNudge: now })
}

function pathShape(name: string, contours: Contour[], template?: Shape): Shape {
  return recenter({
    id: uid(),
    name,
    kind: 'path',
    contours,
    x: 0,
    y: 0,
    rotation: 0,
    sx: 1,
    sy: 1,
    cut: template ? { ...template.cut } : newShapeCut(),
    groupId: template?.groupId,
  })
}

/**
 * ShapeShifter: merge the chosen fragments of the source shapes into one new shape.
 * Sources may be doc shapes or ephemeral ghosts rebuilt from an earlier merge. Locked
 * shapes never enter the mode, so they are never removed. `editId` is an older result
 * being re-edited; it is always replaced by the new shape.
 */
export function finishShapeShifter(sources: Shape[], chosen: Contour[][], keepExisting: boolean, editId?: string) {
  const st = useStore.getState()
  if (!sources.length || !chosen.length) return
  let acc = chosen[0]
  for (const f of chosen.slice(1)) acc = boolean('union', acc, f)
  if (!acc.length) {
    st.showToast('The result is empty')
    return
  }
  const shape = pathShape('ShapeShifter', acc, sources[0])
  // Record the merge so selecting the result alone can re-open ShapeShifter on it:
  // the root source ids plus the sources' contours in the result's local frame
  // (shape.x/y is that frame's origin after recenter), so they follow it as it moves.
  const provenance = [...new Set(sources.flatMap((s) => (s.meta?.shifterOf?.length ? s.meta.shifterOf : [s.id])))]
  shape.meta = {
    ...shape.meta,
    shifterOf: provenance,
    shifterSources: sources.map((s) =>
      world(s).map((ct) => ({ closed: ct.closed, pts: ct.pts.map((p) => ({ x: p.x - shape.x, y: p.y - shape.y })) })),
    ),
  }
  if (keepExisting && !editId) st.addShapes([shape])
  else {
    // Ghost ids are not in the doc, so replaceShapes simply ignores them.
    const removeIds = new Set([...sources.map((s) => s.id), ...(editId ? [editId] : [])])
    st.replaceShapes([...removeIds], [shape])
  }
}

export interface OffsetOptions {
  /** Signed mm: positive grows the shapes, negative shrinks them. */
  distance: number
  join: JoinStyle
  /** Produce one combined shape for all the shapes. */
  combine: boolean
}

export interface OffsetResult {
  source: Shape
  contours: Contour[]
}

/** The offset geometry for `sel`, without touching the document (used for the live preview). */
export function offsetResults(sel: Shape[], o: OffsetOptions): OffsetResult[] {
  if (!sel.length || Math.abs(o.distance) < 1e-6) return []
  const sources = o.combine && sel.length > 1 ? [{ s: sel[0], cs: sel.flatMap((s) => world(s)) }] : sel.map((s) => ({ s, cs: world(s) }))
  const out: OffsetResult[] = []
  for (const { s, cs } of sources) {
    const r = offsetContours(cs, o.distance, o.join)
    if (r.length) out.push({ source: s, contours: r })
  }
  return out
}

/** Add the offset of the selection as new shapes; the originals (locked or not) stay put. */
export function offsetSelection(o: OffsetOptions) {
  const st = useStore.getState()
  const sel = st.doc.shapes.filter((s) => st.selection.includes(s.id))
  const out = offsetResults(sel, o).map(({ source, contours }) => ({
    ...pathShape(`${source.name} · offset`, contours, source),
    meta: { ...source.meta, source: 'offset' as const },
  }))
  if (!out.length) {
    st.showToast('Offset produced no geometry (distance too large?)')
    return
  }
  st.addShapes(out)
}

/**
 * Parse a length typed by the user. Accepts "1.5", "2,5" (comma decimal),
 * "3/8", "1 1/2", arithmetic such as "2*3", and unit suffixes (mm, cm, in, ", inch).
 * Returns mm, or null for empty or invalid input.
 */
export function parseLength(text: string, units: 'in' | 'mm'): number | null {
  let t = text.trim().toLowerCase()
  if (!t) return null
  let u = units
  if (/(mm)$/.test(t)) {
    u = 'mm'
    t = t.replace(/mm$/, '')
  } else if (/(in|"|inch|inches)$/.test(t)) {
    u = 'in'
    t = t.replace(/(in|"|inch|inches)$/, '')
  } else if (/cm$/.test(t)) {
    t = t.replace(/cm$/, '')
    const v = parseLength(t, 'mm')
    return v == null ? null : v * 10
  }
  // Comma decimal separator: "2,5" means 2.5.
  t = t.replace(/(\d),(\d)/g, '$1.$2').trim()
  if (!t) return null
  let v: number
  const mixed = /^(-?\d+)\s+(\d+)\/(\d+)$/.exec(t)
  const frac = /^(-?\d*\.?\d+)\/(\d*\.?\d+)$/.exec(t)
  if (mixed) v = +mixed[1] + (Math.sign(+mixed[1]) || 1) * (+mixed[2] / +mixed[3])
  else if (frac) v = +frac[1] / +frac[2]
  else {
    // allow simple arithmetic like 2*3 or 10+2.5
    if (!/^[-+*/().\d\s]+$/.test(t)) return null
    try {
      v = Function('"use strict";return (' + t + ')')()
    } catch {
      return null
    }
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null
  return u === 'in' ? v * 25.4 : v
}
