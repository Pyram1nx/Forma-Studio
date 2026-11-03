// Box joint basic / pro in the editor: the pocket outline plus its guides, as one group. The guides
// are laid out the way Shaper Studio does it (geometry/boxJoints): one box per kept pin of the
// current side (pin width × thickness, on the board) with the side letter in its middle, and none
// at all while guides are hidden. They are separate guide-type shapes in the outline's group, so
// they move with the cut path; selecting the group shows the outline's template panel.
import type { Group, Pt, Shape, StudioDoc, Units } from '../model/types'
import { uid } from '../model/ids'
import { groupForSelection, useStore, withoutCheckpoint } from '../state/store'
import { newShapeCut } from '../state/prefs'
import { shapesBBox, toWorld } from '../geometry/transform'
import { TEMPLATES, paramDefault } from '../geometry/templates'
import {
  boxJointGuides,
  boxJointKind,
  boxJointPocket,
  clampBoxJoint,
  DEFAULT_STOCK_ANCHOR,
  isStockAnchor,
  scaleBoxJointParams,
  stockAnchorPoint,
  type BoxJointKind,
  type StockAnchor,
} from '../geometry/boxJoints'

/** 'basic' / 'pro' for a box joint template shape. */
export const jointKindOf = (s: Shape | undefined): BoxJointKind | undefined => (s?.kind === 'template' ? boxJointKind(s.params?.template) : undefined)

export const isBoxJoint = (s: Shape | undefined): boolean => !!jointKindOf(s)

const isGuidePart = (s: Shape) => s.meta?.role === 'guide' || s.meta?.role === 'guideLabel'

export const sideLetter = (s: Shape) => (Number(s.params?.side ?? 0) === 1 ? 'B' : 'A')

/** The outline's numeric template params (defaults for missing ones). */
export function jointParams(s: Shape): Record<string, number> {
  const t = TEMPLATES.find((x) => x.id === s.params?.template)
  const out: Record<string, number> = {}
  for (const q of t?.params ?? []) {
    const v = Number(s.params?.[q.key])
    out[q.key] = Number.isFinite(v) ? v : paramDefault(q)
  }
  return out
}

export const stockAnchorOf = (s: Shape): StockAnchor => (isStockAnchor(s.params?.anchor) ? s.params.anchor : DEFAULT_STOCK_ANCHOR)

/** The box joint outline when the selection is exactly a box joint's group. */
export function boxJointForSelection(doc: StudioDoc, selection: readonly string[]): Shape | undefined {
  const g = groupForSelection(doc, selection)
  if (!g) return undefined
  return doc.shapes.find((s) => s.groupId === g.id && s.meta?.role === 'outline' && isBoxJoint(s))
}

/** Among `ids`: box joint outlines, and guide shapes of box joints whose outline is also among them. */
export function boxJointPartsOf(doc: StudioDoc, ids: Iterable<string>): { outlines: Set<string>; guides: Set<string> } {
  const want = new Set(ids)
  const outlines = new Set<string>()
  const groups = new Set<string>()
  for (const s of doc.shapes)
    if (want.has(s.id) && isBoxJoint(s)) {
      outlines.add(s.id)
      if (s.groupId) groups.add(s.groupId)
    }
  const guides = new Set<string>()
  for (const s of doc.shapes) if (want.has(s.id) && s.groupId && groups.has(s.groupId) && isGuidePart(s)) guides.add(s.id)
  return { outlines, guides }
}

/** A stock anchor of the outline in world coordinates. */
export function stockAnchorWorld(outline: Shape, a: StockAnchor = stockAnchorOf(outline)): Pt {
  return toWorld(outline, stockAnchorPoint(jointParams(outline), a))
}

/**
 * The guide shapes for the outline: a box and a letter per kept pin. Existing guide shapes are
 * reused in order (keeping their ids, so selections and undo stay put).
 */
export function boxJointGuideShapes(outline: Shape, groupId: string, reuse: Shape[] = []): Shape[] {
  const kind = jointKindOf(outline)
  if (!kind) return []
  const letter = sideLetter(outline)
  const boxes = reuse.filter((s) => s.meta?.role === 'guide')
  const labels = reuse.filter((s) => s.meta?.role === 'guideLabel')
  const base = { x: outline.x, y: outline.y, rotation: outline.rotation, sx: outline.sx, sy: outline.sy, groupId }
  const out: Shape[] = []
  for (const [i, g] of boxJointGuides(kind, jointParams(outline)).entries()) {
    for (const [role, pool, name, contours] of [
      ['guide', boxes, `Guide ${letter} pin ${g.pin + 1}`, [g.rect]],
      ['guideLabel', labels, letter, [g.letter]],
    ] as const) {
      const prev = pool[i]
      out.push({
        ...base,
        id: prev?.id ?? uid(),
        name,
        kind: 'path',
        contours: [...contours],
        // Guide paths are cut type guide, with the preset bit and depth (Studio's carry a 1/8 in tool, the default).
        cut: prev ? { ...prev.cut, type: 'guide' } : newShapeCut('guide'),
        locked: prev ? prev.locked : outline.locked,
        meta: { role },
      })
    }
  }
  return out
}

/** Keeps the group's anchor on the outline's stock anchor (a fraction of the group's bounds). */
function pinGroupAnchor(outlineId: string) {
  const st = useStore.getState()
  const outline = st.doc.shapes.find((s) => s.id === outlineId)
  const gid = outline?.groupId
  if (!outline || !gid) return
  const bb = shapesBBox(st.doc.shapes.filter((s) => s.groupId === gid))
  const p = stockAnchorWorld(outline)
  st.setGroupAnchor(gid, {
    fx: (p.x - bb.minX) / Math.max(bb.maxX - bb.minX, 1e-9),
    fy: (p.y - bb.minY) / Math.max(bb.maxY - bb.minY, 1e-9),
  })
}

/**
 * Brings the box joint's guides in line with its settings (positions, side, pin count, guides
 * shown or hidden) and keeps the group anchor on its stock point. Adds no undo step of its own.
 */
export function syncBoxJointGuides(outlineId: string): void {
  const st = useStore.getState()
  const outline = st.doc.shapes.find((s) => s.id === outlineId)
  if (!outline?.groupId || !isBoxJoint(outline)) return
  const gid = outline.groupId
  const wholeGroup = groupForSelection(st.doc, st.selection)?.id === gid
  const old = st.doc.shapes.filter((s) => s.groupId === gid && isGuidePart(s))
  const next = boxJointGuideShapes(outline, gid, old)
  withoutCheckpoint(() => st.swapShapes((s) => s.groupId === gid && isGuidePart(s), next))
  const now = useStore.getState()
  if (wholeGroup) now.selectGroup(gid)
  else {
    const ids = new Set(now.doc.shapes.map((s) => s.id))
    if (now.selection.some((i) => !ids.has(i))) now.select(now.selection.filter((i) => ids.has(i)))
  }
  pinGroupAnchor(outlineId)
}

/**
 * The outline with new params: Studio's clamps applied and the pocket rebuilt. The cut settings are
 * left alone (Studio keeps the pocket's tool at 1/4 in whatever the bit diameter param says).
 */
export function rebuildBoxJoint(s: Shape, p: Record<string, number>, units: Units): Shape {
  const kind = jointKindOf(s)
  if (!kind) return s
  const v = clampBoxJoint(kind, p, units)
  const params = { ...s.params! }
  for (const k of Object.keys(jointParams(s))) params[k] = v[k]
  return { ...s, params, contours: boxJointPocket(kind, v) }
}

/** Sets box joint params (clamped as Studio does) and re-syncs its guides. One undo step (via updateShapes). */
export function updateBoxJoint(outlineId: string, patch: Record<string, number>): void {
  const st = useStore.getState()
  const s = st.doc.shapes.find((x) => x.id === outlineId)
  if (!s || !isBoxJoint(s)) return
  const next = rebuildBoxJoint(s, { ...jointParams(s), ...patch }, st.doc.units)
  // A value clamped back to what it was changes nothing (and adds no undo step).
  if (Object.keys(jointParams(s)).every((k) => next.params![k] === s.params?.[k])) return
  st.updateShapes([outlineId], () => next)
  syncBoxJointGuides(outlineId)
}

/**
 * A box joint scaled by (fx, fy) about `anchor` (world): the scale goes into its params (Studio's
 * getParametersAfterScale, then the clamps) and the shape stays unscaled, never stretched.
 */
export function scaleBoxJoint(o: Shape, fx: number, fy: number, anchor: Pt, units: Units): Shape {
  // A quarter-turned joint takes the world x scale on its thickness.
  const rot = (((o.rotation % 180) + 180) % 180)
  const swap = Math.abs(rot - 90) < 45
  const dx = Math.abs(swap ? fy : fx)
  const dy = Math.abs(swap ? fx : fy)
  const p = scaleBoxJointParams(jointParams(o), dx, dy)
  return {
    ...rebuildBoxJoint(o, p, units),
    x: anchor.x + (o.x - anchor.x) * fx,
    y: anchor.y + (o.y - anchor.y) * fy,
    sx: 1,
    sy: 1,
  }
}

/** Moves the box joint group's anchor to one of its stock anchors. */
export function setBoxJointAnchor(outlineId: string, a: StockAnchor): void {
  const st = useStore.getState()
  const s = st.doc.shapes.find((x) => x.id === outlineId)
  if (!s || !isBoxJoint(s)) return
  st.updateShapes([outlineId], (o) => ({ ...o, params: { ...o.params!, anchor: a } }))
  pinGroupAnchor(outlineId)
}

/** Creates a box joint outline with its guides in a new group, anchored to the stock's top-left corner. */
export function placeBoxJoint(outline: Shape): void {
  const group: Group = { id: uid('g'), name: outline.name.toLowerCase() }
  const grouped: Shape = {
    ...outline,
    groupId: group.id,
    meta: { ...outline.meta, role: 'outline' },
    params: { ...outline.params!, anchor: stockAnchorOf(outline) },
  }
  useStore.getState().addGroupShapes(group, [grouped, ...boxJointGuideShapes(grouped, group.id)])
  pinGroupAnchor(grouped.id)
}
