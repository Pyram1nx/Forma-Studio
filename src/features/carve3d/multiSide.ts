// Multi-sided carving: the planner that flips the block.
//
// A model inside a stock block is carved from several of the block's six faces; between setups
// the block is flipped, and bridges keep the part sitting in the block at the same position the
// whole time. Which faces need work comes from analyzeSides (each face's waste
// columns, see sideAnalysis.ts). Each face is then carved in PROCESS STAGES: a roughing bit with a large
// step-down clears the bulk and leaves a finish allowance on every wall and floor, a finer bit
// takes the finishing pass over the whole face down to the final surface (it also reaches
// whatever the roughing bit was too big for), and an engraving V-bit adds the finest detail near
// the bottom. Every stage is a CarvePlan over its own depth range (carvePlan.startDepth), so the
// shape outputs stay per-layer and can be previewed and animated exactly like a single-sided plan.
//
// Depths of every setup are measured from that setup's STOCK face: the plan top sits `faceOffset`
// above the model face (the block margin on the four side faces, the extra stock thickness under
// the model on the bottom face).
//
// The part is cut out of the block exactly once, by a cut-out stage on the last carved vertical
// face: an outside cut along the model's silhouette through the whole block, with bridges at the
// far side. The bridges are reserved before any setup is planned and are keep-out material for
// every setup, so no later pass (or earlier one, on the opposite face) cuts them.
import type { Contour, Shape, Units } from '../../model/types'
import { fmtLen } from '../../model/factory'
import { boolean, offsetContours } from '../../geometry/offset'
import { coneHeight, reachDepth, BITS, ORIGIN_MAX_DEPTH, type Bit } from './bits'
import {
  buildCarvePlan,
  CarveCancelled,
  depthGrid,
  samplesPerLayer,
  splitTabs,
  type CarvePlan,
  type KeepOut,
  type PlanContext,
  type TabSettings,
} from './carvePlan'
import type { PlacedModel } from './loadModel'
import { analyzeSides, SIDE_LABEL, SIDE_ORDER, rotateToSide, sideFrame, type SideAnalysis, type SideId } from './sideAnalysis'
import { createMeshSlicer, yieldFrame, type SliceResult } from './slicer'

export { SIDE_LABEL, SIDE_ORDER }
export type { SideId }

export type StageRole = 'rough' | 'detail' | 'engrave' | 'cutout'

export const STAGE_LABEL: Record<StageRole, string> = { rough: 'Rough', detail: 'Detail', engrave: 'Engrave', cutout: 'Cut out' }

/** Bit ids per stage role; null = stage off. */
export interface StageBits {
  rough: string | null
  detail: string | null
  engrave: string | null
}

function pickStageBits(pool: Bit[]): StageBits {
  const carvable = pool.filter((b) => b.carvable)
  const flats = carvable.filter((b) => b.type === 'flat').sort((a, b) => b.diameter - a.diameter)
  const rough = flats[0] ?? null
  // The finishing flat: mid-sized, clearly finer than the roughing bit.
  const detail =
    flats.find((b) => b !== rough && b.diameter <= (rough?.diameter ?? 0) / 2) ??
    flats[flats.length > 1 ? 1 : 0] ??
    null
  const engrave =
    carvable
      .filter((b) => b.type === 'vbit')
      .sort((a, b) => (b.angle ?? 90) - (a.angle ?? 90))[0] ?? null
  return { rough: rough?.id ?? null, detail: detail?.id ?? null, engrave: engrave?.id ?? null }
}

/**
 * Sensible defaults: biggest flat bit clears, a mid flat finishes, sharpest V engraves. From the
 * user's bit gallery when given (they cannot cut with bits they do not have); a stage no owned
 * bit can do falls back to the full catalogue.
 */
export function autoStageBits(preferred?: Bit[]): StageBits {
  if (!preferred?.length) return pickStageBits(BITS)
  const mine = pickStageBits(preferred)
  const full = pickStageBits(BITS)
  return { rough: mine.rough ?? full.rough, detail: mine.detail ?? full.detail, engrave: mine.engrave ?? full.engrave }
}

/**
 * Faces to switch on for a fresh analysis: every face with work, plus the top when neither
 * vertical face has any — the part still has to be cut out of the block from one of them.
 */
export function defaultSides(a: Record<SideId, SideAnalysis>): SideId[] {
  const on = SIDE_ORDER.filter((s) => a[s].needed)
  if (!a.top.needed && !a.bottom.needed) on.unshift('top')
  return on
}

export interface SideStage {
  role: StageRole
  bit: Bit
  /** Depth range from the model's own face in this side's frame, mm (0 = the face itself). */
  depthFrom: number
  depthTo: number
  stepDown: number
  /** Radial stock left on the walls for the next stage, mm. */
  leave: number
}

/** A stage shallower than this is not worth switching bits for (mm). */
const MIN_STAGE = 0.2

const stageBit = (id: string | null): Bit | null => (id ? BITS.find((b) => b.id === id && b.carvable) ?? null : null)
const anyStageBit = (sel: StageBits) => !!(stageBit(sel.rough) || stageBit(sel.detail) || stageBit(sel.engrave))

/**
 * Split a face's carve depth [0, faceDepth] into stages. Rough stops `finishAllowance` short and
 * leaves the same allowance on the walls; detail is the finishing pass over the whole depth
 * (the rough bit's big steps leave stairs, and it cannot reach narrow features at all); engrave
 * re-cuts the last `engraveDepth` with the V-bit's fine tip. The final stage always reaches the
 * face depth.
 */
export function buildStages(
  faceDepth: number,
  sel: StageBits,
  opts: { finishAllowance: number; engraveDepth: number; stepDown: number },
): SideStage[] {
  const out: SideStage[] = []
  const rough = stageBit(sel.rough)
  const detail = stageBit(sel.detail)
  // Without a finishing stage the rough bit is the last word: no allowance.
  const allowance = detail ? Math.max(0, opts.finishAllowance) : 0

  if (rough && faceDepth - allowance > MIN_STAGE) {
    // Roughing takes a coarse step-down: the bit's own scale, never beyond its flutes.
    const step = Math.min(rough.fluteLength, Math.max(opts.stepDown, rough.diameter / 2))
    out.push({ role: 'rough', bit: rough, depthFrom: 0, depthTo: faceDepth - allowance, stepDown: step, leave: allowance })
  }

  if (detail && faceDepth > MIN_STAGE) {
    out.push({ role: 'detail', bit: detail, depthFrom: 0, depthTo: faceDepth, stepDown: opts.stepDown, leave: 0 })
  }

  const engrave = stageBit(sel.engrave)
  if (engrave && engrave.type === 'vbit' && faceDepth > 1) {
    // Keep the V-bit inside its cone, where it is actually finer than the detail bit.
    const d = Math.min(opts.engraveDepth, coneHeight(engrave), faceDepth - 1e-6)
    if (d > MIN_STAGE)
      out.push({
        role: 'engrave',
        bit: engrave,
        depthFrom: Math.max(0, faceDepth - d),
        depthTo: faceDepth,
        stepDown: Math.max(MIN_STAGE, Math.min(opts.stepDown, d)),
        leave: 0,
      })
  }

  if (out.length && out[out.length - 1].depthTo < faceDepth - 1e-6) out[out.length - 1].depthTo = faceDepth
  return out
}

/**
 * The bit for the cut-out: a straight stage bit that reaches through the block (reachDepth),
 * the finer one first (a narrower channel needs less margin). Falls back to the deepest reach.
 */
export function cutoutBit(sel: StageBits, depth: number, holder?: number): { bit: Bit | null; reaches: boolean } {
  const cands = [stageBit(sel.detail), stageBit(sel.rough)].filter((b): b is Bit => !!b && b.type !== 'vbit')
  const reach = cands.filter((b) => reachDepth(b, holder) >= depth - 1e-6).sort((a, b) => a.diameter - b.diameter)
  if (reach.length) return { bit: reach[0], reaches: true }
  const longest = [...cands].sort((a, b) => reachDepth(b, holder) - reachDepth(a, holder))[0] ?? null
  return { bit: longest, reaches: false }
}

/**
 * Thickest board these bits can fully process, mm: every vertical face's carve and the cut-out
 * through the board must stay within reach. A block thicker than this needs splitting into
 * layers (see layers.ts). Infinity when no straight bit is chosen.
 */
export function layerLimit(sel: StageBits, holder?: number): number {
  const straight = [stageBit(sel.rough), stageBit(sel.detail)].filter((b): b is Bit => !!b && b.type !== 'vbit')
  if (!straight.length) return Infinity
  // The deepest-reaching straight bit both finishes the deepest floor and makes the cut-out.
  return Math.max(...straight.map((b) => reachDepth(b, holder)))
}

export interface MultiSideSettings {
  sides: SideId[]
  bits: StageBits
  /** Material the rough stage leaves for the detail stage, mm. */
  finishAllowance: number
  /** How deep the engraving stage works into the final surface, mm. */
  engraveDepth: number
  stepDown: number
  margin: number
  stockThickness: number
  /** Bit length lost to the collet and spindle, mm (see bits.HOLDER_ALLOWANCE). */
  holderAllowance?: number
  /** Bridges that hold the part in the block after the cut-out. */
  bridges: TabSettings
  outputs: { contour: boolean; toolpath: boolean; pocket: boolean }
  units: Units
  /** Identifies the inputs this plan was made from. */
  key?: string
}

export interface SideResult {
  side: SideId
  label: string
  /** The model in this side's frame (rotate to face up). */
  placed: PlacedModel
  /** Deepest waste column from the model face, mm. */
  cutDepth: number
  /** Stock face → model face distance, mm (the plan top sits this far above the model). */
  faceOffset: number
  /** Total carve depth from the stock face, mm. */
  faceDepth: number
  /** Block extent along this side's axis, mm (stock face to the opposite face). */
  blockDepth: number
  /** True when this side cuts the part out of the block (and leaves the bridges). */
  freeing: boolean
  /** Depth from the stock face the chosen bits fall short of, mm (0 = everything in reach). */
  shortBy: number
  stages: SideStage[]
  plans: CarvePlan[]
  warnings: string[]
}

export interface MultiSidePlan {
  key: string
  sides: SideResult[]
  /** Every side's shapes, laid out side by side (one "sheet" per side). */
  shapes: Omit<Shape, 'id'>[]
  warnings: string[]
  info: Record<string, number | string>
  /** The stock block in the original model frame (mm): model ± margin, stock top on the model top. */
  block: { min: [number, number, number]; max: [number, number, number] } | null
  /** The face analysis the plan was made from. */
  analysis: Record<SideId, SideAnalysis>
  /** Deepest shortfall on a top/bottom face or the cut-out, mm: what layers would fix. */
  verticalShort: number
}

/** Per-side setup facts shared by stage building and planning. */
interface SideSetup {
  side: SideId
  placed: PlacedModel
  analysis: SideAnalysis
  /** Stock face → model face distance in this side's frame (mm). */
  faceOffset: number
  /** z of the stock face in this side's frame: the plan top (mm). */
  top: number
  /** Stock extent along this side's axis, from the stock face to the opposite face (mm). */
  blockDepth: number
  stages: SideStage[]
  /** Deepest model-face depth the stages reach after the reach limits, mm. */
  reached: number
}

/**
 * Union of every stage's depth grid for one side, ascending — the slice pass below runs once
 * over this, and each stage plan then finds its depths already in the shared cache.
 */
function sideGrid(setup: SideSetup, cap: number): number[] {
  const keys = new Set<number>()
  for (const stage of setup.stages) {
    if (stage.role === 'cutout') continue
    const T = Math.min(setup.top, setup.faceOffset + stage.depthTo)
    const n = samplesPerLayer(stage.bit, stage.stepDown, cap)
    for (const d of depthGrid(T, stage.stepDown, n)) keys.add(Math.round(d * 1e6))
  }
  return [...keys].sort((a, b) => a - b)
}

function setupSide(placed: PlacedModel, side: SideId, a: SideAnalysis, st: MultiSideSettings, blockZ: number): SideSetup {
  const S = rotateToSide(placed, side)
  const vertical = side === 'top' || side === 'bottom'
  // The top stock face sits on the model top; stock thicker than the model hangs below it, so
  // the bottom face starts that much below the model bottom. The four side faces keep the
  // block margin above the model face.
  const faceOffset = side === 'top' ? 0 : side === 'bottom' ? Math.max(0, blockZ - placed.size.z) : st.margin
  const built = a.needed
    ? buildStages(a.cutDepth, st.bits, {
        finishAllowance: st.finishAllowance,
        engraveDepth: st.engraveDepth,
        stepDown: st.stepDown,
      })
    : []
  // No stage goes past its bit's reach (Shaper's max depth, Origin's Z travel), counted from the
  // stock face. A stage cut short still does what it can; one with nothing left is dropped.
  const stages: SideStage[] = []
  let reached = 0
  for (const stage of built) {
    const limit = reachDepth(stage.bit, st.holderAllowance) - faceOffset
    const to = Math.min(stage.depthTo, limit)
    if (to - stage.depthFrom < MIN_STAGE) continue
    stages.push({ ...stage, depthTo: to })
    reached = Math.max(reached, to)
  }
  return {
    side,
    placed: S,
    analysis: a,
    faceOffset,
    top: S.size.z + faceOffset,
    blockDepth: vertical ? blockZ : S.size.z + 2 * st.margin,
    stages,
    reached,
  }
}

/** The model's silhouette seen from this setup: union of its sections down the whole model. */
async function silhouette(setup: SideSetup, slicer: ReturnType<typeof createMeshSlicer>, step: number, signal?: AbortSignal): Promise<Contour[]> {
  const H = setup.placed.size.z
  const K = Math.min(200, Math.max(8, Math.ceil(H / Math.min(1, Math.max(step, 0.1)))))
  let out: Contour[] = []
  for (let k = 0; k < K; k++) {
    if (signal?.aborted) throw new CarveCancelled()
    if (k % 8 === 0) await yieldFrame()
    const cs = slicer.slice((H * (k + 0.5)) / K).contours
    if (cs.length) out = out.length ? boolean('union', out, cs) : cs
  }
  return out
}

/** Axis-aligned box in the original model frame (mm). */
interface Box3 {
  min: [number, number, number]
  max: [number, number, number]
}

/**
 * One bridge, in the original model frame: the exact footprint (polygons in model x/y — the
 * piece of cut-out channel at the tab, outside the model) and its bounding box with the bridge
 * height at the far side of the cut-out face.
 */
interface Bridge {
  footprint: [number, number][][]
  box: Box3
}

/**
 * The bridges of the cut-out: at each tab, the part of the cut-out channel (`channel` wide,
 * outside the outline) the bit leaves standing. Only the channel — the part itself is model
 * material anyway, and reserving it would shadow real work under the bridge.
 */
function buildBridges(
  outline: Contour[],
  tabs: Contour[],
  channel: number,
  zFrom: number,
  zTo: number,
  toModel: (x: number, y: number, z: number) => [number, number, number],
): Bridge[] {
  const ring = boolean('difference', offsetContours(outline, channel), outline)
  const out: Bridge[] = []
  for (const t of tabs) {
    if (!t.pts.length) continue
    let x0 = Infinity
    let x1 = -Infinity
    let y0 = Infinity
    let y1 = -Infinity
    for (const p of t.pts) {
      x0 = Math.min(x0, p.x)
      x1 = Math.max(x1, p.x)
      y0 = Math.min(y0, p.y)
      y1 = Math.max(y1, p.y)
    }
    const near: Contour[] = [
      {
        closed: true,
        pts: [
          { x: x0 - channel, y: y0 - channel },
          { x: x1 + channel, y: y0 - channel },
          { x: x1 + channel, y: y1 + channel },
          { x: x0 - channel, y: y1 + channel },
        ],
      },
    ]
    const piece = boolean('intersection', ring, near)
    if (!piece.length) continue
    const zMid = (zFrom + zTo) / 2
    const box: Box3 = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
    // Design space is y-down: the frame's y is −y.
    const footprint = piece.map((c) =>
      c.pts.map((p) => {
        for (const z of [zFrom, zTo]) {
          const q = toModel(p.x, -p.y, z)
          for (let k = 0; k < 3; k++) {
            box.min[k] = Math.min(box.min[k], q[k])
            box.max[k] = Math.max(box.max[k], q[k])
          }
        }
        const q = toModel(p.x, -p.y, zMid)
        return [q[0], q[1]] as [number, number]
      }),
    )
    out.push({ footprint, box })
  }
  return out
}

/**
 * The bridges as keep-out regions of one setup (design space, depths from its stock face). Top
 * and bottom see the exact footprint; a side face sees the bridge's bounding box.
 */
function keepOutFor(setup: SideSetup, bridges: Bridge[], toSide: (x: number, y: number, z: number) => [number, number, number]): KeepOut[] {
  const out: KeepOut[] = []
  const vertical = setup.side === 'top' || setup.side === 'bottom'
  for (const { footprint, box: b } of bridges) {
    const lo = [Infinity, Infinity, Infinity]
    const hi = [-Infinity, -Infinity, -Infinity]
    for (const x of [b.min[0], b.max[0]])
      for (const y of [b.min[1], b.max[1]])
        for (const z of [b.min[2], b.max[2]]) {
          const q = toSide(x, y, z)
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k], q[k])
            hi[k] = Math.max(hi[k], q[k])
          }
        }
    const from = Math.max(0, setup.top - hi[2])
    const to = setup.top - lo[2]
    if (to <= 0) continue
    const zMid = (b.min[2] + b.max[2]) / 2
    const regions: Contour[] = vertical
      ? footprint.map((poly) => ({
          closed: true,
          pts: poly.map(([x, y]) => {
            const q = toSide(x, y, zMid)
            return { x: q[0], y: -q[1] }
          }),
        }))
      : [
          {
            closed: true,
            pts: [
              { x: lo[0], y: -hi[1] },
              { x: hi[0], y: -hi[1] },
              { x: hi[0], y: -lo[1] },
              { x: lo[0], y: -lo[1] },
            ],
          },
        ]
    out.push({ regions, from, to })
  }
  return out
}

/**
 * Build the full multi-sided plan: analyse the faces (unless `analysis` is given), then carve
 * each enabled face in stages and cut the part out. Yields between stages and throws
 * CarveCancelled when `signal` aborts.
 */
export async function buildMultiSidePlan(
  placed: PlacedModel,
  st: MultiSideSettings,
  onProgress?: (fraction: number) => void,
  signal?: AbortSignal,
  analysis: Record<SideId, SideAnalysis> = analyzeSides(placed),
): Promise<MultiSidePlan> {
  const warnings: string[] = []
  const skipped: string[] = []
  const H = placed.size.z
  // The block's vertical extent: the stock, or the model where the stock is thinner.
  const blockZ = Math.max(st.stockThickness, H)
  if (st.stockThickness < H - 0.05)
    warnings.push(`Stock (${fmtLen(st.stockThickness, st.units)}) is thinner than the model (${fmtLen(H, st.units)}) — the plan assumes a block at least as thick as the model.`)

  const setups: SideSetup[] = []
  // Faces the bits cannot reach all the way: the stages stop at their reach, the rest stays.
  let verticalShort = 0
  const shortBy = new Map<SideSetup, number>()
  for (const side of SIDE_ORDER) {
    if (!st.sides.includes(side)) continue
    const s = setupSide(placed, side, analysis[side], st, blockZ)
    if (s.stages.length || side === 'top' || side === 'bottom') setups.push(s)
    if (!s.analysis.needed) continue
    if (!anyStageBit(st.bits)) {
      warnings.push(`${SIDE_LABEL[side]} face has work but no stage bit is chosen — pick a bit for it`)
      continue
    }
    const short = s.analysis.cutDepth - s.reached
    if (short <= 0.05) continue
    shortBy.set(s, short)
    const vert = s.side === 'top' || s.side === 'bottom'
    if (vert) verticalShort = Math.max(verticalShort, short)
    const need = fmtLen(s.faceOffset + s.analysis.cutDepth, st.units)
    const got = fmtLen(s.faceOffset + s.reached, st.units)
    warnings.push(
      vert
        ? `${SIDE_LABEL[s.side]} needs ${need} from the stock face, but your bits reach ${got} (Origin cuts at most ${fmtLen(ORIGIN_MAX_DEPTH, st.units)}) — split the block into layers.`
        : `${SIDE_LABEL[s.side]} needs ${need} from the stock face, but your bits reach ${got}. Layers split the block top to bottom, so they don't shorten a side face — use a smaller margin or a bit that reaches deeper.`,
    )
  }

  // ---- the cut-out: last vertical face with work, else the first enabled one ----------------
  const vertical = setups.filter((s) => s.side === 'top' || s.side === 'bottom')
  const cutSetup = [...vertical].reverse().find((s) => s.stages.length) ?? vertical[0] ?? null
  // Vertical faces without work only stay as the cut-out face.
  for (let i = setups.length - 1; i >= 0; i--) if (!setups[i].stages.length && setups[i] !== cutSetup) setups.splice(i, 1)
  for (const side of SIDE_ORDER)
    if (st.sides.includes(side) && !analysis[side].needed && side !== cutSetup?.side) skipped.push(SIDE_LABEL[side])
  const cut = cutoutBit(st.bits, blockZ, st.holderAllowance)
  if (!cutSetup) warnings.push('Turn on the Top or Bottom face: the part is cut out of the block from one of them.')
  else if (!cut.bit) warnings.push('Pick a straight rough or detail bit: the cut-out needs one.')
  else if (!cut.reaches) {
    verticalShort = Math.max(verticalShort, blockZ - reachDepth(cut.bit, st.holderAllowance))
    warnings.push(
      `The cut-out can't go through the ${fmtLen(blockZ, st.units)} block: ${cut.bit.name} reaches ${fmtLen(reachDepth(cut.bit, st.holderAllowance), st.units)} — split the block into layers.`,
    )
  }
  const cutBit = cutSetup ? cut.bit : null
  // The cut-out goes as deep as its bit reaches; short of the block, a skin keeps the part.
  const cutThrough = cutBit ? Math.min(blockZ, reachDepth(cutBit, st.holderAllowance)) : blockZ
  if (cutSetup && cutBit) {
    cutSetup.stages.push({ role: 'cutout', bit: cutBit, depthFrom: cutSetup.analysis.cutDepth, depthTo: blockZ - cutSetup.faceOffset, stepDown: st.stepDown, leave: 0 })
  }

  const total = setups.reduce((n, s) => n + s.stages.length, 0)
  if (!total) {
    return {
      key: st.key ?? '',
      sides: [],
      shapes: [],
      warnings: warnings.length ? warnings : ['Nothing to carve: every enabled face is flush with the model.'],
      info: { sides: 0, stages: 0, layers: 0 },
      block: null,
      analysis,
      verticalShort,
    }
  }

  const sides: SideResult[] = []
  const shapes: Omit<Shape, 'id'>[] = []
  const info: Record<string, number | string> = { sides: setups.length, stages: total }
  const seenWarnings = new Set<string>()
  let layers = 0
  let sheet = 0
  const pitch = SHEET_PITCH

  // V-bit stages sample their depth densely; capping the per-layer samples keeps the shared
  // grid light at a fraction-of-a-millimetre cost in forbidden-region accuracy.
  const SAMPLE_CAP = 12

  // Work units for progress: one per shared slice, one per stage plan, one for the silhouette.
  const perSide = setups.map((setup) => {
    const slicer = createMeshSlicer(setup.placed.positions)
    const grid = sideGrid(setup, SAMPLE_CAP)
    return { setup, slicer, grid }
  })
  const totalUnits = perSide.reduce((n, s) => n + s.grid.length + s.setup.stages.length, 0) + (cutSetup ? 1 : 0)
  let done = 0

  // ---- bridges, reserved before any setup is planned -----------------------------------------
  let outline: Contour[] = []
  let boxes: Bridge[] = []
  const bridges = st.bridges
  if (cutSetup && cutBit) {
    const cutSlicer = perSide.find((p) => p.setup === cutSetup)!.slicer
    outline = await silhouette(cutSetup, cutSlicer, st.stepDown, signal)
    onProgress?.(++done / totalUnits)
    if (bridges.count > 0 && bridges.width > 0 && bridges.height > 0) {
      const tabs = splitTabs(outline, bridges.count, bridges.width).tabs
      // Far side of the cut-out face, in its frame: the block bottom up by the bridge height.
      const zFloor = cutSetup.top - blockZ
      const { fromSide } = sideFrame(cutSetup.side, placed)
      boxes = buildBridges(outline, tabs, cutBit.diameter + 0.5, zFloor, zFloor + Math.min(bridges.height, blockZ), fromSide)
    }
    if (bridges.count > 0 && st.margin < cutBit.diameter + 2)
      warnings.push(
        `The block margin (${fmtLen(st.margin, st.units)}) is narrower than the cut-out channel (${cutBit.name}): the bridges need a frame to hold on to — use a margin of at least ${fmtLen(cutBit.diameter + 3, st.units)}.`,
      )
  }

  for (const { setup, slicer, grid } of perSide) {
    if (signal?.aborted) throw new CarveCancelled()
    const label = SIDE_LABEL[setup.side]
    const freeing = setup === cutSetup && !!cutBit
    const keepOut = boxes.length ? keepOutFor(setup, boxes, sideFrame(setup.side, placed).toSide) : []
    const warnings2: string[] = []
    const plans: CarvePlan[] = []

    // One slice pass over this side's whole depth grid, shared by every stage: the dominant
    // cost of planning, done once instead of once per bit.
    const shared: Map<number, SliceResult> = new Map()
    for (const key of grid) {
      if (signal?.aborted) throw new CarveCancelled()
      await yieldFrame()
      shared.set(key, slicer.slice(setup.top - Math.max(key / 1e6, 1e-4)))
      onProgress?.(++done / totalUnits)
    }
    const ctx: PlanContext = { slices: shared, sampleCap: SAMPLE_CAP }

    for (let k = 0; k < setup.stages.length; k++) {
      const stage = setup.stages[k]
      const cutout = stage.role === 'cutout'
      // Depths run from the stock face: the model face sits `faceOffset` below it. The cut-out
      // has no layers (it starts at the bottom of the block) — only the through-cut.
      const plan = await buildCarvePlan(
        setup.placed.positions,
        setup.top,
        {
          bit: stage.bit,
          stepDown: stage.stepDown,
          stockThickness: cutout ? setup.blockDepth : setup.faceOffset + stage.depthTo,
          startDepth: cutout ? setup.blockDepth : setup.faceOffset + stage.depthFrom,
          margin: st.margin,
          leave: stage.leave,
          keepOut: cutout ? undefined : keepOut,
          throughCut: cutout,
          throughOutline: cutout ? outline : undefined,
          throughDepth: cutout ? cutThrough : undefined,
          tabs: bridges,
          outputs: st.outputs,
          units: st.units,
          multiSide: true,
          rings: st.outputs.pocket,
          labelPrefix: `${label} · ${STAGE_LABEL[stage.role]}`,
          key: `${st.key ?? ''}|${setup.side}|${k}`,
        },
        (f) => onProgress?.((done + f) / totalUnits),
        signal,
        ctx,
      )
      plans.push(plan)
      layers += plan.layers.length
      for (const w of plan.warnings) {
        const line = `${label} · ${STAGE_LABEL[stage.role]}: ${w}`
        if (!seenWarnings.has(line)) {
          seenWarnings.add(line)
          warnings2.push(line)
        }
      }
      onProgress?.(++done / totalUnits)
    }
    shared.clear()
    if (freeing) {
      const n = bridges.count
      warnings2.push(
        cutThrough < setup.blockDepth - 1e-6
          ? `${label} · Cut out: only ${fmtLen(cutThrough, st.units)} of the ${fmtLen(setup.blockDepth, st.units)} block is in reach — the part stays attached until the block is split into layers.`
          : n > 0
          ? `${label} · Cut out: the outline is cut through the ${fmtLen(setup.blockDepth, st.units)} block — leave the ${n} bridge${n === 1 ? '' : 's'} (${fmtLen(bridges.width, st.units)}) so the part stays seated in the block for the next flip.`
          : `${label} · Cut out: no bridges — the part comes loose at the cut-out${setup !== setups[setups.length - 1] ? ', before the remaining faces are carved' : ''}.`,
      )
    }
    sides.push({
      side: setup.side,
      label,
      placed: setup.placed,
      cutDepth: setup.analysis.needed ? setup.analysis.cutDepth : 0,
      faceOffset: setup.faceOffset,
      faceDepth: setup.faceOffset + (setup.analysis.needed ? setup.analysis.cutDepth : 0),
      blockDepth: setup.blockDepth,
      freeing,
      shortBy: shortBy.get(setup) ?? 0,
      stages: setup.stages,
      plans,
      warnings: warnings2,
    })

    // Each side becomes its own sheet on the canvas, so the setups read like a job packet.
    const xoff = sheet * pitch
    for (const p of plans) for (const s of p.shapes) shapes.push({ ...s, x: s.x + xoff })
    sheet++
  }

  warnings.push(...sides.flatMap((s) => s.warnings))
  if (skipped.length) warnings.push(`Faces with nothing to carve: ${skipped.join(', ')}`)
  info.layers = layers
  info.bridges = cutBit && cutSetup ? bridges.count : 0
  onProgress?.(1)
  const b = placed.bbox
  const block: MultiSidePlan['block'] = {
    min: [b.min.x - st.margin, b.min.y - st.margin, H - blockZ],
    max: [b.max.x + st.margin, b.max.y + st.margin, H],
  }
  return { key: st.key ?? '', sides, shapes, warnings, info, block, analysis, verticalShort }
}

/** Canvas sheet pitch between two sides' shape groups (mm). */
export const SHEET_PITCH = 400
