// 2.5D carving plan: for every layer, the region the bit centre must avoid, and the geometry
// that results from it (guide contour, compensated toolpath, pocket region).
//
// Notation: depth d is measured down from the model top (z = H − d). S(d) is the model's
// section at depth d (material that must remain there). A bit with tip at depth d has,
// at height h above the tip, a section of radius reachRadius(bit, h) which sits at depth d − h.
//
//   Forbidden_i = ⋃ over sampled δ ≤ d_i of offset(S(δ), reachRadius(bit, d_i − δ))
//
// The bit centre must stay outside Forbidden_i: every shallower piece of material, however
// wide, is accounted for, so undercuts and V-bit flanks cannot gouge the shoulders above.
//
//   toolpath = boundary of Forbidden_i (the on-line centre path; not clipped to the stock).
//   pocket   = stock − offset(Forbidden_i, −r_top) − S(d_i)
//
// Pocket reasoning: a point p is removable in this layer iff some allowed centre c (c ∉
// Forbidden_i) lies within the bit's reach of p. The widest the bit gets inside the layer is
// r_top = reachRadius(bit, t) at the top of the layer (t = layer thickness; for flat, V and
// ball profiles the radius is non-decreasing in height, so the top is the widest). Hence
// p is reachable iff disk(p, r_top) is not contained in Forbidden_i, i.e. p ∉ erode(Forbidden_i,
// r_top). erode(F, r) = offset(F, −r). The kept material S(d_i) is subtracted explicitly so the
// pocket can never cover material that must stay, even where Forbidden does not reach far
// enough around it.
import type { Contour, Pt, Shape, Units } from '../../model/types'
import { fmtLen, shapeFromWorld } from '../../model/factory'
import { boolean, offsetContours, signedArea } from '../../geometry/offset'
import { coneHeight, radiusAtHeight, type Bit } from './bits'
import { sliceDetailed, yieldFrame, type SliceResult } from './slicer'

export interface TabSettings {
  /** Number of uncut bridges around the through-cut outline (0 = none). */
  count: number
  /** Bridge width along the outline, mm. */
  width: number
  /** Height of material left at the bridge, mm. */
  height: number
}

export interface CarveSettings {
  bit: Bit
  /** Step-down per layer, mm. */
  stepDown: number
  /** Stock thickness, mm. Capped at the model height. */
  stockThickness: number
  /** Margin around the model footprint, mm. Raised to the bit's reach + 1 mm if smaller. */
  margin: number
  throughCut: boolean
  tabs?: TabSettings
  outputs: { contour: boolean; toolpath: boolean; pocket: boolean }
  units: Units
  /** Depth the plan starts at (a previous stage already carved above it), mm. Default 0. */
  startDepth?: number
  /**
   * Radial stock to leave on every wall, mm (a roughing pass leaves it for the finishing bit).
   * The bit centre keeps this much further from the material. Default 0.
   */
  leave?: number
  /**
   * Extra material the bit must not touch, besides the model: regions (design space) present
   * from depth `from` to `to`. The multi-sided planner keeps its bridges here so no setup cuts
   * them.
   */
  keepOut?: KeepOut[]
  /** Outline for the through-cut. Default: the union of the layer sections. */
  throughOutline?: Contour[]
  /** Depth of the through-cut, mm. Default: the carve depth. */
  throughDepth?: number
  /** Prepended to every shape name, e.g. "Top · Rough" for a multi-sided plan. */
  labelPrefix?: string
  /**
   * This plan is one face of a multi-sided (flip) job: undercut warnings are meaningless (the
   * flip reaches them) and their scan is skipped. Default false.
   */
  multiSide?: boolean
  /**
   * false = the plan is outline-only (no pocket regions): the cutting animation must not
   * ring-clear the layer, just follow the outlines. Default true.
   */
  rings?: boolean
  /** Identifies the inputs this plan was made from. The dialog compares it with its current key. */
  key?: string
}

export interface KeepOut {
  regions: Contour[]
  /** Depth band the regions occupy, mm from the plan top. */
  from: number
  to: number
}

export interface CarveLayer {
  index: number
  /** Tip depth below the model top, mm. */
  depth: number
  /** Side offset of the bit centre at the top of the layer, mm (the reach at that height). */
  sideOffset: number
  /** Number of guide contours in the material that remains at this depth. */
  contours: number
  /** Chains that did not close at this depth (mesh not watertight). */
  openLoops: number
  /** Real slice outline S(d), design space (y down). */
  guide: Contour[]
  /** Centre path, design space. */
  toolpath: Contour[]
}

export interface CarvePlan {
  /** Settings key this plan was computed for. */
  key: string
  /** The bit the plan was made for (the finished surface and animation cut with it). */
  bit: Bit
  layers: CarveLayer[]
  shapes: Omit<Shape, 'id'>[]
  warnings: string[]
  info: Record<string, number | string>
  /**
   * z of the plan top, mm: the face depths are measured from. The model top for a single-sided
   * plan; the stock face of a multi-sided setup (above the model when the block has margin there).
   */
  modelH: number
  /** Stock thickness as set, mm (not capped at the model height). */
  stockThickness: number
  /** Depth actually carved, mm (min of model height and stock thickness). */
  carveDepth: number
  /** Depth of the through-cut, mm (the carve depth unless set otherwise). */
  throughDepth: number
  /** Stock block footprint, design space. */
  stock: Contour[]
  /** Union of all kept contours: the model's footprint, design space. */
  outline: Contour[]
  /** True when the piece is cut out along the outline. */
  throughCut: boolean
  /** Through-cut split: pieces cut all the way, bridges cut to `bridgeDepth`. Null without a through-cut. */
  tabs: { through: Contour[]; bridges: Contour[]; bridgeDepth: number } | null
  /** false = outline-only plan: the animation follows the outlines without ring-clearing. */
  rings: boolean
}

/** Thrown when a run is cancelled through the AbortSignal. */
export class CarveCancelled extends Error {
  constructor() {
    super('carve plan cancelled')
    this.name = 'CarveCancelled'
  }
}

/** Work shared between the stage plans of one side (see buildMultiSidePlan). */
export interface PlanContext {
  /**
   * Shared slice cache, keyed by rounded depth. Multi-side planning slices the rotated mesh
   * once per grid depth and hands the results to every stage of that side, instead of each
   * stage slicing the mesh again.
   */
  slices?: Map<number, SliceResult>
  /** Cap on per-layer depth samples; lower keeps V-bit stage grids light. Default 40. */
  sampleCap?: number
}

const round2 = (v: number) => Math.round(v * 100) / 100

/** Depth we actually carve: the stock thickness, but never deeper than the model. */
export function carveDepth(modelH: number, stockT: number): number {
  return Math.max(0, Math.min(modelH, stockT))
}

/** Number of layers needed to reach `depth` with step `step`, starting at `from` (default 0). */
export function layerCount(depth: number, step: number, from = 0): number {
  if (depth <= from + 1e-9 || step <= 0) return 0
  return Math.max(1, Math.ceil((depth - from) / step - 1e-6))
}

/** Tip depth of every layer: min(from + i·s, depth). */
export function layerDepths(depth: number, step: number, from = 0): number[] {
  const n = layerCount(depth, step, from)
  return Array.from({ length: n }, (_, i) => Math.min(from + (i + 1) * step, depth))
}

/**
 * Tool radius at height h above the tip. Above the flutes the cutter is the shank, so the
 * radius is the larger of shank and cutter (conservative when the shank is smaller).
 */
export function reachRadius(bit: Bit, h: number): number {
  const R = bit.diameter / 2
  const shankR = (bit.shankDiameter ?? bit.diameter) / 2
  if (h > bit.fluteLength + 1e-9) return Math.max(R, shankR)
  return radiusAtHeight(bit, h)
}

/**
 * Intermediate depth samples per layer. Between two samples the tool radius may change by at
 * most 0.02 mm. Flat bits need only the layer boundaries (n = 1). Capped at `cap` (40).
 */
export function samplesPerLayer(bit: Bit, step: number, cap = 40): number {
  const K = 200
  let slope = 0
  for (let k = 0; k < K; k++) {
    const h0 = (step * k) / K
    const h1 = (step * (k + 1)) / K
    slope = Math.max(slope, Math.abs(reachRadius(bit, h1) - reachRadius(bit, h0)) / (h1 - h0))
  }
  return Math.min(cap, Math.max(1, Math.ceil((slope * step) / 0.02 - 1e-9)))
}

/** Sorted, de-duplicated depth samples in [0, T]: layer boundaries plus n−1 samples per layer. */
export function depthGrid(T: number, step: number, n: number): number[] {
  const N = layerCount(T, step)
  const raw: number[] = [0]
  for (let i = 0; i < N; i++) for (let k = 1; k <= n; k++) raw.push(Math.min(T, i * step + (k * step) / n))
  const out: number[] = []
  for (const v of raw.sort((a, b) => a - b)) if (!out.length || v - out[out.length - 1] > 1e-9) out.push(v)
  return out
}

/** Footprint bbox of the placed model in design coordinates (y down). */
function footprint(positions: Float32Array) {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i]
    const y = -positions[i + 1]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
  }
  return { minX, minY, maxX, maxY }
}

const absArea = (cs: Contour[]) => Math.abs(cs.reduce((a, c) => a + (c.closed ? signedArea(c.pts) : 0), 0))

/**
 * Split closed outline contours at `count` bridge positions of length `width`. Returns the pieces
 * that are cut through and the bridge pieces (cut only to the bridge depth). With no tabs the
 * outline comes back unchanged. Holes (loops wound against the outer boundary) are cut through
 * whole: what is inside a hole is waste, and a bridge there would only hold the plug in place.
 */
export function splitTabs(contours: Contour[], count: number, width: number): { through: Contour[]; tabs: Contour[] } {
  if (count <= 0 || width <= 0) return { through: contours, tabs: [] }
  const through: Contour[] = []
  const tabs: Contour[] = []
  const areas = contours.map((c) => (c.closed && c.pts.length >= 3 ? signedArea(c.pts) : 0))
  const outerSign = Math.sign(areas.reduce((m, a) => (Math.abs(a) > Math.abs(m) ? a : m), 0))
  for (let ci = 0; ci < contours.length; ci++) {
    const c = contours[ci]
    if (!c.closed || c.pts.length < 3 || Math.sign(areas[ci]) !== outerSign) {
      through.push(c)
      continue
    }
    const pts: Pt[] = [...c.pts, c.pts[0]]
    const cum: number[] = [0]
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
    const P = cum[cum.length - 1]
    if (P <= 0) continue
    const w = Math.min(width, (0.9 * P) / count)
    const at = (s: number): Pt => {
      let j = 0
      while (j < cum.length - 2 && cum[j + 1] < s) j++
      const seg = cum[j + 1] - cum[j] || 1
      const f = (s - cum[j]) / seg
      return { x: pts[j].x + f * (pts[j + 1].x - pts[j].x), y: pts[j].y + f * (pts[j + 1].y - pts[j].y) }
    }
    const piece = (s0: number, s1: number): Contour => {
      const out: Pt[] = [at(s0)]
      for (let j = 0; j < pts.length; j++) if (cum[j] > s0 + 1e-9 && cum[j] < s1 - 1e-9) out.push(pts[j])
      out.push(at(s1))
      return { closed: false, pts: out }
    }
    const ivs: [number, number][] = []
    for (let k = 0; k < count; k++) {
      const centre = ((k + 0.5) * P) / count
      const a = centre - w / 2
      const b = centre + w / 2
      if (a < 0) ivs.push([0, b], [a + P, P])
      else if (b > P) ivs.push([a, P], [0, b - P])
      else ivs.push([a, b])
    }
    ivs.sort((x, y) => x[0] - y[0])
    let cursor = 0
    for (const [a, b] of ivs) {
      if (a > cursor + 1e-6) through.push(piece(cursor, a))
      tabs.push(piece(a, b))
      cursor = Math.max(cursor, b)
    }
    if (cursor < P - 1e-6) through.push(piece(cursor, P))
  }
  return { through, tabs }
}

/**
 * Build the per-layer carving geometry. `positions` is the placed model (mm, Z up, min Z = 0).
 * The model top is at z = modelH. Yields to the UI between layers and throws CarveCancelled
 * when `signal` aborts.
 */
export async function buildCarvePlan(
  positions: Float32Array,
  modelH: number,
  st: CarveSettings,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  ctx?: PlanContext,
): Promise<CarvePlan> {
  const { bit, units } = st
  if (bit.carvable === false || bit.type === 'undercut') throw new Error(bit.carveReason ?? 'This bit cannot carve top-down.')
  const s = st.stepDown
  const T = carveDepth(modelH, st.stockThickness)
  // Stages after the first start below material a previous stage already carved away. A start
  // at or below the carve depth leaves no layers (an outline-only cut-out stage).
  const d0 = Math.max(0, st.startDepth ?? 0)
  const N = layerCount(T, s, d0)
  const depths = layerDepths(T, s, d0)
  const R = bit.diameter / 2
  const maxReach = Math.max(R, (bit.shankDiameter ?? bit.diameter) / 2)
  const fmt = (mm: number) => fmtLen(mm, units)
  const pad = Math.max(2, String(N).length)
  const L = (i: number) => `L${String(i).padStart(pad, '0')}`
  const prefix = st.labelPrefix ? `${st.labelPrefix} · ` : ''
  const label = (i: number, role: string, d: number) => `${prefix}${L(i)} · ${role} · ${fmt(d)}`

  const fp = footprint(positions)
  const m = Math.max(st.margin, maxReach + 1)
  const stockRect: Contour[] = [
    {
      closed: true,
      pts: [
        { x: fp.minX - m, y: fp.minY - m },
        { x: fp.maxX + m, y: fp.minY - m },
        { x: fp.maxX + m, y: fp.maxY + m },
        { x: fp.minX - m, y: fp.maxY + m },
      ],
    },
  ]

  // S(d): one slice per distinct depth, shared by neighbouring layers — and, via the context,
  // by the other stages carved on the same face of the block.
  const slices = ctx?.slices ?? new Map<number, SliceResult>()
  const keepAt = (d: number): SliceResult => {
    const key = Math.round(d * 1e6)
    const hit = slices.get(key)
    if (hit) return hit
    // d = 0 sits exactly on the top face; sample just below it instead.
    const res = sliceDetailed(positions, modelH - Math.max(d, 1e-4))
    slices.set(key, res)
    return res
  }

  const n = samplesPerLayer(bit, s, ctx?.sampleCap)
  const keepOut = (st.keepOut ?? []).filter((k) => k.regions.length && k.to > k.from && k.from < T)
  // Keep-out bands thinner than a layer must still be sampled: add their edges to the grid.
  const grid = keepOut.length
    ? [...new Set([...depthGrid(T, s, n), ...keepOut.flatMap((k) => [Math.max(0, k.from), Math.min(T, k.to)])])].sort((a, b) => a - b)
    : depthGrid(T, s, n)
  const leave = Math.max(0, st.leave ?? 0)

  const forbiddenAt = (d: number): Contour[] => {
    let F: Contour[] = []
    for (const delta of grid) {
      if (delta > d + 1e-9) break
      let set = keepAt(delta).contours
      for (const k of keepOut) if (delta >= k.from - 1e-9 && delta <= k.to + 1e-9) set = set.length ? boolean('union', set, k.regions) : k.regions
      if (!set.length) continue
      const r = reachRadius(bit, Math.max(0, d - delta)) + leave
      const grown = r > 1e-9 ? offsetContours(set, r) : set
      F = F.length ? boolean('union', F, grown) : grown
    }
    return F
  }

  const warnings: string[] = []
  let undercutAt: number | null = null
  let scanned = 0 // grid index of the shallow end of the next undercut check
  // In a multi-sided job the flip itself reaches undercuts, so the single-face check is off.
  const checkUndercuts = !st.multiSide
  const cut = (type: 'guide' | 'online' | 'pocket' | 'outside', depth: number) => ({ type, depth, offset: 0, bitDia: bit.diameter })
  const note = (d: number) => `tip depth ${fmt(d)} (${bit.name})`

  const layers: CarveLayer[] = []
  const shapes: Omit<Shape, 'id'>[] = []
  const guideShapes: Omit<Shape, 'id'>[] = []
  let outline: Contour[] = []
  let prevDepth = 0

  for (let i = 1; i <= N; i++) {
    if (signal?.aborted) throw new CarveCancelled()
    onProgress?.((i - 1) / N)
    await yieldFrame()
    if (signal?.aborted) throw new CarveCancelled()

    const d = depths[i - 1]
    const t = d - prevDepth
    prevDepth = d
    const keepRes = keepAt(d)
    const keep = keepRes.contours

    // Undercut check: S(shallow) must sit inside S(deep) (0.05 mm tolerance).
    while (checkUndercuts && undercutAt === null && scanned + 1 < grid.length && grid[scanned + 1] <= d + 1e-9) {
      const a = grid[scanned]
      const b = grid[scanned + 1]
      const Sa = keepAt(a).contours
      const Sb = keepAt(b).contours
      if (Sa.length) {
        const over = Sb.length ? boolean('difference', Sa, offsetContours(Sb, 0.05)) : Sa
        if (absArea(over) > 0.01) undercutAt = a
      }
      scanned++
    }

    const forbidden = forbiddenAt(d)
    const rTop = reachRadius(bit, t) // widest the bit gets inside this layer
    const open = keepRes.openChains
    if (open) warnings.push(`${open} open loop${open > 1 ? 's' : ''} at depth ${fmt(d)} (mesh isn't watertight)`)

    outline = outline.length ? boolean('union', outline, keep) : keep
    layers.push({
      index: i,
      depth: d,
      sideOffset: rTop,
      contours: keep.length,
      openLoops: open,
      guide: keep,
      toolpath: forbidden,
    })

    if (st.outputs.toolpath && forbidden.length) {
      shapes.push(
        shapeFromWorld('slice', label(i, 'toolpath', d), forbidden, {
          cut: cut('online', d),
          meta: { source: '3d', layer: i, role: 'toolpath', bitId: bit.id, note: note(d) },
        }),
      )
    }
    if (st.outputs.pocket) {
      let pk = boolean('difference', stockRect, forbidden.length ? offsetContours(forbidden, -rTop) : [])
      if (keep.length && pk.length) pk = boolean('difference', pk, keep)
      if (pk.length) {
        shapes.push(
          shapeFromWorld('slice', label(i, 'pocket', d), pk, {
            cut: cut('pocket', d),
            meta: { source: '3d', layer: i, role: 'pocket', bitId: bit.id, note: note(d) },
          }),
        )
      }
    }
    if (st.outputs.contour && keep.length) {
      guideShapes.push(
        shapeFromWorld('slice', label(i, 'contour', d), keep, {
          cut: cut('guide', d),
          meta: { source: '3d', layer: i, role: 'contour', bitId: bit.id, note: note(d) },
        }),
      )
    }
    onProgress?.(i / N)
  }

  if (undercutAt !== null) warnings.push(`Model has undercuts at depth ${fmt(undercutAt)} — they can't be carved from the top`)
  if (bit.type === 'vbit' && !st.multiSide && T > coneHeight(bit)) {
    warnings.push(`Below ${fmt(coneHeight(bit))} this V-bit is at full Ø and cuts a flat-bottomed groove`)
  }

  const throughShapes: Omit<Shape, 'id'>[] = []
  if (st.throughOutline) outline = st.throughOutline
  const throughCut = st.throughCut && outline.length > 0
  const throughDepth = st.throughDepth ?? T
  let tabPlan: CarvePlan['tabs'] = null
  if (throughCut) {
    const tabs = st.tabs ?? { count: 0, width: 0, height: 0 }
    const { through, tabs: bridges } = splitTabs(outline, tabs.count, tabs.width)
    const bridgeDepth = Math.max(0, throughDepth - tabs.height)
    tabPlan = { through, bridges, bridgeDepth }
    if (through.length) {
      throughShapes.push(
        shapeFromWorld('slice', `${prefix}Through-cut outline · ${fmt(throughDepth)}`, through, {
          cut: cut('outside', throughDepth),
          meta: { source: '3d', role: 'outline', bitId: bit.id, note: 'outside cut of the model footprint at full depth' },
        }),
      )
    }
    if (bridges.length) {
      throughShapes.push(
        shapeFromWorld('slice', `${prefix}Through-cut bridges · ${fmt(bridgeDepth)}`, bridges, {
          cut: cut('outside', bridgeDepth),
          meta: {
            source: '3d',
            role: 'outline',
            bitId: bit.id,
            note: `${tabs.count} bridge${tabs.count > 1 ? 's' : ''} ${fmt(tabs.width)} wide, ${fmt(tabs.height)} of material left at the bottom`,
          },
        }),
      )
    }
  }

  onProgress?.(1)
  return {
    key: st.key ?? '',
    bit,
    layers,
    // Order: per layer toolpath + pocket (shallow first), then the through-cut, then the guides last.
    shapes: [...shapes, ...throughShapes, ...guideShapes],
    warnings,
    info: {
      bit: bit.name,
      layers: N,
      stepDown: round2(s),
      stock: round2(T),
      margin: round2(m),
      samples: n,
    },
    modelH,
    stockThickness: st.stockThickness,
    carveDepth: T,
    throughDepth,
    stock: stockRect,
    outline,
    throughCut,
    tabs: tabPlan,
    rings: st.rings ?? true,
  }
}
