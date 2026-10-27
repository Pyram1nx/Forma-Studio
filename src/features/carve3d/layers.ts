// Layered blocks: a model too deep for the bits (or for Origin's 43 mm of Z travel) is cut from
// a stack of thinner boards that are glued up afterwards. Each board — a LAYER — is planned as a
// multi-sided job of its own: the model is clipped to the layer's slab, the cut faces are capped
// so the piece is a closed solid again, and the piece goes through the same analysis, planning
// and finished-part pipeline as a whole model.
//
// Layers are numbered from the top. The block's stock stays top-aligned with the model (as in a
// single-board job); a block thicker than the model gets its extra in the bottom board.
import * as THREE from 'three'
import type { Shape } from '../../model/types'
import { CarveCancelled } from './carvePlan'
import type { PlacedModel } from './loadModel'
import { buildMultiSidePlan, layerLimit, SHEET_PITCH, type MultiSidePlan, type MultiSideSettings } from './multiSide'
import { analyzeSides, type SideAnalysis, type SideId } from './sideAnalysis'
import { sliceDetailed } from './slicer'

export interface LayeredSettings extends MultiSideSettings {
  /** Number of boards the block is split into (1 = one block). */
  layers: number
}

export interface LayerResult {
  /** 0 = top layer. */
  index: number
  /** Board extent in the original model frame (z of its bottom and top face), mm. */
  z0: number
  z1: number
  /** The model piece in this layer, min z = 0 (add `offsetZ` for the original frame). */
  placed: PlacedModel
  offsetZ: number
  plan: MultiSidePlan
}

export interface LayeredPlan {
  key: string
  layers: LayerResult[]
  /** Every layer's shapes: one row of side sheets per layer. */
  shapes: Omit<Shape, 'id'>[]
  warnings: string[]
  info: Record<string, number | string>
  /** Boards the chosen bits need for this block (≥ 1), and the thickest board they handle, mm. */
  suggestedLayers: number
  layerLimit: number
  /** Set when a top/bottom face or the cut-out is out of reach and more layers would fix it. */
  splitTo: number | null
}

// ---- slab clipping -------------------------------------------------------------------------

type V3 = [number, number, number]

/** Clip a polygon to z ≥ lo (sign 1) or z ≤ hi (sign −1). */
function clipZ(poly: V3[], z: number, sign: 1 | -1): V3[] {
  const out: V3[] = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i]
    const b = poly[(i + 1) % poly.length]
    const da = sign * (a[2] - z)
    const db = sign * (b[2] - z)
    if (da >= 0) out.push(a)
    if ((da >= 0) !== (db >= 0)) {
      const t = da / (da - db)
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, z])
    }
  }
  return out
}

/**
 * Triangulated cap over the model's section at height z, facing +z (`up`) or −z. Outer loops
 * and holes come from the slicer; holes are matched to the outer loop that contains them.
 */
function capAt(positions: Float32Array, z: number, up: boolean, out: number[]) {
  const loops = sliceDetailed(positions, z).contours.filter((c) => c.closed && c.pts.length >= 3)
  if (!loops.length) return
  // Slicer output is design space (y down); caps are built in world space (y up).
  const world = loops.map((c) => c.pts.map((p) => new THREE.Vector2(p.x, -p.y)))
  const area = world.map((pts) => THREE.ShapeUtils.area(pts))
  // The largest loop is an outer boundary: outers share its orientation, holes have the other.
  const outerSign = Math.sign(area[area.reduce((m, a, i) => (Math.abs(a) > Math.abs(area[m]) ? i : m), 0)])
  const outers = world.map((_, i) => i).filter((i) => Math.sign(area[i]) === outerSign)
  const holesOf = new Map<number, THREE.Vector2[][]>(outers.map((i) => [i, []]))
  const inside = (pts: THREE.Vector2[], p: THREE.Vector2) => {
    let n = false
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      if (pts[i].y > p.y !== pts[j].y > p.y && p.x < ((pts[j].x - pts[i].x) * (p.y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) n = !n
    return n
  }
  for (let i = 0; i < world.length; i++) {
    if (Math.sign(area[i]) === outerSign) continue
    // The smallest outer that contains the hole.
    let best = -1
    for (const o of outers) if (inside(world[o], world[i][0]) && (best < 0 || Math.abs(area[o]) < Math.abs(area[best]))) best = o
    if (best >= 0) holesOf.get(best)!.push(world[i])
  }
  for (const o of outers) {
    const holes = holesOf.get(o)!
    const pts = [world[o], ...holes].flat()
    for (const [a, b, c] of THREE.ShapeUtils.triangulateShape(world[o], holes)) {
      const A = pts[a]
      const B = pts[b]
      const C = pts[c]
      const ccw = (B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y) > 0
      const tri = ccw === up ? [A, B, C] : [A, C, B]
      for (const p of tri) out.push(p.x, p.y, z)
    }
  }
}

/**
 * The part of the model between z = lo and z = hi as a closed solid: every triangle clipped to
 * the slab, plus caps over the cut faces. Positions are shifted so min z = 0; x and y stay in the
 * model's frame, so the layers line up. Null when the slab holds no model.
 */
export function layerPiece(placed: PlacedModel, lo: number, hi: number): { placed: PlacedModel; offsetZ: number } | null {
  const src = placed.positions
  const H = placed.size.z
  const out: number[] = []
  for (let t = 0; t < src.length; t += 9) {
    let poly: V3[] = [
      [src[t], src[t + 1], src[t + 2]],
      [src[t + 3], src[t + 4], src[t + 5]],
      [src[t + 6], src[t + 7], src[t + 8]],
    ]
    const zmin = Math.min(poly[0][2], poly[1][2], poly[2][2])
    const zmax = Math.max(poly[0][2], poly[1][2], poly[2][2])
    if (zmax < lo || zmin > hi) continue
    if (zmin < lo) poly = clipZ(poly, lo, 1)
    if (zmax > hi) poly = clipZ(poly, hi, -1)
    for (let k = 1; k + 1 < poly.length; k++) out.push(...poly[0], ...poly[k], ...poly[k + 1])
  }
  // Caps where the slab cuts through the model (not on the model's own top or bottom).
  if (hi < H - 1e-6) capAt(src, hi, true, out)
  if (lo > 1e-6) capAt(src, lo, false, out)
  if (out.length < 9) return null

  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < out.length; i += 3) {
    minX = Math.min(minX, out[i])
    maxX = Math.max(maxX, out[i])
    minY = Math.min(minY, out[i + 1])
    maxY = Math.max(maxY, out[i + 1])
    minZ = Math.min(minZ, out[i + 2])
    maxZ = Math.max(maxZ, out[i + 2])
  }
  const p = new Float32Array(out)
  for (let i = 2; i < p.length; i += 3) p[i] -= minZ
  return {
    placed: {
      positions: p,
      bbox: { min: { x: minX, y: minY, z: 0 }, max: { x: maxX, y: maxY, z: maxZ - minZ } },
      size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
    },
    offsetZ: minZ,
  }
}

/** Boards needed so no top/bottom carve or cut-out goes past the bits' reach. */
export function suggestLayers(blockZ: number, limit: number): number {
  if (!Number.isFinite(limit) || limit <= 0) return 1
  return Math.max(1, Math.ceil(blockZ / limit - 1e-6))
}

/**
 * Plan the whole block as `layers` boards of equal thickness, each a multi-sided job.
 * `analysis` (of the whole model) is reused when the block is one board.
 */
export async function buildLayeredPlan(
  placed: PlacedModel,
  st: LayeredSettings,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  analysis?: Record<SideId, SideAnalysis>,
): Promise<LayeredPlan> {
  const H = placed.size.z
  const blockZ = Math.max(st.stockThickness, H)
  const n = Math.max(1, Math.min(20, Math.round(st.layers) || 1))
  const t = blockZ / n
  const limit = layerLimit(st.bits, st.holderAllowance)
  const suggested = suggestLayers(blockZ, limit)
  const warnings: string[] = []
  const layers: LayerResult[] = []
  const shapes: Omit<Shape, 'id'>[] = []

  for (let i = 0; i < n; i++) {
    if (signal?.aborted) throw new CarveCancelled()
    // Top-aligned boards: layer i spans [H − (i+1)·t, H − i·t]; the bottom one may reach below
    // the model when the stock is thicker.
    const z1 = H - i * t
    const z0 = H - (i + 1) * t
    const piece = n === 1 ? { placed, offsetZ: 0 } : layerPiece(placed, Math.max(0, z0), z1)
    const label = n > 1 ? `Layer ${i + 1}` : ''
    if (!piece) {
      warnings.push(`${label} holds none of the model — leave that board out.`)
      continue
    }
    const plan = await buildMultiSidePlan(
      piece.placed,
      // The board runs from z0 up to the piece's top (the stock face sits on the model).
      { ...st, stockThickness: piece.offsetZ + piece.placed.size.z - z0, key: `${st.key ?? ''}|L${i}` },
      (f) => onProgress?.((i + f) / n),
      signal,
      n === 1 ? analysis : analyzeSides(piece.placed),
    )
    layers.push({ index: i, z0, z1, placed: piece.placed, offsetZ: piece.offsetZ, plan })
    for (const w of plan.warnings) warnings.push(label ? `${label} · ${w}` : w)
    // One row of side sheets per layer, layer names in front.
    for (const s of plan.shapes) shapes.push({ ...s, name: label ? `${label} · ${s.name}` : s.name, y: s.y + i * SHEET_PITCH })
  }

  // Split advice: only when the bits fall short on a top/bottom face or the cut-out.
  const splitTo = layers.some((l) => l.plan.verticalShort > 0.05) && suggested > n ? suggested : null

  onProgress?.(1)
  return {
    key: st.key ?? '',
    layers,
    shapes,
    warnings,
    info: { layers: layers.length, sides: layers.reduce((a, l) => a + l.plan.sides.length, 0) },
    suggestedLayers: suggested,
    layerLimit: limit,
    splitTo,
  }
}
