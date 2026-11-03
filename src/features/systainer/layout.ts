// Systainer insert layout: where each item sits, and the pockets that hold it.
//
// Frame: the Systainer's (mm, x across, y toward the back, z up); the foam's top face is z = 0
// in item terms and an item sinks `depth` below it. A pocket is the item's silhouette below the
// foam surface, grown by the fit clearance. Where an item rests on several levels (a clamp's bolt
// below its lever, a wrench's shaft beside its handle) the pocket steps: each level is its own
// pocket, cut to the depth that level needs.
import * as THREE from 'three'
import type { Contour, Pt, Shape, Units } from '../../model/types'
import { shapeFromWorld, fmtLen } from '../../model/factory'
import { boolean, offsetContours, signedArea, simplify, unionNonZero } from '../../geometry/offset'
import { BITS, type Bit } from '../carve3d/bits'
import { getItem, itemParams, type ItemDef } from './catalog'
import { baseDepth, insertOutline, lidZ, SYS_FLOOR, sysSpec, type SysSize } from './systainerModel'

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
}

export type Fit = 'snug' | 'standard' | 'loose'
/** Gap added round every pocket, mm per side. Foam grips; wood needs room. */
export const FIT_CLEARANCE: Record<Fit, number> = { snug: 0, standard: 0.75, loose: 1.5 }

export interface Layout {
  size: SysSize
  /** Insert thickness, mm; null = fill the base to the rim. */
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

/** Insert thickness for a layout: the user's, or the base depth to the rim (whole mm). */
export function insertThickness(l: Pick<Layout, 'size' | 'thickness'>): number {
  const max = lidZ(l.size) - SYS_FLOOR
  return Math.min(max, Math.max(10, l.thickness ?? Math.floor(baseDepth(l.size))))
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
  model.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
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
  }
  posedCache.set(key, p)
  return p
}

// ---------- Silhouettes ----------

/** Outline, seen from above, of the part of the posed model below height `zMax`. */
export function silhouette(tris: Float32Array, zMax: number): Contour[] {
  const polys: Contour[] = []
  const P: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < tris.length; i += 9) {
    for (let k = 0; k < 3; k++) P[k] = [tris[i + k * 3], tris[i + k * 3 + 1], tris[i + k * 3 + 2]]
    if (P[0][2] >= zMax && P[1][2] >= zMax && P[2][2] >= zMax) continue
    // Clip to z <= zMax (Sutherland–Hodgman against one plane).
    let pts: Pt[]
    if (P[0][2] <= zMax && P[1][2] <= zMax && P[2][2] <= zMax) pts = P.map(([x, y]) => ({ x, y }))
    else {
      pts = []
      for (let k = 0; k < 3; k++) {
        const a = P[k]
        const b = P[(k + 1) % 3]
        const ain = a[2] <= zMax
        const bin = b[2] <= zMax
        if (ain) pts.push({ x: a[0], y: a[1] })
        if (ain !== bin) {
          const t = (zMax - a[2]) / (b[2] - a[2])
          pts.push({ x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]) })
        }
      }
    }
    if (pts.length < 3) continue
    const area = signedArea(pts)
    if (Math.abs(area) < 1e-4) continue
    polys.push({ closed: true, pts: area < 0 ? pts.reverse() : pts })
  }
  return unionNonZero(polys).map((c) => ({ closed: true, pts: simplify(c.pts, 0.05, true) }))
}

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
    const contours = shapeHoles(silhouette(p.tris, top), keepIslands)
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
  /** How far it stands above the foam. */
  above: number
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
    // A pose that only partly sinks (a bit in its shank hole) goes deeper if that's what lets the lid close.
    const autoSink = def.notch ? 0 : pose.sink ? Math.min(p.height, Math.max(pose.sink(p.height), p.height - lidRoom + 1)) : p.height
    const sink = def.notch ? 0 : Math.min(maxDepth, Math.max(1, pl.depth ?? autoSink), p.height)
    const pockets: Pocket[] = def.notch
      ? []
      : pocketSteps(p, posedKey(def, poseIdx, params), sink, !!def.islands).map((s, i) => ({
          uid: pl.uid,
          step: i,
          depth: s.depth,
          contours: shapeHoles(offsetContours(transform(s.contours, pl.x, pl.y, pl.rot), clearance), !!def.islands),
        }))
    items.push({ uid: pl.uid, def, posed: p, sink, autoSink, above: p.height - sink, pockets, problems: [] })
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
    const auto = deepest || Math.min(20, maxDepth)
    e.autoSink = auto
    e.sink = Math.min(maxDepth, Math.max(1, pl.depth ?? auto))
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
