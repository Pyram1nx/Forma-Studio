// The Festool T-Loc Systainer: sizes, the usable cavity (measured from the reference CAD model)
// and the loader for the shipped mesh (public/models/systainer/sys-tloc.bin, built by
// scripts/build-systainer-model.mjs).
//
// Frame (mm): x across the width, y toward the back (hinges; the latch is at −y), z up from the
// bottom of the feet, centred on the outer 396 × 296 footprint.
import * as THREE from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Contour } from '../../model/types'
import { INSERT_OUTLINE } from './hubProfiles'

export type SysSize = 1 | 2 | 3 | 4 | 5

export interface SysSpec {
  size: SysSize
  name: string
  /** Festool's nominal outer height, mm. */
  height: number
  /** How much taller the walls are than SYS1's; the lid assembly rides up by this, mm. */
  stretch: number
}

export const SYS_SIZES: SysSpec[] = [
  { size: 1, name: 'SYS 1', height: 105, stretch: 0 },
  { size: 2, name: 'SYS 2', height: 157.5, stretch: 52.5 },
  { size: 3, name: 'SYS 3', height: 210, stretch: 105 },
  { size: 4, name: 'SYS 4', height: 315, stretch: 210 },
  { size: 5, name: 'SYS 5', height: 420, stretch: 315 },
]
export const sysSpec = (s: SysSize) => SYS_SIZES.find((x) => x.size === s) ?? SYS_SIZES[0]

/** Outer footprint of every T-Loc size. */
export const SYS_OUTER = { w: 396, d: 296 }
/** Top of the floor (its raised centre), where an insert rests. */
export const SYS_FLOOR = 13.8
/** Top of the SYS1 rim. */
const RIM_1 = 80.5
/** Underside of the SYS1 lid's centre rib, the lowest point of the closed lid. */
const LID_1 = 99.2

export const rimZ = (s: SysSize) => RIM_1 + sysSpec(s).stretch
export const lidZ = (s: SysSize) => LID_1 + sysSpec(s).stretch
/** Depth from the floor to the rim: an insert this thick fills the base. */
export const baseDepth = (s: SysSize) => rimZ(s) - SYS_FLOOR

/**
 * The insert outline (closed, y toward the back): the foam outline the ShaperHub T-Loc inserts
 * share, 387.5 × 284 mm, following the cavity's corner bumps, the front chamfers and the low rib at
 * each back corner. Placed on the cavity measured from the reference model, about 1.3 mm clear.
 */
export function insertOutline(): Contour {
  return { closed: true, pts: INSERT_OUTLINE.map((p) => ({ ...p })) }
}

/** The lid: hinge axis (parallel to x), measured on the hinge ears/posts of the reference mesh,
 * so the lid's ears revolve inside the base's two holes; and how far it opens. Past ~100° the
 * lid's back edge would swing into the base's back wall, so it rests just past vertical. */
export const LID_HINGE = { y: 135.3, z: 61.5 }
export const LID_OPEN_DEG = 95

/** The T-Loc turn axis (parallel to y, on the latch front): the whole front block spins about it. */
export const KNOB_AXIS = { x: 0, z: 94.55 }
/** How far the T-Loc block turns from locked (lid shut) to unlocked (lid open), deg — a bit
 * past the mechanism's 100° so the unlocked state visibly reads as open. */
export const KNOB_TURN_DEG = 110
/** Crease angle for the flat/smooth normal split: sharp moulded edges split, fillets shade smooth. */
const CREASE = (35 * Math.PI) / 180

interface Part {
  name: string
  positions: Float32Array
  index: Uint32Array
}

let partsPromise: Promise<Part[]> | null = null

/** Fetch and decode the shipped mesh once. */
export function loadSystainerParts(): Promise<Part[]> {
  partsPromise ??= fetch(`${import.meta.env.BASE_URL}models/systainer/sys-tloc.bin`)
    .then((r) => {
      if (!r.ok) throw new Error(`Systainer model: HTTP ${r.status}`)
      return r.arrayBuffer()
    })
    .then(decode)
  partsPromise.catch(() => (partsPromise = null))
  return partsPromise
}

function decode(buf: ArrayBuffer): Part[] {
  const dv = new DataView(buf)
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'SYSM') throw new Error('Systainer model: bad file')
  let o = 4
  const count = dv.getUint32(o, true)
  o += 4
  const parts: Part[] = []
  for (let k = 0; k < count; k++) {
    const len = dv.getUint8(o++)
    let name = ''
    for (let i = 0; i < len; i++) name += String.fromCharCode(dv.getUint8(o++))
    const vc = dv.getUint32(o, true)
    const ic = dv.getUint32(o + 4, true)
    const scale = dv.getFloat32(o + 8, true)
    o += 12
    const q = new Int16Array(buf.slice(o, o + vc * 6))
    o += vc * 6
    if (o % 4) o += 4 - (o % 4)
    const index = new Uint32Array(buf.slice(o, o + ic * 4))
    o += ic * 4
    const positions = new Float32Array(q.length)
    for (let i = 0; i < q.length; i++) positions[i] = q[i] * scale
    parts.push({ name, positions, index })
  }
  return parts
}

/**
 * The systainer for one size: that size's real base (each ships in the mesh, no stretching) plus
 * the lid assembly latched on its front, which rides up by the size's stretch. The reference mesh
 * is full resolution, so normals come from a plain crease angle: hard edges split, the moulded
 * fillets shade smooth — no noise to hide.
 *
 * The T-Loc lock ships as ONE mesh, `latchTurn`: the whole latch (front block, trim bezel, knob
 * face, shaft and its little back plate — the entire `latch` and `latchCover` parts) merged and
 * pre-offset about the turn axis, which the viewer spins in its pivot group. The reference CAD has
 * every part of the latch coaxial with that axis — the back plate sweeps just r≈7 inside the shaft
 * bore, the rest r≈47 inside the lid's circular pocket — so nothing of the lock stays behind. If
 * you are touching the lock's spin, `latchTurn` is the one mesh to reach for.
 */
export function systainerGeometry(parts: Part[], size: SysSize): { name: string; geometry: THREE.BufferGeometry }[] {
  const dz = sysSpec(size).stretch
  const out: { name: string; geometry: THREE.BufferGeometry }[] = []
  // Indexed, position-only sub-geometries of the T-Loc turn, collected across the latch parts and
  // merged into the single `latchTurn` mesh below.
  const turnSubs: THREE.BufferGeometry[] = []
  for (const p of parts) {
    if (p.name.startsWith('base') && p.name !== `base${size}`) continue
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3))
    geo.setIndex(new THREE.BufferAttribute(p.index, 1))
    if (p.name !== 'latch' && p.name !== 'latchCover') {
      const g = toCreasedNormals(geo, CREASE)
      // The hinge pin is pressed into the base's posts (the lid's ears revolve on it), so it is
      // static — but each size's posts sit higher.
      if (p.name === 'hingePin') g.translate(0, 0, dz)
      out.push({ name: p.name, geometry: g })
      continue
    }
    // The whole lock turns.
    turnSubs.push(geo)
  }
  const merged = mergeGeometries(turnSubs)!
  const g = toCreasedNormals(merged, CREASE)
  // Offset so the turn axis sits at the origin; the viewer's pivot group spins it in place.
  g.translate(0, 0, -KNOB_AXIS.z)
  out.push({ name: 'latchTurn', geometry: g })
  return out
}
