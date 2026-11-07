// What can go into a Systainer insert: Origin and Workstation accessories, the Shaper bits, Trace
// and a few shop tools, each a small procedural 3D model in mm with the orientations it can be
// stored in. Pockets are derived from the models (see layout.ts), so a model only has to be the
// right size and shape.
//
// Sizes: the Workstation parts, collets, wrenches, ShaperTape, the Gen 1 USB stick and the Trace
// frame are traced from community inserts on ShaperHub (hubProfiles.ts), whose depths also set the
// default orientations here. Bits come from the bit catalogue. Anything still estimated is flagged
// `approx`, so the panel can say so.
import * as THREE from 'three'
import type { Contour, Pt } from '../../model/types'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { boolean, splitRegions } from '../../geometry/offset'
import { BITS, type Bit } from '../carve3d/bits'
import {
  ANGLE_FENCE,
  CLAMP_BOLT,
  CLAMP_KNOB,
  CLAMP_LEVER,
  LONG_HEX_HANDLE,
  LONG_HEX_SHAFT,
  OPEN_WRENCH,
  SHORT_HEX_HANDLE,
  SHORT_HEX_SHAFT,
  SUPPORT_ARM,
} from './hubProfiles'
import { boundsOf, box, cyl, extrude, extrudeOutline, faceted, fluted, G, knurled, lathe, M, mat, profile, roundRect, stadium } from './models'

export type CategoryId = 'origin' | 'bits' | 'workstation' | 'trace' | 'shop' | 'basics'

export const CATEGORIES: { id: CategoryId; label: string }[] = [
  { id: 'origin', label: 'Origin' },
  { id: 'bits', label: 'Bits' },
  { id: 'workstation', label: 'Workstation' },
  { id: 'trace', label: 'Trace' },
  { id: 'shop', label: 'Shop' },
  { id: 'basics', label: 'Cutouts' },
]

export interface Pose {
  id: string
  label: string
  /** Rotation from the modelled orientation, degrees about x, y, z (applied in that order). */
  rot: [number, number, number]
  /** How deep it sits by default, from its height in this pose. Absent: its top sits flush. */
  sink?: (height: number) => number
}

export interface ParamDef {
  key: string
  label: string
  def: number
  min: number
  max: number
}

export interface ItemDef {
  id: string
  name: string
  /** Tile caption. */
  short: string
  cats: CategoryId[]
  /** Dimensions estimated rather than measured. */
  approx?: boolean
  note?: string
  poses: Pose[]
  /** Keep foam islands inside the pocket (the window of the Trace frame). */
  islands?: boolean
  /**
   * Each placed copy turns its rolls (groups tagged `userData.spinAxis`) by its own random angle,
   * so prints don't repeat. Display only: the pocket is the unspun model's (see `spinRolls`).
   */
  randomSpin?: boolean
  /** A finger cutout rather than an object: it takes the depth of the pockets it overlaps. */
  notch?: boolean
  /** A shaped cutout (bit slots): drawn as a ghost, and other items may sit in it. */
  cutout?: boolean
  /** Editable sizes (custom shapes). */
  params?: ParamDef[]
  /** Resize handles in the view, per pose id: the params that are the footprint's x and y size. */
  resize?: (pose: string) => ResizeAxes | null
  build: (p: Record<string, number>) => THREE.Object3D
}

/** Which params a footprint corner drag sets: one for both axes (round), or one per axis (posed frame). */
export type ResizeAxes = { round: string } | { x: string; y: string }

/** Lying flat; `sink` is the standard depth where a ShaperHub insert cuts it deeper than the item is thick. */
const flat = (label = 'Flat', sink?: number): Pose => ({ id: 'flat', label, rot: [0, 0, 0], ...(sink != null && { sink: () => sink }) })
const half = (h: number) => h * 0.55
const HUB = 'Size traced from ShaperHub Systainer inserts.'

/** A hex bar (wrench across flats `af`) along +y from 0 to `len`, a flat face down, centred on x and z. */
function hexBar(af: number, len: number): THREE.BufferGeometry {
  const r = af / Math.sqrt(3)
  const s = new THREE.Shape()
  for (let i = 0; i < 6; i++) {
    const a = (i * Math.PI) / 3
    if (i === 0) s.moveTo(r * Math.cos(a), r * Math.sin(a))
    else s.lineTo(r * Math.cos(a), r * Math.sin(a))
  }
  const g = faceted(new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false }))
  g.rotateX(-Math.PI / 2)
  return g
}

/**
 * The tip of a hex bar as a knob, along +y from 0 to `len`: the hex cut by four loop cuts `len/4`
 * apart, with the end cap and the third loop cut scaled down about their own centres (every other
 * ring full width), so the end reads as a knob in the shaft's own facets. Vertex angles match
 * `hexBar`, so the knob and the bar behind it meet without a seam.
 */
function hexKnob(af: number, len: number): THREE.BufferGeometry {
  const r = af / Math.sqrt(3)
  const step = len / 4
  // Tip to shaft: the cap tapers the nose in, loops 1–2 stay full, loop 3 dips into the groove
  // behind the knob, loop 4 is full hex again.
  const rings: [number, number][] = [
    [0, 0.75],
    [step, 1],
    [2 * step, 1],
    [3 * step, 0.9],
    [len, 1],
  ]
  const pos: number[] = [0, 0, 0]
  const idx: number[] = []
  for (const [y, s] of rings)
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3
      pos.push(s * r * Math.cos(a), y, -s * r * Math.sin(a))
    }
  const at = (j: number, i: number) => 1 + 6 * j + (i % 6)
  // The cap, wound to face the tip (-y).
  for (let i = 0; i < 6; i++) idx.push(0, at(0, i + 1), at(0, i))
  // The bands between rings, wound outward.
  for (let j = 0; j + 1 < rings.length; j++)
    for (let i = 0; i < 6; i++) idx.push(at(j, i), at(j, i + 1), at(j + 1, i + 1), at(j, i), at(j + 1, i + 1), at(j + 1, i))
  return faceted(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)).setIndex(idx))
}

// ---------- Origin ----------

/**
 * Origin collet with its nut: a Ø20 × 8 mm nut over an Ø11 × 11 mm nose, 19 mm in all (the hub
 * inserts cut a Ø21 ring 8 mm deep round a Ø12 hole 19 mm deep for it). One model for every bore
 * size: the outsides are the same, and the bore doesn't shape the pocket.
 */
function collet() {
  const rb = 4.2
  return G(
    M(lathe([[rb, 0], [5.1, 0], [5.5, 0.5], [5.5, 11], [rb, 11], [rb, 0]], 40), 'steel'),
    M(lathe([[rb, 11], [9.4, 11], [10, 11.6], [10, 18.4], [9.4, 19], [rb, 19], [rb, 11]], 48), 'steel'),
  )
}

const COLLET_POSES: Pose[] = [
  { id: 'nose-down', label: 'Standing, nose down', rot: [0, 0, 0] },
  { id: 'nose-up', label: 'Standing, nut down', rot: [180, 0, 0] },
  { id: 'lying', label: 'Lying', rot: [90, 0, 0] },
]

/**
 * ShaperTape roll: 19.05 mm (0.75 in) wide, about 79 mm across, on a 1 in core. Lies flat on z = 0.
 * Modelled on the product photos: white paper tape on a white plastic core, a single row of black
 * dominoes with white pips printed down the middle of the tape (white margin each side), so round
 * the rim of the roll they follow the curve and the faces stay plain white. The dominoes are
 * decoration (`deco`), so pockets still derive from the bare roll — the round hub cut.
 */
const TAPE_W = 19.05
const TAPE_R = 39.3
// Domino geometry from the open-source Shaper domino generator (augiev/Shaper-Dominos): a 43 × 12.7
// mm black rectangle with 2.5 mm corner radius, 2 rows × 8 columns of 2.5 mm dots on a 5.08 mm
// pitch, 10 of the 16 dots filled (the four corners always), never symmetric under a half turn,
// 2.25 mm between dominoes.
const DOM_L = 43
const DOM_W = 12.7
const DOM_RAD = 2.5
const DOT_R = 1.25
const DOT_PITCH = 5.08
const DOM_GAP = 2.25
const DOM_N = 5

/** Dot masks: bit i is column i of row 0, bit i + 8 column i of row 1. Seeded, so models are stable. */
function dominoMasks(seed: number, n: number): number[] {
  let st = seed >>> 0
  const rnd = () => ((st = (Math.imul(st, 1664525) + 1013904223) >>> 0) / 4294967296)
  const out: number[] = []
  while (out.length < n) {
    let m = 1 | (1 << 7) | (1 << 8) | (1 << 15)
    while (m.toString(2).split('1').length - 1 < 10) m |= 1 << Math.floor(rnd() * 16)
    let sym = true
    for (let i = 0; i < 16; i++) if (((m >> i) & 1) !== ((m >> (15 - i)) & 1)) sym = false
    if (!sym && !out.includes(m)) out.push(m)
  }
  return out
}

/** Split every triangle of a non-indexed geometry in four, `times` over, so it can bend onto a cylinder. */
function subdivide(g: THREE.BufferGeometry, times: number): THREE.BufferGeometry {
  let pos = Array.from((g.index ? g.toNonIndexed() : g).getAttribute('position').array)
  for (let t = 0; t < times; t++) {
    const next: number[] = []
    for (let i = 0; i < pos.length; i += 9) {
      const v = [0, 1, 2].map((k) => pos.slice(i + k * 3, i + k * 3 + 3))
      const m = [0, 1, 2].map((k) => v[k].map((c, j) => (c + v[(k + 1) % 3][j]) / 2))
      for (const tri of [[v[0], m[0], m[2]], [m[0], v[1], m[1]], [m[2], m[1], v[2]], [m[0], m[1], m[2]]]) next.push(...tri[0], ...tri[1], ...tri[2])
    }
    pos = next
  }
  const out = new THREE.BufferGeometry()
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return out
}

/** Wrap a flat shape (x along the tape, y across it) onto the roll's rim at radius `r`, starting at angle `a0`. */
function wrapOnRim(g: THREE.BufferGeometry, r: number, a0: number, zc: number): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  for (let i = 0; i < p.count; i++) {
    const th = a0 + (p.getX(i) + DOM_L / 2) / TAPE_R
    p.setXYZ(i, Math.cos(th) * r, Math.sin(th) * r, zc + p.getY(i))
  }
  g.computeVertexNormals()
  return g
}

function tapeRollParts(z = 0, seed = 7): THREE.Object3D[] {
  const deco = (m: THREE.Mesh): THREE.Mesh => {
    m.userData.deco = true
    return m
  }
  const parts: THREE.Object3D[] = [
    M(lathe([[12.7, z], [15.5, z], [15.5, z + TAPE_W], [12.7, z + TAPE_W], [12.7, z]]), 'rollcore'),
    M(lathe([[15.5, z + 0.05], [TAPE_R, z + 0.05], [TAPE_R, z + TAPE_W - 0.05], [15.5, z + TAPE_W - 0.05], [15.5, z + 0.05]], 96), 'paper'),
  ]
  const zc = z + TAPE_W / 2
  const pitch = (DOM_L + DOM_GAP) / TAPE_R
  const body = subdivide(new THREE.ShapeGeometry(roundRect(DOM_L, DOM_W, DOM_RAD), 8), 4)
  const dot = new THREE.CircleGeometry(DOT_R, 20)
  const bodies: THREE.BufferGeometry[] = []
  const dots: THREE.BufferGeometry[] = []
  dominoMasks(seed, DOM_N).forEach((mask, i) => {
    const a0 = i * pitch
    bodies.push(wrapOnRim(body.clone(), TAPE_R + 0.12, a0, zc))
    for (let k = 0; k < 16; k++) {
      if (!((mask >> k) & 1)) continue
      const x = ((k % 8) - 3.5) * DOT_PITCH
      const y = (k < 8 ? 0.5 : -0.5) * DOT_PITCH
      const d = dot.clone()
      d.translate(x, y, 0)
      dots.push(wrapOnRim(d, TAPE_R + 0.24, a0, zc))
    }
  })
  parts.push(deco(new THREE.Mesh(mergeGeometries(bodies)!, mat('domino'))))
  parts.push(deco(new THREE.Mesh(mergeGeometries(dots)!, mat('paper'))))
  // One group per roll, its axis through the group's origin: the viewer spins it there (spinRolls).
  const roll = G(...parts)
  roll.userData.spinAxis = [0, 0, 1]
  return [roll]
}

/**
 * Turn every roll in a placed copy (a clone of the posed object, never the cached original) about
 * its own axis by an angle drawn from `seed`, a different one per roll. Round rolls with `deco`
 * prints keep their footprint, so the pocket (from the unspun model) doesn't change.
 */
export function spinRolls(obj: THREE.Object3D, seed: number): void {
  let i = 0
  const axis = new THREE.Vector3()
  obj.traverse((o) => {
    const a = o.userData.spinAxis as number[] | undefined
    if (!a) return
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(++i, 0x85ebca6b)) >>> 0
    h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0
    h = (h ^ (h >>> 12)) >>> 0
    o.rotateOnAxis(axis.fromArray(a).normalize(), (h / 4294967296) * Math.PI * 2)
  })
}

/** A seed from a uid, for saved layouts from before `spinSeed`. */
export const uidSeed = (uid: string): number => {
  let h = 2166136261
  for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 16777619)
  return h >>> 0
}

/**
 * The Gen 1 USB stick from LeoTurlock's SYS 3 insert: a 42 × 12 × 4.5 mm stick with a fully
 * rounded body end and a square connector end. The 4.5 mm source label is its pocket depth.
 */
function usbGen1() {
  const body = M(extrude(roundRect(30, 12, 6), 4.5, 0.6), 'grey', -6)
  const connector = M(box(12, 12, 4.5), 'steel', 15)
  return G(body, connector)
}

/** A USB stick: body plus plug, lying along x. */
function usb(len: number, w: number, t: number, plug: { l: number; w: number; t: number }, body: 'white' | 'black') {
  return () => G(M(extrude(roundRect(len, w, Math.min(4, w / 3)), t, 0.8), body, -plug.l / 2), M(box(plug.l, plug.w, plug.t), 'steel', len / 2, 0, (t - plug.t) / 2))
}

function dustAdapter() {
  return G(M(lathe([[15.5, 0], [18, 0], [18, 34], [14, 48], [14, 78], [11.5, 78], [11.5, 48], [15.5, 34], [15.5, 0]], 48), 'black'))
}

/** Origin's open-end collet wrench (ShaperHub "profile type A"), 6.5 mm thick. */
function colletWrench() {
  return G(M(extrudeOutline(profile(OPEN_WRENCH, 0), 6.5, 0.5), 'steel'))
}

// ---------- Workstation ----------

/**
 * Support Arm, from its traced lying outline (unchanged): a matte black anodised bar, with the two
 * steel pegs that hook onto the Body, styled on the shop photo (workstation_support_arms). The larger
 * lobe of the outline is the socket-cap screw (flanged head, hex socket), the smaller a plain dowel.
 * Pegs run along −x from the post's face and keep their lobe's width, so the footprint is the outline.
 */
function supportArm() {
  const t = 12.5
  const all = profile(SUPPORT_ARM, 0)
  const pegX = boundsOf(all).x0 + 10.3
  const parts: THREE.Object3D[] = [M(extrudeOutline(profile(SUPPORT_ARM, 0, { minX: pegX }), t, 0.8), 'anodized')]
  const lobes = splitRegions(profile(SUPPORT_ARM, 0, { maxX: pegX + 0.01 }))
    .map(boundsOf)
    .filter((b) => b.w >= 1 && b.h >= 1)
    .sort((p, q) => q.h - p.h)
  lobes.forEach((b, i) => {
    const r = Math.min(b.h / 2, t / 2)
    const len = b.w + 1
    const x0 = pegX + 1
    if (i === 0) {
      // Socket-cap screw: flange at the post, a fine groove, then the head with its hex socket.
      const screw = lathe(
        [[0, 0], [r, 0], [r, 3], [r * 0.9, 3], [r * 0.9, 3.6], [r, 3.6], [r, len - 0.7], [r - 0.7, len], [0, len]],
        40,
      )
      parts.push(M(screw, 'steel', x0, b.cy, t / 2, 0, -90))
      parts.push(M(hexBar(Math.min(5, r * 0.8), 2.4), 'black', x0 - len - 0.03, b.cy, t / 2, 0, 0, -90))
    } else {
      // Plain dowel with a chamfered end.
      const dowel = lathe([[0, 0], [r, 0], [r, len - 0.8], [r - 0.8, len], [0, len]], 40)
      parts.push(M(dowel, 'steel', x0, b.cy, t / 2, 0, -90))
    }
  })
  return G(...parts)
}

/** A closed circle outline. */
function circleContour(cx: number, cy: number, r: number, n = 36): Contour {
  return { closed: true, pts: Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos((i / n) * Math.PI * 2), y: cy + r * Math.sin((i / n) * Math.PI * 2) })) }
}

/** A slot of width `w` following the circular arc through three points, with round ends. */
function arcSlot(a: Pt, m: Pt, b: Pt, w: number, n = 24): Contour {
  const d = 2 * (a.x * (m.y - b.y) + m.x * (b.y - a.y) + b.x * (a.y - m.y))
  const ux = ((a.x ** 2 + a.y ** 2) * (m.y - b.y) + (m.x ** 2 + m.y ** 2) * (b.y - a.y) + (b.x ** 2 + b.y ** 2) * (a.y - m.y)) / d
  const uy = ((a.x ** 2 + a.y ** 2) * (b.x - m.x) + (m.x ** 2 + m.y ** 2) * (a.x - b.x) + (b.x ** 2 + b.y ** 2) * (m.x - a.x)) / d
  const R = Math.hypot(a.x - ux, a.y - uy)
  const t0 = Math.atan2(a.y - uy, a.x - ux)
  const mod = (v: number) => ((v % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2)
  const toB = mod(Math.atan2(b.y - uy, b.x - ux) - t0)
  const toM = mod(Math.atan2(m.y - uy, m.x - ux) - t0)
  // Counter-clockwise if m lies on the way from a to b that way round, else clockwise.
  const dir = toM < toB ? 1 : -1
  const t1 = t0 + dir * (dir === 1 ? toB : Math.PI * 2 - toB)
  const at = (t: number, r: number): Pt => ({ x: ux + r * Math.cos(t), y: uy + r * Math.sin(t) })
  const out: Pt[] = []
  for (let i = 0; i <= n; i++) out.push(at(t0 + ((t1 - t0) * i) / n, R + w / 2))
  // Round end at b (outer side round to inner), back along the inside, then round end at a.
  const end = (t: number, start: number) => {
    const c = at(t, R)
    for (let i = 1; i < 12; i++) {
      const ang = start + dir * (Math.PI * i) / 12
      out.push({ x: c.x + (w / 2) * Math.cos(ang), y: c.y + (w / 2) * Math.sin(ang) })
    }
  }
  end(t1, t1)
  for (let i = n; i >= 0; i--) out.push(at(t0 + ((t1 - t0) * i) / n, R - w / 2))
  end(t0, t0 + Math.PI)
  return { closed: true, pts: out }
}

/** A rounded notch cut into a visual plate edge, without changing its pocket outline. */
function notchContour(x0: number, x1: number, yd: number, edge: number, r: number, rf: number, n = 8): Contour {
  const pts: Pt[] = [{ x: x0 - rf, y: edge + 2 }, { x: x0 - rf, y: edge }]
  const arc = (cx: number, cy: number, rad: number, from: number, to: number) => {
    for (let i = 1; i <= n; i++) {
      const a = from + ((to - from) * i) / n
      pts.push({ x: cx + rad * Math.cos(a), y: cy + rad * Math.sin(a) })
    }
  }
  arc(x0 - rf, edge - rf, rf, Math.PI / 2, 0)
  pts.push({ x: x0, y: yd + r })
  arc(x0 + r, yd + r, r, Math.PI, (Math.PI * 3) / 2)
  pts.push({ x: x1 - r, y: yd })
  arc(x1 - r, yd + r, r, (Math.PI * 3) / 2, Math.PI * 2)
  pts.push({ x: x1, y: edge - rf })
  arc(x1 + rf, edge - rf, rf, Math.PI, Math.PI / 2)
  pts.push({ x: x1 + rf, y: edge + 2 })
  return { closed: true, pts }
}

/**
 * Angle Fence (white anodised), lying flat, on its traced SVG outline. The 3D plate keeps its
 * rounded side notch, while an invisible source-outline solid remains authoritative for the pocket.
 */
function angleFence() {
  const outline = profile(ANGLE_FENCE, 0)
  const visualCuts: Contour[] = [
    circleContour(50.2, -13.4, 4),
    arcSlot({ x: 22.6, y: 10.4 }, { x: 18.9, y: -9.1 }, { x: 15.3, y: -16.2 }, 7),
    notchContour(-34.8, -24.7, -14.8, -4.01, 2.2, 1.2),
  ]
  // White faces, very dark brown-black sides and bevel (extrude groups: 0 = faces, 1 = sides + bevel).
  const plate = new THREE.Mesh(extrudeOutline(boolean('difference', outline, visualCuts), 9.5, 0.8), [mat('white'), mat('edgeblack')])
  // The small black dot printed on the bulge, just under where the knob sits (decoration: not in the pocket).
  const dot = M(cyl(0.65, 0.65, 0.06, 20), 'edgeblack', 16.4, 15.3, 9.47)
  dot.userData.deco = true
  // The full source outline is hidden in 3D but included in silhouettes, SVG export and foam booleans.
  return G(plate, dot, footprint(outline, 0, 9.5))
}

/** The Angle Fence's Lock Screw: knurled Ø18 × 13 head on a Ø7 × 15 screw (the hub's 13 / 28 mm pockets). */
function lockScrew() {
  return G(M(cyl(3.5, 3.5, 15.2, 24), 'steel'), M(faceted(knurled(9, 13)), 'knob', 0, 0, 15))
}

/** A big polygon covering one side of the line through `p` along `dir`, for clipping a part off a profile. */
function halfPlane(p: Pt, dir: Pt, side: Pt): Contour {
  const L = 400
  const dl = Math.hypot(dir.x, dir.y)
  const sl = Math.hypot(side.x, side.y)
  const d = { x: dir.x / dl, y: dir.y / dl }
  const n = { x: side.x / sl, y: side.y / sl }
  const at = (a: number, b: number): Pt => ({ x: p.x + d.x * a + n.x * b, y: p.y + d.y * a + n.y * b })
  return { closed: true, pts: [at(-L, 0), at(L, 0), at(L, L), at(-L, L)] }
}

/**
 * An invisible solid that still counts towards the pocket: the part of the Hub outline that holds no
 * visible geometry (the T-bolt channel, the knob's square), so the pockets follow the traced SVG
 * exactly. Pose rotation, silhouettes and rest levels see it; the viewer does not draw it.
 */
function footprint(cs: Contour[], z0: number, z1: number): THREE.Mesh {
  return M(extrudeOutline(cs, z1 - z0, 0), 'hidden', 0, 0, z0)
}

/**
 * Hold Down Clamp, stored as in the ShaperHub clamp pockets (hubProfiles.ts) and styled on the shop
 * photo (workstation_holddown_clamps), measured at 1.9 px/mm from its 147.2 mm lever: the curved lever
 * (black faces, steel edges) with its two rubber end pads, the T-bolt through its crown (T-head on the
 * concave side), and the knob on the bolt's own axis, lying down: a Ø22 × 18 sleeve on the thread, then
 * the Ø47 × 18 scalloped cap with its screw. Lever and knob share the bolt axis (z = 23.5), so the knob
 * stands 47 tall: the pose sinks it 32.65 mm, which makes the lever pocket 20 mm deep (as the Hub labels
 * it: the sleeve's underside, 12.65, is the pocket floor) and leaves the knob about 14 mm above the foam,
 * inside the 19 mm of lid room.
 */
/** The bolt's axis height: half the cap's diameter, so the knob's lowest point is the floor. */
const CLAMP_AXIS = 23.65
const CLAMP_SINK = 28

function holdDownClamp() {
  const t = 18
  const R = CLAMP_AXIS
  // The source SVG has a 28 mm knob cutout and 20 mm bolt / lever cutouts.
  // Their physical solids are decorative; these z levels make the SVG outlines authoritative for
  // the pockets and their boolean in the foam.
  const z0 = 8
  const lever = profile(CLAMP_LEVER, 0)
  // The pads are the rubber caps over the lever's two ends; cut where the outline steps down to the bar.
  const leftCut = halfPlane({ x: -44.45, y: 5.6 }, { x: 0.28, y: 1 }, { x: -1, y: 0.28 })
  const rightCut = halfPlane({ x: 44.55, y: -1.4 }, { x: -0.33, y: 1 }, { x: 1, y: 0.33 })
  const bar = boolean('difference', lever, [leftCut, rightCut])
  const padL = boolean('intersection', lever, [leftCut])
  const padR = boolean('intersection', lever, [rightCut])
  const bolt = boundsOf(profile(CLAMP_BOLT, 0))
  const knob = boundsOf(profile(CLAMP_KNOB, 0))
  const bx = bolt.cx
  // Faces black, edges steel (extrude groups 0 and 1).
  const barMesh = new THREE.Mesh(extrudeOutline(bar, t, 0.8), [mat('anodized'), mat('steel')])
  barMesh.position.z = z0
  // Along the bolt, away from the lever: thread, sleeve, cap, screw (y decreasing).
  const headY = bolt.y1 - 2.5
  const sleeveTop = knob.y1 - 0.2
  const sleeveLen = 18
  const capLen = 18.4
  const shaftEnd = sleeveTop - sleeveLen * 0.6
  const capEnd = sleeveTop - sleeveLen - capLen
  const cap = new THREE.Shape()
  for (let i = 0; i <= 140; i++) {
    const a = (i / 140) * Math.PI * 2
    const r = CLAMP_AXIS * (0.95 + 0.05 * Math.cos(a * 7))
    if (i === 0) cap.moveTo(r, 0)
    else cap.lineTo(r * Math.cos(a), r * Math.sin(a))
  }
  return G(
    barMesh,
    M(extrudeOutline(padL, t, 2.2), 'knob', 0, 0, z0),
    M(extrudeOutline(padR, t, 2.2), 'knob', 0, 0, z0),
    // Bolt: shaft from the T-head right into the sleeve.
    M(cyl(4, 4, headY - shaftEnd, 32), 'steel', bx, shaftEnd, R, -90),
    M(box(22, 5, 12), 'steel', bx, headY, R - 6),
    // Knob, lying down on the bolt's axis.
    M(cyl(11, 11, sleeveLen, 40), 'knob', bx, sleeveTop - sleeveLen, R, -90),
    M(extrude(cap, capLen, 3, 4), 'knob', bx, capEnd, R, -90),
    M(cyl(4.5, 4.5, 1.2, 24), 'steel', bx, capEnd - 1.2, R, -90),
    // Symmetric about the bolt's axis, so the flipped pose gets the same pockets.
    footprint(lever, 8, 26),
    footprint(profile(CLAMP_BOLT, 0), 8, 2 * R - 8),
    footprint(profile(CLAMP_KNOB, 0), 0, 2 * R),
  )
}

/** A T-handle hex key lying flat: handle outline `t` thick, a 4 mm hex shaft through its middle. */
function tHexKey(handle: typeof LONG_HEX_HANDLE, t: number, y0: number, y1: number) {
  return () => G(M(extrudeOutline(profile(handle, 0), t, 0.8), 'knob'), M(hexBar(4, y1 - y0), 'steel', 0, y0, t / 2))
}

/** Lowest and highest y where the vertical line at `x` crosses the closed outline `pts`. */
function spanAt(pts: Pt[], x: number): [number, number] {
  let lo = Infinity
  let hi = -Infinity
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % pts.length]
    if ((a.x - x) * (b.x - x) > 0 || a.x === b.x) continue
    const y = a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x)
    lo = Math.min(lo, y)
    hi = Math.max(hi, y)
  }
  return [lo, hi]
}

/**
 * A bar whose plan view is `pts` (a simple outline, x-monotone sections) and whose every cross-section
 * is an ellipse: as wide as the outline is at that x, `t` tall, lying on z = 0. So the long sides
 * come out fully round while the ends stay flat caps at the outline's end edges. `edges` may replace
 * the outline's [lo, hi] at some x (a smooth run where the outline has a kink or a neck).
 */
function roundedBar(pts: Pt[], t: number, edges?: (x: number) => [number, number] | null, S = 28): THREE.BufferGeometry {
  const xmax = Math.max(...pts.map((p) => Math.abs(p.x))) - 0.03
  const span = (x: number): [number, number] => edges?.(x) ?? spanAt(pts, x)
  const steps = Math.ceil((2 * xmax) / 0.25)
  const pos: number[] = []
  const idx: number[] = []
  const ring = (x: number) => {
    const [lo, hi] = span(x)
    const yc = (lo + hi) / 2
    const hw = (hi - lo) / 2
    // Corners that taper to the end edge get a proportionally lower section.
    const zr = (t / 2) * Math.min(1, hw / 6)
    for (let i = 0; i < S; i++) {
      const a = (i / S) * Math.PI * 2
      pos.push(x, yc + hw * Math.cos(a), t / 2 + zr * Math.sin(a))
    }
    return { yc, zc: t / 2 }
  }
  const ends: { x: number; yc: number }[] = []
  for (let j = 0; j <= steps; j++) {
    const x = -xmax + (2 * xmax * j) / steps
    const r = ring(x)
    if (j === 0 || j === steps) ends.push({ x, yc: r.yc })
    if (j === 0) continue
    const a = (j - 1) * S
    const b = j * S
    for (let i = 0; i < S; i++) {
      const i2 = (i + 1) % S
      idx.push(a + i, b + i2, b + i, a + i, a + i2, b + i2)
    }
  }
  // Flat end caps, each with its own vertices so the face stays flat.
  for (const [k, e] of ends.entries()) {
    const j = k === 0 ? 0 : steps
    const c = pos.length / 3
    for (let i = 0; i < S; i++) pos.push(pos[(j * S + i) * 3], pos[(j * S + i) * 3 + 1], pos[(j * S + i) * 3 + 2])
    pos.push(e.x, e.yc, t / 2)
    for (let i = 0; i < S; i++) {
      const i2 = (i + 1) % S
      if (k === 0) idx.push(c + S, c + i2, c + i)
      else idx.push(c + S, c + i, c + i2)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  return g
}

/**
 * White print on the Shaper key's handle, as a flat decal on a strip that follows the bend (`drop`: how
 * far the handle's centreline falls at x): the
 * "SHΔPER" mark (the A is a bare triangle) centred over the bend, "4.0 MM" and "HEX 4.0" out on
 * either arm. Reads left to right with the shaft pointing down. A texture, so it's `deco`.
 */
function keyPrint(yA: number, drop: (x: number) => number, z: number): THREE.Object3D | null {
  if (typeof document === 'undefined') return null
  const PX = 32
  const W = 56
  const Hh = 6
  const c = document.createElement('canvas')
  c.width = W * PX
  c.height = Hh * PX
  const g = c.getContext('2d')
  if (!g) return null
  g.fillStyle = '#e9e8e3'
  g.strokeStyle = '#e9e8e3'
  g.textAlign = 'center'
  g.textBaseline = 'alphabetic'
  const cx = (x: number) => (W / 2 + x) * PX
  const base = (Hh / 2) * PX
  const glyphs = (txt: string, x0: number, adv: number, cap: number, weight: number) => {
    g.font = `${weight} ${cap * PX * 1.4}px "Helvetica Neue", Helvetica, Arial, sans-serif`
    g.lineWidth = Math.max(1.5, cap * PX * 0.09)
    const n = txt.length
    for (let i = 0; i < n; i++) {
      const x = cx(x0 + (i - (n - 1) / 2) * adv)
      const ch = txt[i]
      if (ch === 'Δ') {
        const w = cap * PX * 0.78
        g.beginPath()
        g.moveTo(x - w / 2, base + (cap * PX) / 2)
        g.lineTo(x, base - (cap * PX) / 2)
        g.lineTo(x + w / 2, base + (cap * PX) / 2)
        g.closePath()
        g.stroke()
      } else g.fillText(ch, x, base + (cap * PX) / 2)
    }
  }
  glyphs('SHΔPER', 0, 4.7, 3.4, 300)
  glyphs('4.0 MM', -20.5, 1.75, 1.5, 400)
  glyphs('HEX 4.0', 20.5, 1.75, 1.5, 400)
  const tex = new THREE.CanvasTexture(c)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.anisotropy = 8
  const geo = new THREE.PlaneGeometry(W, Hh, 56, 1)
  const p = geo.getAttribute('position')
  for (let i = 0; i < p.count; i++) p.setY(i, p.getY(i) - drop(p.getX(i)))
  geo.computeVertexNormals()
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }),
  )
  m.position.set(0, yA, z)
  m.userData.deco = true
  return m
}

/**
 * A sleeve of radius `r` on an axis along y (at x = 0, z = `zc`), from `y0` (a small chamfered end) up
 * into a handle, grown into it by a rolling fillet: in each half-plane through the axis a circle touches
 * both the sleeve and the handle's underside, and the arc between the two is the fillet. Its radius is
 * `fx` in plan (along x), easing to `fz` over the top and bottom, where the handle's flank is steep.
 * `under(x, dz)` is the handle's lowest y at (x, z = zc + dz), or null where the handle doesn't reach.
 * One smooth mesh, open at its top edge, which ends just inside the handle.
 */
function filletedSleeve(r: number, fx: number, fz: number, y0: number, zc: number, under: (x: number, dz: number) => number | null, seg = 64): THREE.BufferGeometry {
  const ARC = 14
  const rows: [number, number][][] = []
  for (let i = 0; i < seg; i++) {
    const th = (i / seg) * Math.PI * 2
    const ux = Math.sin(th)
    const uz = -Math.cos(th)
    const f = fz + (fx - fz) * Math.abs(ux)
    // The handle's underside in this half-plane, as (distance from the axis, y).
    // Sampled finely in y too: where the half-plane grazes the handle's flank the curve runs steep.
    const curve: [number, number][] = []
    const at = (d: number) => under(d * ux, d * uz)
    const fill = (d0: number, y0: number, d1: number, y1: number, depth: number) => {
      if (depth > 0 && Math.abs(y1 - y0) > 0.01) {
        const dm = (d0 + d1) / 2
        const ym = at(dm)
        if (ym != null) {
          fill(d0, y0, dm, ym, depth - 1)
          fill(dm, ym, d1, y1, depth - 1)
          return
        }
      }
      curve.push([d1, y1])
    }
    let prev: [number, number] | null = null
    for (let d = r; d <= r + 2 * f + 0.5; d += 0.02) {
      const y = at(d)
      if (y == null) break
      if (prev) fill(prev[0], prev[1], d, y, 14)
      else curve.push([d, y])
      prev = [d, y]
    }
    // Close in on where the handle ends in this half-plane (its flank turns vertical there).
    if (prev) {
      let a = prev[0]
      let b = prev[0] + 0.02
      for (let k = 0; k < 30; k++) {
        const m = (a + b) / 2
        if (at(m) == null) b = m
        else a = m
      }
      const ya = at(a)
      if (ya != null) fill(prev[0], prev[1], a, ya, 14)
    }
    const cr = r + f
    let best: [number, number] = curve[0]
    const nearest = (cy: number) => {
      let m = Infinity
      for (const p of curve) {
        const q = Math.hypot(p[0] - cr, p[1] - cy)
        if (q < m) {
          m = q
          best = p
        }
      }
      return m
    }
    // Slide the circle's centre up the sleeve until it touches the handle.
    let lo = Math.min(...curve.map((p) => p[1])) - 2 * f
    let hi = Math.max(...curve.map((p) => p[1]))
    for (let k = 0; k < 48; k++) {
      const mid = (lo + hi) / 2
      if (nearest(mid) > f) lo = mid
      else hi = mid
    }
    const cy = lo
    nearest(cy)
    const [tx, ty] = best
    const a1 = Math.atan2(ty - cy, tx - cr)
    const row: [number, number][] = [[0, y0], [r - 1.4, y0], [r - 0.5, y0 + 0.35], [r, y0 + 1], [r, (y0 + 1 + cy) / 2]]
    for (let k = 0; k <= ARC; k++) {
      const a = Math.PI + ((a1 - Math.PI) * k) / ARC
      row.push([cr + f * Math.cos(a), cy + f * Math.sin(a)])
    }
    // On past the touch point along the fillet's tangent, dipping just under the handle's surface,
    // so no gap shows against its facets.
    row.push([tx + 0.4 * Math.sin(a1) + 0.12 * Math.cos(a1), ty - 0.4 * Math.cos(a1) + 0.12 * Math.sin(a1)])
    rows.push(row)
  }
  const pos: number[] = []
  rows.forEach((row, i) => {
    const th = (i / seg) * Math.PI * 2
    for (const [d, y] of row) pos.push(d * Math.sin(th), y, zc - d * Math.cos(th))
  })
  const J = rows[0].length
  const idx: number[] = []
  for (let i = 0; i < seg; i++) {
    const a = i * J
    const b = ((i + 1) % seg) * J
    for (let j = 0; j < J - 1; j++) idx.push(a + j, a + j + 1, b + j + 1, a + j, b + j + 1, b + j)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  g.setIndex(idx)
  g.computeVertexNormals()
  // The tucked-in end shades as the fillet's edge does, so it doesn't draw a line.
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute // computeVertexNormals makes a plain attribute
  for (let i = 0; i < seg; i++) nrm.copyAt(i * J + J - 1, nrm, i * J + J - 2)
  return g
}

/**
 * The Workstation's 4 mm T-handle hex key, styled on the Shaper shop photo (workstation_wrench): a
 * glossy black handle 10 mm thick with a round (elliptical) section, a glossy sleeve on the shaft that
 * flows into the handle through a rounded fillet, the 4 mm hex ending in a loop-cut knob (`hexKnob`),
 * and "SHΔPER" printed
 * on the handle. The handle follows the traced outline (LONG_HEX_HANDLE) along its straight arms and
 * ends; through the middle it bends smoothly instead of the outline's V, and the neck is the sleeve and
 * its fillet (which land on the outline's own fillet). The traced outline itself is a hidden footprint,
 * so the pocket is the SVG path unchanged. Lies flat with its axis at mid-handle height.
 */
function shaperHexKey() {
  const t = 10
  const H = t / 2
  const tip = LONG_HEX_SHAFT.tip
  const outline = profile(LONG_HEX_HANDLE, 0)
  const pts = outline.reduce((m, c) => (c.pts.length > m.pts.length ? c : m)).pts
  // The arms' straight edges, measured on the outline either side of the neck: both fall at slope k
  // away from the middle. Through |x| < BEND the |x| of the V becomes a parabola, so the handle bends
  // smoothly (no crease over the middle, no bump where the trace has one).
  const [l14, h14] = spanAt(pts, 14)
  const [l24, h24] = spanAt(pts, 24)
  const [m14, n14] = spanAt(pts, -14)
  const [m24, n24] = spanAt(pts, -24)
  const k = (l14 - l24 + h14 - h24 + m14 - m24 + n14 - n24) / 40
  const bot0 = (l14 + m14) / 2 + 14 * k
  const top0 = (h14 + n14) / 2 + 14 * k
  const BEND = 8
  const sabs = (x: number) => (Math.abs(x) >= BEND ? Math.abs(x) : (x * x) / BEND / 2 + BEND / 2)
  const STRAIGHT = 26
  const edges = (x: number): [number, number] | null => (Math.abs(x) < STRAIGHT ? [bot0 - k * sabs(x), top0 - k * sabs(x)] : null)
  const handle = roundedBar(pts, t, edges, 36)
  // The handle's underside at (x, z = H + dz): its sections are ellipses, `hw` wide and H tall here.
  const hw = (top0 - bot0) / 2
  const under = (x: number, dz: number) => {
    if (Math.abs(dz) >= H) return null
    const yc = (top0 + bot0) / 2 - k * sabs(x)
    return yc - hw * Math.sqrt(1 - (dz / H) ** 2)
  }
  // The traced neck is 8.2 wide; its fillet into the handle's underside ends near x = ±7.8.
  const neckHalf = 4.1
  const sleeve = filletedSleeve(neckHalf, 3.7, 2, 59.4, H, under)
  // The shaft stays hex to the tip and ends in a knob cut from that hex: four loop cuts over one
  // across-corners width, the end cap and the third loop scaled down on their own centres. The full
  // rings keep the shaft's width right up to the groove.
  const knobLen = 4 / Math.cos(Math.PI / 6)
  const axisZ = 4 + knobLen / 2
  const parts: THREE.Object3D[] = [
    M(handle, 'gloss'),
    M(sleeve, 'gloss'),
    // The handle pocket is 8 mm deep; the shaft is its own 4 mm deep step.
    M(hexBar(4, LONG_HEX_SHAFT.top - (tip + knobLen)), 'black', 0, tip + knobLen, axisZ),
    M(hexKnob(4, knobLen), 'black', 0, tip, axisZ),
    // The traced outline, so the pocket is the SVG path whatever the smoothing above does.
    footprint(outline, 0, t),
  ]
  const print = keyPrint((top0 + bot0) / 2, (x) => k * sabs(x), t + 0.05)
  if (print) parts.push(print)
  return G(...parts)
}

// ---------- Trace ----------

/** Shaper Trace frame: 339.6 × 247.7 mm outside, 271.8 × 181 mm inside (Bob21's Trace insert). */
function traceFrame() {
  const s = roundRect(338.6, 246.7, 5)
  s.holes.push(new THREE.Path(roundRect(272.8, 182, 5).getPoints(6)))
  const t = 8.5
  const parts: THREE.Object3D[] = [M(extrude(s, t, 0.6), 'black')]
  // Domino markers round the frame, as on ShaperTape.
  const mark = box(10, 4.5, 0.3)
  for (let i = 0; i < 9; i++) {
    const x = -132 + i * 33
    parts.push(M(mark, 'white', x, 107, t), M(mark, 'white', x, -107, t))
  }
  for (let i = 0; i < 5; i++) {
    const y = -72 + i * 36
    parts.push(M(mark, 'white', 152, y, t, 0, 0, 90), M(mark, 'white', -152, y, t, 0, 0, 90))
  }
  return G(...parts)
}

function phone() {
  return G(M(extrude(roundRect(77, 160, 11), 8.5, 1.5), 'black'), M(extrude(roundRect(73, 156, 9), 0.4, 0.1), 'screen', 0, 0, 8.4))
}

// ---------- Shop ----------

function pencil() {
  return G(
    M(faceted(cyl(4.27, 4.27, 160, 6)), 'yellow'),
    M(lathe([[4.1, 160], [1.1, 177], [0.01, 178.5]], 24), 'wood'),
    M(lathe([[1.1, 177], [0.01, 178.6]], 12), 'graphite'),
    M(cyl(3.9, 3.9, 9), 'steel', 0, 0, -9),
    M(cyl(3.7, 3.5, 7), 'red', 0, 0, -15.5),
  )
}

function tapeMeasure() {
  return G(M(extrude(roundRect(70, 66, 16), 32, 3), 'yellow'), M(extrude(roundRect(72, 50, 12), 22, 2), 'knob', 0, -4, 5), M(box(6, 22, 4), 'steel', 38, -20, 14))
}

// ---------- Cutouts ----------

/**
 * Bit slots, as in Dr.BuckyLab's insert: a row of grooves for bits lying down (63 mm long, 12 mm
 * apart, 9 mm deep) across a 6 mm finger trough.
 */
function bitSlots(p: Record<string, number>) {
  const n = Math.round(p.count)
  const pitch = 12
  const span = (n - 1) * pitch
  const parts: THREE.Object3D[] = []
  for (let i = 0; i < n; i++) parts.push(M(box(7, 63, 9), 'ghost', -span / 2 + i * pitch))
  // 134.5 mm long for ten slots, as in the hub insert.
  parts.push(M(extrude(stadium(span + 3.8, 11.35), 6, 0), 'ghost', 0, 0, 3))
  return G(...parts)
}

// ---------- Bits ----------

/** A Shaper bit standing on its shank, cutter up, from the catalogue's dimensions. */
function buildBit(b: Bit) {
  const R = b.diameter / 2
  const rs = b.shankDiameter / 2
  const L = b.fluteLength
  const zs = Math.max(15, (b.overallLength ?? L + 38) - L)
  const lead = (Math.PI * b.diameter) / Math.tan((30 * Math.PI) / 180)
  const twist = 1 / lead
  return () => {
    const parts: THREE.Object3D[] = [M(lathe([[0, 0], [rs - 0.4, 0], [rs, 0.4], [rs, zs], [0, zs]], 32), 'steel')]
    let cutter: THREE.BufferGeometry
    if (b.type === 'vbit') {
      const A = ((b.angle ?? 90) * Math.PI) / 180
      const rt = (b.tipDiameter ?? 0) / 2
      const hc = Math.min(L, (R - rt) / Math.tan(A / 2))
      cutter = lathe([[0, 0], [R, 0], [R, L - hc], [Math.max(rt, 0.05), L], [0, L]], 40)
    } else if (b.type === 'undercut' && b.subtype === 'dovetail') {
      const rn = Math.max(1, R - L * Math.tan(((b.angle ?? 15) * Math.PI) / 180))
      cutter = lathe([[0, 0], [rn, 0], [R, L], [0, L]], 40)
    } else if (b.type === 'undercut') {
      cutter = lathe([[0, 0], [2.5, 0], [2.5, L - 5], [R, L - 5], [R, L], [0, L]], 40)
    } else if (b.type === 'ball') {
      cutter = fluted((z) => (z < L - R ? R : Math.sqrt(Math.max(0, R * R - (z - (L - R)) ** 2))), L, 2, twist)
    } else if (b.type === 'taperedball') {
      const rt = b.tipRadius ?? 0.8
      const t = Math.tan((((b.angle ?? 11) / 2) * Math.PI) / 180)
      cutter = fluted((z) => (z < L - rt ? rt + (L - rt - z) * t : Math.sqrt(Math.max(0, rt * rt - (z - (L - rt)) ** 2))), L, 2, twist)
    } else {
      cutter = fluted(() => R, L, /o-flute/i.test(b.subtype) ? 1 : (b.flutes ?? 2), twist)
    }
    cutter.translate(0, 0, zs)
    parts.push(M(cutter, 'carbide'))
    // A shank wider than the cutter necks down to it.
    if (R < rs - 0.3) parts.push(M(cyl(rs, R, 3, 32), 'carbide', 0, 0, zs - 3))
    return G(...parts)
  }
}

function bitShort(b: Bit): string {
  return b.name
    .replace(/ Router Bit$/i, '')
    .replace(/Up-Spiral /i, '')
    .replace(/ \(in Origin box\)/i, '')
    .replace(/ X /g, ' × ')
}

const bitItems: ItemDef[] = BITS.map((b) => {
  const L = b.fluteLength
  const shank = Math.max(15, (b.overallLength ?? L + 38) - L)
  return {
    id: `bit-${b.id}`,
    name: b.name,
    short: bitShort(b),
    cats: ['bits'],
    note: `Ø${+b.diameter.toFixed(2)} mm cutter, Ø${+b.shankDiameter.toFixed(2)} mm shank${b.overallLength ? `, ${+b.overallLength.toFixed(1)} mm long` : ''}.`,
    poses: [
      { id: 'upright', label: 'Upright, shank in', rot: [0, 0, 0], sink: () => Math.min(shank * 0.75, 30) },
      { id: 'lying', label: 'Lying', rot: [90, 0, 0] },
    ],
    build: buildBit(b),
  }
})

// ---------- The catalogue ----------

export const ITEMS: ItemDef[] = [
  {
    id: 'collet',
    name: 'Collet',
    short: 'Collet',
    cats: ['origin'],
    note: `Origin collet with its nut: Ø20 nut over an Ø11 nose, 19 mm tall. ${HUB}`,
    poses: COLLET_POSES,
    build: collet,
  },
  {
    id: 'collet-wrench',
    name: 'Collet wrench',
    short: 'Collet wrench',
    cats: ['origin', 'workstation'],
    note: `Origin’s open-end wrench, 169 × 43 × 6.5 mm (profile type A; shipped wrenches vary). ${HUB}`,
    // Standard depths from the Hub inserts: 7 mm flat (Sam's kit), 20 mm on edge (LeoTurlock, Dr.BuckyLab).
    poses: [
      flat('Flat', 7),
      { id: 'flipped', label: 'Flat, flipped', rot: [180, 0, 0], sink: () => 7 },
      { id: 'edge', label: 'On its edge', rot: [90, 0, 0], sink: () => 20 },
      { id: 'edge-b', label: 'Other edge', rot: [-90, 0, 0], sink: () => 20 },
    ],
    build: colletWrench,
  },
  {
    id: 'shapertape',
    name: 'ShaperTape roll',
    short: 'ShaperTape',
    cats: ['origin', 'trace'],
    note: `0.75 in (19 mm) wide, about 79 mm across on a 1 in core. Flat, it sits in a plain round pocket (no foam post in the core). ${HUB}`,
    randomSpin: true,
    poses: [flat(), { id: 'edge', label: 'Standing on edge', rot: [90, 0, 0], sink: () => 30 }],
    build: () => G(...tapeRollParts()),
  },
  {
    id: 'shapertape-pair',
    name: 'ShaperTape, two rolls',
    short: 'ShaperTape ×2',
    cats: ['origin', 'trace'],
    note: `Two rolls side by side, standing on edge in one slot, as the hub inserts keep them. Flat, stacked, they sit in a plain round pocket. ${HUB}`,
    randomSpin: true,
    poses: [
      { id: 'edge', label: 'Standing on edge', rot: [90, 0, 0], sink: () => 30 },
      { id: 'flat', label: 'Flat, stacked', rot: [0, 0, 0] },
    ],
    build: () => G(...tapeRollParts(0), ...tapeRollParts(TAPE_W, 31)),
  },
  {
    id: 'usb-gen1',
    name: 'Shaper USB stick (Gen 1)',
    short: 'USB Gen 1',
    cats: ['origin'],
    note: `A slim 42 × 12 × 4.5 mm metal stick. ${HUB}`,
    poses: [
      flat('Lying'),
      { id: 'edge', label: 'On its edge', rot: [90, 0, 0] },
      { id: 'stand', label: 'Standing, plug down', rot: [0, 90, 0], sink: () => 20 },
    ],
    build: usbGen1,
  },
  {
    id: 'usb-gen2',
    name: 'Shaper USB stick (Gen 2)',
    short: 'USB Gen 2',
    cats: ['origin'],
    approx: true,
    note: 'Size estimated. Check yours with a caliper.',
    poses: [flat(), { id: 'edge', label: 'On edge', rot: [90, 0, 0] }, { id: 'stand', label: 'Standing, plug down', rot: [0, 90, 0], sink: half }],
    build: usb(31, 13, 6, { l: 6.5, w: 8.4, t: 2.6 }, 'black'),
  },
  {
    id: 'dust-adapter',
    name: 'Dust collection adapter',
    short: 'Dust adapter',
    cats: ['origin'],
    approx: true,
    note: 'Universal adapter (Gen 2). Size estimated.',
    poses: [{ id: 'lying', label: 'Lying', rot: [90, 0, 0] }, { id: 'standing', label: 'Standing', rot: [0, 0, 0] }],
    build: dustAdapter,
  },
  ...bitItems,
  {
    id: 'ws-support-arm',
    name: 'Workstation Support Arm',
    short: 'Support arm',
    cats: ['workstation'],
    note: `187 × 76 × 12.5 mm. Flip it to store a left or a right arm; standing, the post goes down into the foam. ${HUB}`,
    // Standard depths from the Hub inserts: 13 mm lying (Sam's kit), 50 mm standing (LeoTurlock, Dr.BuckyLab).
    poses: [
      { id: 'lying', label: 'Lying', rot: [0, 0, 0], sink: () => 13 },
      { id: 'lying-b', label: 'Lying, flipped', rot: [180, 0, 0], sink: () => 13 },
      { id: 'standing', label: 'Standing, post down', rot: [-90, 0, 0], sink: () => 50 },
    ],
    build: supportArm,
  },
  {
    id: 'ws-angle-fence',
    name: 'Workstation Angle Fence',
    short: 'Angle fence',
    cats: ['workstation'],
    note: `160 × 48 × 9.5 mm. Its Lock Screw (the knob) is a separate item. ${HUB}`,
    // Standard depths from the Hub inserts: 10 mm flat (Sam's kit), 20 mm on edge (LeoTurlock, Dr.BuckyLab).
    poses: [
      flat('Flat', 10),
      { id: 'flipped', label: 'Flat, flipped', rot: [180, 0, 0], sink: () => 10 },
      { id: 'edge', label: 'On its edge', rot: [90, 0, 0], sink: () => 20 },
      { id: 'edge-b', label: 'Other edge', rot: [-90, 0, 0], sink: () => 20 },
    ],
    build: angleFence,
  },
  {
    id: 'ws-lock-screw',
    name: 'Angle Fence Lock Screw',
    short: 'Fence knob',
    cats: ['workstation'],
    note: `The Angle Fence’s knob: Ø18 × 13 mm head on a Ø7 × 15 mm screw. ${HUB}`,
    poses: [{ id: 'standing', label: 'Standing, screw down', rot: [0, 0, 0] }, { id: 'lying', label: 'Lying', rot: [90, 0, 0] }],
    build: lockScrew,
  },
  {
    id: 'ws-clamp',
    name: 'Workstation Hold Down Clamp',
    short: 'Hold-down clamp',
    cats: ['workstation'],
    note: `Lever on its side (147 × 34 × 18 mm) with the T-bolt through it and the Ø47 knob screwed on, lying down on the bolt's axis, as the ShaperHub clamp pockets store it. The lever pocket is 20 mm deep; the knob stands about 14 mm above the foam. ${HUB}`,
    poses: [
      { id: 'lying', label: 'Lying', rot: [0, 0, 0], sink: () => CLAMP_SINK },
      { id: 'lying-b', label: 'Lying, flipped', rot: [180, 0, 0], sink: () => CLAMP_SINK },
    ],
    build: holdDownClamp,
  },
  {
    id: 'ws-t-wrench',
    name: '4 mm T-handle hex key',
    short: '4 mm hex key',
    cats: ['workstation', 'origin'],
    note: `The Workstation’s 4 mm wrench: 217 mm long, 80 mm handle. ${HUB}`,
    poses: [
      flat('Flat', 8),
      { id: 'edge', label: 'On its edge', rot: [0, 90, 0] },
      { id: 'standing', label: 'Standing, shaft in', rot: [90, 0, 0], sink: () => 70 },
    ],
    build: shaperHexKey,
  },
  {
    id: 'ws-t-wrench-short',
    name: 'Short 4 mm T-handle hex key',
    short: 'Short hex key',
    cats: ['workstation', 'origin'],
    note: `The short 4 mm key: about 85 mm long, 65 mm handle. ${HUB}`,
    // 8 mm flat, as DatEi's insert cuts it (hubProfiles.ts).
    poses: [
      flat('Flat', 8),
      { id: 'edge', label: 'On its edge', rot: [0, 90, 0] },
      { id: 'standing', label: 'Standing, shaft in', rot: [-90, 0, 0], sink: () => 35 },
    ],
    build: tHexKey(SHORT_HEX_HANDLE, 7.5, SHORT_HEX_SHAFT.base, SHORT_HEX_SHAFT.tip),
  },
  {
    id: 'trace-frame',
    name: 'Shaper Trace frame',
    short: 'Trace frame',
    cats: ['trace'],
    note: `About 339 × 247 mm outside, 272 × 181 mm inside. The window keeps a foam island. ${HUB} Thickness estimated.`,
    islands: true,
    poses: [flat(), { id: 'edge', label: 'On edge', rot: [90, 0, 0], sink: () => 40 }],
    build: traceFrame,
  },
  {
    id: 'phone',
    name: 'Smartphone',
    short: 'Phone',
    cats: ['trace', 'shop'],
    approx: true,
    note: 'A typical 6.1 in phone, for the Trace app. Use a custom box for yours.',
    poses: [
      { id: 'screen-up', label: 'Screen up', rot: [0, 0, 0] },
      { id: 'screen-down', label: 'Screen down', rot: [180, 0, 0] },
      { id: 'edge', label: 'On edge', rot: [0, 90, 0], sink: half },
    ],
    build: phone,
  },
  {
    id: 'pencil',
    name: 'Pencil',
    short: 'Pencil',
    cats: ['shop', 'trace'],
    poses: [{ id: 'lying', label: 'Lying', rot: [90, 0, 0] }, { id: 'standing', label: 'Standing', rot: [0, 0, 0], sink: () => 40 }],
    build: pencil,
  },
  {
    id: 'tape-measure',
    name: 'Tape measure, 5 m',
    short: 'Tape measure',
    cats: ['shop'],
    approx: true,
    poses: [flat('On its side'), { id: 'upright', label: 'Upright', rot: [90, 0, 0], sink: half }],
    build: tapeMeasure,
  },
  {
    id: 'thumb-notch',
    name: 'Thumb notch',
    short: 'Thumb notch',
    cats: ['basics'],
    notch: true,
    note: 'Drop it on the edge of a pocket to lift the item out. It cuts as deep as the pocket it overlaps.',
    params: [{ key: 'dia', label: 'Diameter', def: 32, min: 15, max: 80 }],
    poses: [flat('Round')],
    resize: () => ({ round: 'dia' }),
    build: (p) => G(M(cyl(p.dia / 2, p.dia / 2, 10, 48), 'ghost')),
  },
  {
    id: 'finger-slot',
    name: 'Finger slot',
    short: 'Finger slot',
    cats: ['basics'],
    notch: true,
    note: 'A long finger pull. It cuts as deep as the pocket it overlaps.',
    // Overall sizes (the slot was stadium(40, 13): 66 × 26).
    params: [
      { key: 'len', label: 'Length', def: 66, min: 15, max: 200 },
      { key: 'w', label: 'Width', def: 26, min: 10, max: 80 },
    ],
    poses: [flat('Slot')],
    resize: () => ({ x: 'len', y: 'w' }),
    build: (p) => G(M(extrude(stadium(Math.max(0, p.len - p.w), Math.min(p.w, p.len) / 2), 10, 0), 'ghost')),
  },
  {
    id: 'bit-slots',
    name: 'Bit slots',
    short: 'Bit slots',
    cats: ['basics', 'bits'],
    cutout: true,
    note: 'Grooves for bits lying down, 12 mm apart, 9 mm deep, across a 6 mm finger trough (Dr.BuckyLab’s insert).',
    params: [{ key: 'count', label: 'Slots', def: 10, min: 2, max: 20 }],
    poses: [flat('Slots')],
    build: bitSlots,
  },
  {
    id: 'custom-box',
    name: 'Custom box',
    short: 'Box',
    cats: ['basics'],
    note: 'Set its size in the panel.',
    params: [
      { key: 'w', label: 'Length', def: 100, min: 5, max: 380 },
      { key: 'd', label: 'Width', def: 60, min: 5, max: 270 },
      { key: 'h', label: 'Height', def: 30, min: 2, max: 380 },
    ],
    poses: [flat(), { id: 'side', label: 'On its side', rot: [90, 0, 0] }, { id: 'end', label: 'On its end', rot: [0, 90, 0] }],
    // Side (x 90°): height runs along y; end (y 90°): height runs along x.
    resize: (pose) => (pose === 'side' ? { x: 'w', y: 'h' } : pose === 'end' ? { x: 'h', y: 'd' } : { x: 'w', y: 'd' }),
    build: (p) => G(M(extrude(roundRect(p.w, p.d, Math.min(2, p.w / 4, p.d / 4)), p.h, Math.min(0.8, p.h / 6)), 'custom')),
  },
  {
    id: 'custom-cylinder',
    name: 'Custom cylinder',
    short: 'Cylinder',
    cats: ['basics'],
    note: 'Set its size in the panel.',
    params: [
      { key: 'dia', label: 'Diameter', def: 40, min: 3, max: 260 },
      { key: 'len', label: 'Length', def: 80, min: 2, max: 380 },
    ],
    poses: [{ id: 'standing', label: 'Standing', rot: [0, 0, 0] }, { id: 'lying', label: 'Lying', rot: [90, 0, 0] }],
    // Lying (x 90°): the axis runs along y.
    resize: (pose) => (pose === 'lying' ? { x: 'dia', y: 'len' } : { round: 'dia' }),
    build: (p) => G(M(cyl(p.dia / 2, p.dia / 2, p.len, 48), 'custom')),
  },
]

const BY_ID = new Map(ITEMS.map((i) => [i.id, i]))
export const getItem = (id: string): ItemDef | undefined => BY_ID.get(id)

/** An item's parameters with defaults filled in. */
export function itemParams(def: ItemDef, p?: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const d of def.params ?? []) out[d.key] = Math.min(d.max, Math.max(d.min, p?.[d.key] ?? d.def))
  return out
}

/** The resize handles' params for an item in a pose (index), or null when it has none. */
export function resizeAxes(def: ItemDef, pose: number): ResizeAxes | null {
  return def.resize?.((def.poses[pose] ?? def.poses[0]).id) ?? null
}
