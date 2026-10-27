// Pure helpers for the canvas: cut geometry, review depth levels and input maths.
// No React or DOM imports, so everything here can be unit tested directly.
import type { Contour, CutSettings } from '../../model/types'
import type { BBox } from '../../geometry/transform'
import { offsetContours, strokeOutline } from '../../geometry/offset'
import { contoursToD } from '../../geometry/svgPath'

export type CutGeomType = 'outside' | 'inside' | 'online' | 'pocket' | 'guide'

export interface CutGeometry {
  /** Effective cut type (open paths are always online, guides have no geometry). */
  type: CutGeomType
  /** Tool-centre path. Empty when the offset collapsed (bit wider than the shape). */
  centre: Contour[]
  /** Swept region: band outline for outside/inside/online, cleared area for pocket. */
  swept: Contour[]
  centreD: string
  sweptD: string
}

/**
 * Tool-centre path and swept region for a shape's cut settings.
 * Outside/inside/online: the centre path is stroked with the bit diameter in Plan,
 * and `swept` (its stroke outline) is the material removed in Review.
 * Pocket: the centre path is the bit-edge inset, `swept` is the whole cleared area.
 */
export function computeCutGeometry(world: Contour[], cut: CutSettings): CutGeometry {
  const anyClosed = world.some((c) => c.closed)
  const type: CutGeomType = cut.type === 'guide' ? 'guide' : anyClosed ? cut.type : 'online'
  if (type === 'guide') return { type, centre: [], swept: [], centreD: '', sweptD: '' }
  const r = cut.bitDia / 2
  const off = cut.offset
  // Open contours have no inside or outside: they are always cut on-line, so only
  // the closed contours are offset. Mixed shapes keep their open subpaths unchanged.
  const closed = world.filter((c) => c.closed)
  const open = world.filter((c) => !c.closed)
  let centre: Contour[]
  let swept: Contour[]
  if (type === 'outside') {
    centre = [...offsetContours(closed, r + off), ...open]
    swept = strokeOutline(centre, cut.bitDia)
  } else if (type === 'inside') {
    centre = [...offsetContours(closed, -(r + off)), ...open]
    swept = strokeOutline(centre, cut.bitDia)
  } else if (type === 'online') {
    centre = off && anyClosed ? [...offsetContours(closed, off), ...open] : world
    swept = strokeOutline(centre, cut.bitDia)
  } else {
    centre = [...offsetContours(closed, -(r + off)), ...open]
    swept = offsetContours(centre, r)
  }
  return { type, centre, swept, centreD: contoursToD(centre), sweptD: contoursToD(swept) }
}

/**
 * Review depth level: clamp(ceil(depth_mm / 2.54), 1, 7). Unset depth is level 0.
 * 0.25 in -> 3, 0.5 in -> 5, 20 in -> 7.
 */
export function depthLevel(depth: number | null | undefined): number {
  // Unset (null, or 0 from an imported file) is level 0: no cut depth recorded.
  if (depth == null || !Number.isFinite(depth) || depth <= 0) return 0
  // The small epsilon keeps exact inch multiples (0.5 in = 12.7 mm) on their own level.
  return Math.min(7, Math.max(1, Math.ceil(depth / 2.54 - 1e-9)))
}

/** Inner-shadow offset (px, screen space) per review depth level. Matches canvas.css. */
export const REVIEW_SHADOW_DY = [0, 0.22, 0.35, 0.5, 0.5, 0.625, 0.75, 0.875]

/**
 * Scale factor along one axis for a scale handle. Degenerate axes (zero-width or
 * zero-height selection) keep factor 1 instead of dividing by ~0.
 */
export function axisFactor(p: number, anchor: number, ref: number): number {
  const span = ref - anchor
  if (Math.abs(span) < 1e-6) return 1
  const f = (p - anchor) / span
  return Math.abs(f) < 1e-3 ? 1e-3 : f
}

/**
 * Proportional corner scale about the anchor (Studio's): the pointer's travel since the grab, projected on the
 * line from the anchor through the handle. 1 at no travel; negative flips through the anchor.
 */
export function cornerFactor(delta: { x: number; y: number }, anchor: { x: number; y: number }, ref: { x: number; y: number }): number {
  const vx = ref.x - anchor.x
  const vy = ref.y - anchor.y
  const len2 = vx * vx + vy * vy
  if (len2 < 1e-12) return 1
  const f = 1 + (delta.x * vx + delta.y * vy) / len2
  return Math.abs(f) < 1e-3 ? 1e-3 : f
}

/** One-axis scale about the anchor for an edge handle (or a free corner axis), measured from the grab point. */
export function edgeFactor(delta: number, anchor: number, ref: number): number {
  const span = ref - anchor
  if (Math.abs(span) < 1e-6) return 1
  const f = 1 + delta / span
  return Math.abs(f) < 1e-3 ? 1e-3 : f
}

/** A handle that sits on the anchor's row or column (on an axis it scales) has nothing to scale from, so it is hidden. */
export function handleUsable(handle: string, ref: { x: number; y: number }, anchor: { x: number; y: number }): boolean {
  const sx = handle.includes('l') || handle.includes('r')
  const sy = handle.startsWith('t') || handle.startsWith('b')
  if (sx && Math.abs(ref.x - anchor.x) < 1e-6) return false
  if (sy && Math.abs(ref.y - anchor.y) < 1e-6) return false
  return true
}

/**
 * Heuristic for a physical mouse wheel. Trackpads send fractional or small deltas
 * and are treated as pan; wheel notches are integer multiples of 10 px.
 */
export function isMouseWheelDelta(e: { deltaMode: number; deltaX: number; deltaY: number }): boolean {
  if (e.deltaMode === 1) return true
  return e.deltaMode === 0 && e.deltaX === 0 && Number.isInteger(e.deltaY) && Math.abs(e.deltaY) >= 40 && e.deltaY % 10 === 0
}

/** Per-event zoom factor for ctrl/cmd+wheel (and wheel notches), clamped to [0.8, 1.25]. */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrl: boolean): number {
  const dy = deltaMode === 1 ? deltaY * 16 : deltaY
  const f = Math.exp(-dy * (ctrl ? 0.01 : 0.0015))
  return Math.min(1.25, Math.max(0.8, f))
}

export const clampRange = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/** Width of a label pill sized to its text (13.5 px UI font). */
export function textPillWidth(text: string, pad = 8): number {
  return Math.round(text.length * 7.4) + pad * 2
}

/** World-space rectangle currently visible in the viewport. */
export function visibleWorldRect(view: { zoom: number; panX: number; panY: number }, vw: number, vh: number): BBox {
  return {
    minX: -view.panX / view.zoom,
    minY: -view.panY / view.zoom,
    maxX: (vw - view.panX) / view.zoom,
    maxY: (vh - view.panY) / view.zoom,
  }
}
