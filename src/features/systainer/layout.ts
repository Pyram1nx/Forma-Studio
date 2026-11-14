// Systainer insert layout: where each item sits, and the pockets that hold it.
//
// Frame: the Systainer's (mm, x across, y toward the back, z up); the foam's top face is z = 0
// in item terms and an item sinks `depth` below it. A pocket is the item's silhouette below the
// foam surface, grown by the fit clearance. Where an item rests on several levels (a clamp's bolt
// below its lever, a wrench's shaft beside its handle) the pocket steps: each level is its own
// pocket, cut to the depth that level needs.
import * as THREE from 'three'
import type { Contour, Shape, Units } from '../../model/types'
import { shapeFromWorld, fmtLen } from '../../model/factory'
import { boolean, offsetContours, signedArea } from '../../geometry/offset'
import { BITS, type Bit } from '../carve3d/bits'
import { getItem, itemParams, type ItemDef, type PoseStep } from './catalog'
import { baseDepth, insertOutline, lidZ, SYS_FLOOR, sysSpec, type SysSize } from './systainerModel'
import { silhouette } from './silhouette'

export { silhouette }

export interface Placed {
  uid: string
  item: string
  x: number
  y: number
  /** Turn about the up axis, degrees counter-clockwise seen from above. */
  rot: number
  /** Index into the item's poses. */
  pose: number
  /** How deep it sits, mm; null = the pose's default. */
  depth: number | null
  params?: Record<string, number>
  /** Seed for the display-only spin of each roll (items with `randomSpin`); absent: derived from uid. */
  spinSeed?: number
}

export type Fit = 'standard' | 'roomy' | 'loose'
/**
 * Gap added round every pocket, mm per side. Standard is the unmodified outline
 * traced from the source SVG; the other choices deliberately add clearance.
 */
export const FIT_CLEARANCE: Record<Fit, number> = { standard: 0, roomy: 0.75, loose: 1.5 }

export interface Layout {
  size: SysSize
  /** Insert thickness, mm; null = Shaper's stock foam (SHAPER_FOAM). */
  thickness: number | null
  fit: Fit
  /** Flat bit that cuts the insert. */
  bitId: string
  items: Placed[]
}

/** Foam always left under the deepest pocket. */
export const MIN_FLOOR = 4
/** Narrowest foam wall kept against the Systainer. */
const MIN_EDGE = 2
const DEG = Math.PI / 180

export const CUTTING_BITS: Bit[] = BITS.filter((b) => b.type === 'flat')
export const DEFAULT_CUTTING_BIT = (CUTTING_BITS.find((b) => b.inBox && b.diameter > 6) ?? CUTTING_BITS[0]).id

export function defaultLayout(): Layout {
  return { size: 2, thickness: null, fit: 'standard', bitId: DEFAULT_CUTTING_BIT, items: [] }
}

/**
 * The foam insert Shaper ships in its customizable SYS 1, 2 in (50.8 mm): Sam's "Workstation
 * Accessories Kit A" cuts it in a jig of 1/2 in ply on 1.5 in supports, its top flush with the ply,
 * and a 50 mm pocket in it stops "a hair from going through". The ShaperHub depths are cut in it.
 */
export const SHAPER_FOAM = 50.8

/** The thickness that fills a size's base to the rim (whole mm). */
export const fillThickness = (size: SysSize) => Math.floor(baseDepth(size))

/** Insert thickness for a layout: the user's, or Shaper's stock foam. */
export function insertThickness(l: Pick<Layout, 'size' | 'thickness'>): number {
  const max = lidZ(l.size) - SYS_FLOOR
  return Math.min(max, Math.max(10, l.thickness ?? SHAPER_FOAM))
}

// ---------- Posed models ----------

export interface Posed {
  /** The model turned into the pose: centred on x and y, resting on z = 0. Shared: clone to place. */
  object: THREE.Group
  height: number
  /** Footprint size in this pose (x, y). */
  w: number
  d: number
  /** Triangles in the posed frame, 9 floats each. */
  tris: Float32Array
  /** Heights of the faces it rests on (downward faces), lowest first. */
  rests: number[]
  /** Slits narrower than twice this are closed in its pocket outlines (ItemDef.closeGaps). */
  closeGaps?: number
}

const posedCache = new Map<string, Posed>()
const posedKey = (def: ItemDef, pose: number, params: Record<string, number>) => `${def.id}|${pose}|${Object.values(params).join(',')}`

export function posed(def: ItemDef, poseIdx: number, params: Record<string, number> = itemParams(def)): Posed {
  const pose = def.poses[poseIdx] ?? def.poses[0]
  const key = posedKey(def, poseIdx, params)
  const hit = posedCache.get(key)
  if (hit) return hit

  const model = def.build(params)
  const inner = new THREE.Group()
  inner.add(model)
  inner.rotation.set(pose.rot[0] * DEG, pose.rot[1] * DEG, pose.rot[2] * DEG)
  const object = new THREE.Group()
  object.add(inner)
  object.updateMatrixWorld(true)

  const out: number[] = []
  const v = new THREE.Vector3()
  // Deco meshes (a tape roll's printed dominoes and loose end) show, but don't count toward the
  // footprint, so the pocket stays the shape the hub inserts cut.
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh || mesh.userData.deco) return
    const pos = mesh.geometry.getAttribute('position')
    const idx = mesh.geometry.getIndex()
    const n = idx ? idx.count : pos.count
    for (let i = 0; i < n; i++) {
      v.fromBufferAttribute(pos, idx ? idx.getX(i) : i).applyMatrix4(mesh.matrixWorld)
      out.push(v.x, v.y, v.z)
    }
  })
  const box = new THREE.Box3()
  for (let i = 0; i < out.length; i += 3) box.expandByPoint(v.set(out[i], out[i + 1], out[i + 2]))
  const dx = -(box.min.x + box.max.x) / 2
  const dy = -(box.min.y + box.max.y) / 2
  const dz = -box.min.z
  inner.position.set(dx, dy, dz)
  object.updateMatrixWorld(true)
  const tris = new Float32Array(out.length)
  for (let i = 0; i < out.length; i += 3) {
    tris[i] = out[i] + dx
    tris[i + 1] = out[i + 1] + dy
    tris[i + 2] = out[i + 2] + dz
  }

  // Resting levels: heights of faces that point down.
  const rests = new Set<number>([0])
  for (let i = 0; i < tris.length; i += 9) {
    const ax = tris[i + 3] - tris[i]
    const ay = tris[i + 4] - tris[i + 1]
    const az = tris[i + 5] - tris[i + 2]
    const bx = tris[i + 6] - tris[i]
    const by = tris[i + 7] - tris[i + 1]
    const bz = tris[i + 8] - tris[i + 2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.hypot(nx, ny, nz)
    // Either winding: a face is horizontal when its normal is (anti)parallel to z. A face is a
    // rest if the solid is above it; for flat horizontal faces we keep both, the step merge sorts it.
    if (len > 1e-9 && Math.abs(nz) / len > 0.97) rests.add(Math.floor(Math.min(tris[i + 2], tris[i + 5], tris[i + 8]) * 100) / 100)
  }
  const p: Posed = {
    object,
    height: box.max.z - box.min.z,
    w: box.max.x - box.min.x,
    d: box.max.y - box.min.y,
    tris,
    rests: [...rests].sort((a, b) => a - b),
    closeGaps: def.closeGaps,
  }
  posedCache.set(key, p)
  return p
}

// ---------- Silhouettes ----------

export interface Step {
  /** Footprint in the posed frame (before turning and clearance). */
  contours: Contour[]
  /** Pocket depth below the foam surface. */
  depth: number
}

const stepCache = new Map<string, Step[]>()

const area = (cs: Contour[]) => cs.reduce((s, c) => s + signedArea(c.pts), 0)

/**
 * The pocket steps for an item sunk `sink` mm: one per level it rests on below the surface,
 * deepest first, three at most. Levels closer than 2 mm (or 12 % of the sink) merge into the
 * lower one, so a curved underside doesn't become a staircase; merging only makes a pocket deeper.
 */
export function pocketSteps(p: Posed, key: string, sink: number, keepIslands = false): Step[] {
  const k = `${key}|${sink.toFixed(1)}|${keepIslands}`
  const hit = stepCache.get(k)
  if (hit) return hit
  const gap = Math.max(2, sink * 0.12)
  const levels: number[] = []
  for (const r of p.rests) {
    if (r >= sink - 1) break
    if (!levels.length || r - levels[levels.length - 1] >= gap) levels.push(r)
  }
  if (!levels.length) levels.push(0)
  const capped = levels.slice(0, 3)
  const steps: Step[] = []
  let prevArea = 0
  for (let i = 0; i < capped.length; i++) {
    const top = i + 1 < capped.length ? capped[i + 1] - 0.05 : sink
    const sil = silhouette(p.tris, top)
    const g = p.closeGaps
    const contours = shapeHoles(g ? offsetContours(offsetContours(sil, g), -g) : sil, keepIslands)
    const a = Math.abs(area(contours))
    if (!contours.length || a < 0.5) continue
    // Same footprint as the deeper step: nothing new at this level.
    if (steps.length && a - prevArea < Math.max(1, prevArea * 0.01)) continue
    steps.push({ contours, depth: sink - capped[i] })
    prevArea = a
  }
  stepCache.set(k, steps)
  return steps
}

/**
 * A pose's traced Hub pockets (`Pose.pockets`) as steps for an item sunk `sink` mm, deepest first.
 * The shapes stay as the Hub draws them (a shallower one need not contain a deeper one).
 */
function tracedSteps(steps: PoseStep[], sink: number): Step[] {
  return steps
    .map((s) => ({ contours: s.contours, depth: sink - s.level }))
    .filter((s) => s.depth > 0.05)
    .sort((a, b) => b.depth - a.depth)
}

// ---------- Evaluation ----------

export interface Pocket {
  uid: string
  /** Step index, 0 = deepest. */
  step: number
  depth: number
  contours: Contour[]
}

export interface PlacedEval {
  uid: string
  def: ItemDef
  posed: Posed
  /** How deep it actually sits. */
  sink: number
  /** The pose's default depth. */
  autoSink: number
  /** The sinks it may take at this thickness (see depthRange). */
  sinkRange: { min: number; max: number }
  /** How far it stands above the foam (negative: sunk below it, in an insert thicker than the reference). */
  above: number
  /** The most it should stand above the foam (the pose's maxAbove), if the pose sets one. */
  maxAbove?: number
  /** Its pocket may cut right through the insert (the pose's throughCut). */
  throughCut?: boolean
  pockets: Pocket[]
  problems: string[]
}

export interface Evaluation {
  outline: Contour
  thickness: number
  /** Deepest a pocket may go. */
  maxDepth: number
  /** Room between the foam top and the closed lid. */
  lidRoom: number
  /** Foam top, in Systainer z. */
  foamTop: number
  clearance: number
  bit: Bit
  items: PlacedEval[]
  /** All pockets, deepest first within each item. */
  pockets: Pocket[]
}

function transform(cs: Contour[], x: number, y: number, rot: number): Contour[] {
  const c = Math.cos(rot * DEG)
  const s = Math.sin(rot * DEG)
  return cs.map((k) => ({ closed: k.closed, pts: k.pts.map((p) => ({ x: x + p.x * c - p.y * s, y: y + p.x * s + p.y * c })) }))
}

/** Outer boundaries only, or with islands kept when they are big enough to be worth leaving. */
function shapeHoles(cs: Contour[], keepIslands: boolean): Contour[] {
  if (!cs.length) return cs
  const big = cs.reduce((a, b) => (Math.abs(signedArea(b.pts)) > Math.abs(signedArea(a.pts)) ? b : a))
  const outerSign = Math.sign(signedArea(big.pts))
  return cs.filter((c) => {
    const a = signedArea(c.pts)
    if (Math.sign(a) === outerSign) return true
    return keepIslands && Math.abs(a) > 300
  })
}

interface BBox {
  x0: number
  y0: number
  x1: number
  y1: number
}
function bboxOf(cs: Contour[]): BBox {
  const b = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity }
  for (const c of cs)
    for (const p of c.pts) {
      b.x0 = Math.min(b.x0, p.x)
      b.y0 = Math.min(b.y0, p.y)
      b.x1 = Math.max(b.x1, p.x)
      b.y1 = Math.max(b.y1, p.y)
    }
  return b
}
const touch = (a: BBox, b: BBox) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1

/** The outer (shallowest, widest) pocket of an item. */
const outerPocket = (e: PlacedEval) => e.pockets[e.pockets.length - 1]

export function evaluate(layout: Layout): Evaluation {
  const outline = insertOutline()
  const thickness = insertThickness(layout)
  const maxDepth = Math.max(1, thickness - MIN_FLOOR)
  const foamTop = SYS_FLOOR + thickness
  const lidRoom = lidZ(layout.size) - foamTop
  const clearance = FIT_CLEARANCE[layout.fit]
  const bit = CUTTING_BITS.find((b) => b.id === layout.bitId) ?? CUTTING_BITS[0]

  const items: PlacedEval[] = []
  for (const pl of layout.items) {
    const def = getItem(pl.item)
    if (!def) continue
    const params = itemParams(def, pl.params)
    const poseIdx = Math.min(def.poses.length - 1, Math.max(0, pl.pose))
    const p = posed(def, poseIdx, params)
    const pose = def.poses[poseIdx]
    const h = p.height
    // The standard depth is the pose's specified surface offset (a Hub label may sit an item a
    // little below the surface), or flush.
    const base = pose.sink ? pose.sink(h) : h
    // Deepest that makes sense: fully sunk, or the standard depth if that is deeper. At least 1 mm
    // in, so it never ends up wholly above the foam.
    // A through-cut pose may go all the way down to the Systainer floor.
    // A traced Hub pocket may reach below the item (the support arm's post rectangle): keep that within the floor too.
    const below = pose.pockets ? Math.max(0, ...pose.pockets.map((s) => -s.level)) : 0
    const itemMax = (pose.throughCut ? thickness : maxDepth) - below
    const sinkRange = { min: 1, max: Math.max(1, Math.min(itemMax, Math.max(h, base))) }
    const clampSink = (s: number) => Math.min(sinkRange.max, Math.max(sinkRange.min, s))
    // Depths are always measured down from the foam's top face. Changing the insert thickness moves
    // the item and its cutout with that face; it must not silently alter the requested depth.
    const autoSink = def.notch ? 0 : clampSink(base)
    const sink = def.notch ? 0 : pl.depth != null ? clampSink(pl.depth) : autoSink
    const pockets: Pocket[] = def.notch
      ? []
      : (pose.pockets ? tracedSteps(pose.pockets, sink) : pocketSteps(p, posedKey(def, poseIdx, params), sink, !!def.islands)).map((s, i) => ({
          uid: pl.uid,
          step: i,
          depth: s.depth,
          contours: shapeHoles(offsetContours(transform(s.contours, pl.x, pl.y, pl.rot), clearance), !!def.islands),
        }))
    items.push({ uid: pl.uid, def, posed: p, sink, autoSink, sinkRange, above: h - sink, maxAbove: pose.maxAbove, throughCut: pose.throughCut, pockets, problems: [] })
  }

  // Notches take the depth of the deepest pocket they overlap.
  for (const e of items) {
    if (!e.def.notch) continue
    const pl = layout.items.find((x) => x.uid === e.uid)!
    const shape = transform(silhouette(e.posed.tris, Infinity), pl.x, pl.y, pl.rot)
    const bb = bboxOf(shape)
    let deepest = 0
    for (const o of items) {
      if (o.def.notch) continue
      for (const pk of o.pockets) if (pk.depth > deepest && touch(bb, bboxOf(pk.contours)) && Math.abs(area(boolean('intersection', shape, pk.contours))) > 1) deepest = pk.depth
    }
    e.sinkRange = { min: 1, max: maxDepth }
    const clampSink = (s: number) => Math.min(maxDepth, Math.max(1, s))
    const auto = deepest || clampSink(20)
    e.autoSink = auto
    e.sink = pl.depth != null ? clampSink(pl.depth) : auto
    e.above = 0
    e.pockets = [{ uid: e.uid, step: 0, depth: e.sink, contours: shape }]
  }

  // Problems: walls, overlaps, the lid, the cutter.
  const inner = offsetContours([outline], -MIN_EDGE)
  const bitR = bit.diameter / 2
  for (const e of items) {
    const outer = outerPocket(e)
    if (!outer) {
      e.problems.push('Nothing to cut: it sits above the foam.')
      continue
    }
    if (Math.abs(area(boolean('difference', outer.contours, inner))) > 1) e.problems.push('Runs into the Systainer wall.')
    if (e.above > lidRoom + 0.01) e.problems.push(`Stands ${+(e.above - lidRoom).toFixed(1)} mm too tall: the lid won’t close.`)
    const maxAbove = e.maxAbove
    if (maxAbove != null && e.above > maxAbove + 0.5) {
      const want = e.posed.height - maxAbove
      e.problems.push(
        want <= e.sinkRange.max + 0.01
          ? `Stands ${+e.above.toFixed(1)} mm up, more than ${maxAbove} mm: sink it ${+want.toFixed(1)} mm.`
          : `Stands ${+e.above.toFixed(1)} mm up, more than ${maxAbove} mm: it needs a ${+(want + (e.throughCut ? 0 : MIN_FLOOR)).toFixed(1)} mm insert.`,
      )
    }
    if (!e.def.notch && e.pockets.every((pk) => !offsetContours(pk.contours, -bitR + 0.05).length)) e.problems.push(`Too narrow for the ${+bit.diameter.toFixed(2)} mm cutter.`)
  }
  for (let i = 0; i < items.length; i++)
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i]
      const b = items[j]
      // Finger cutouts and slot cutouts are meant to overlap what they serve.
      if (a.def.notch || b.def.notch || a.def.cutout || b.def.cutout) continue
      const pa = outerPocket(a)
      const pb = outerPocket(b)
      if (!pa || !pb || !touch(bboxOf(pa.contours), bboxOf(pb.contours))) continue
      if (Math.abs(area(boolean('intersection', pa.contours, pb.contours))) > 1) {
        const ma = `Overlaps ${b.def.short.toLowerCase()}.`
        const mb = `Overlaps ${a.def.short.toLowerCase()}.`
        if (!a.problems.includes(ma)) a.problems.push(ma)
        if (!b.problems.includes(mb)) b.problems.push(mb)
      }
    }

  return { outline, thickness, maxDepth, lidRoom, foamTop, clearance, bit, items, pockets: items.flatMap((e) => e.pockets) }
}

/** The sinks an item may take at the evaluated thickness, mm: at least 1 mm in, at most fully sunk or the deepest pocket the foam allows. */
export function depthRange(e: PlacedEval, ev: Evaluation): { min: number; max: number } {
  return e.sinkRange ?? { min: 1, max: ev.maxDepth }
}

/**
 * The value to store in `Placed.depth` for an item the user sets to sink `sink` mm at this
 * thickness. Stored depths are always relative to the foam surface.
 */
export function placedDepth(e: PlacedEval, ev: Evaluation, sink: number): number {
  const r = depthRange(e, ev)
  return Math.min(r.max, Math.max(r.min, sink))
}

// ---------- Export ----------

const toCanvas = (cs: Contour[]): Contour[] => cs.map((c) => ({ closed: c.closed, pts: c.pts.map((p) => ({ x: p.x, y: -p.y })) }))

/** Shapes for the editor: the insert outline (cut through) and every pocket at its depth. */
export function insertShapes(ev: Evaluation, layout: Layout, units: Units): Omit<Shape, 'id'>[] {
  const L = (mm: number) => fmtLen(mm, units)
  const bitDia = ev.bit.diameter
  const shapes: Shape[] = [
    shapeFromWorld('path', `Insert outline · ${sysSpec(layout.size).name}`, toCanvas([ev.outline]), {
      cut: { type: 'outside', depth: ev.thickness, offset: 0, bitDia },
      meta: { bitId: ev.bit.id, note: `Cut through the ${L(ev.thickness)} insert. Fits a Festool ${sysSpec(layout.size).name} T-Loc.` },
    }),
  ]
  for (const e of ev.items) {
    const pl = layout.items.find((x) => x.uid === e.uid)
    const pose = e.def.poses[pl?.pose ?? 0] ?? e.def.poses[0]
    e.pockets.forEach((pk, i) => {
      const stepped = e.pockets.length > 1
      shapes.push(
        shapeFromWorld('path', `${e.def.short}${stepped ? ` · step ${i + 1}` : ''} · ${L(pk.depth)}`, toCanvas(pk.contours), {
          cut: { type: 'pocket', depth: +pk.depth.toFixed(2), offset: 0, bitDia },
          meta: { bitId: ev.bit.id, note: `${e.def.name}${e.def.notch ? '' : `, ${pose.label.toLowerCase()}`}. Pocket ${L(pk.depth)} deep.` },
        }),
      )
    })
  }
  return shapes.map(({ id: _id, ...s }) => s)
}
