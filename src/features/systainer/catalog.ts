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
import { splitRegions } from '../../geometry/offset'
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
import { boundsOf, box, cyl, extrude, extrudeOutline, faceted, fluted, G, knurled, lathe, M, profile, roundRect, stadium, starKnob } from './models'

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
  /** Keep foam islands inside the pocket (the core of a tape roll, the window of the Trace frame). */
  islands?: boolean
  /** A finger cutout rather than an object: it takes the depth of the pockets it overlaps. */
  notch?: boolean
  /** A shaped cutout (bit slots): drawn as a ghost, and other items may sit in it. */
  cutout?: boolean
  /** Editable sizes (custom shapes). */
  params?: ParamDef[]
  build: (p: Record<string, number>) => THREE.Object3D
}

const flat = (label = 'Flat'): Pose => ({ id: 'flat', label, rot: [0, 0, 0] })
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

// ---------- Origin ----------

/**
 * Origin collet with its nut: a Ø20 × 8 mm nut over an Ø11 × 11 mm nose, 19 mm in all (the hub
 * inserts cut a Ø21 ring 8 mm deep round a Ø12 hole 19 mm deep for it).
 */
function collet(bore: number) {
  const rb = bore / 2 + 0.2
  return () =>
    G(
      M(lathe([[rb, 0], [5.1, 0], [5.5, 0.5], [5.5, 11], [rb, 11], [rb, 0]], 40), 'steel'),
      M(lathe([[rb, 11], [9.4, 11], [10, 11.6], [10, 18.4], [9.4, 19], [rb, 19], [rb, 11]], 48), 'steel'),
    )
}

const COLLET_POSES: Pose[] = [
  { id: 'nose-down', label: 'Standing, nose down', rot: [0, 0, 0] },
  { id: 'nose-up', label: 'Standing, nut down', rot: [180, 0, 0] },
  { id: 'lying', label: 'Lying', rot: [90, 0, 0] },
]

const COLLETS: [string, string, number][] = [
  ['collet-8', '8 mm collet', 8],
  ['collet-6', '6 mm collet', 6],
  ['collet-3', '3 mm collet', 3],
  ['collet-1-4', '1/4" collet', 6.35],
  ['collet-1-8', '1/8" collet', 3.175],
]

/** ShaperTape roll: 19.05 mm (0.75 in) wide, about 79 mm across, on a 1 in core. Lies flat on z = 0. */
const TAPE_W = 19.05
function tapeRollParts(z = 0): THREE.Object3D[] {
  return [
    M(lathe([[12.7, z], [15.5, z], [15.5, z + TAPE_W], [12.7, z + TAPE_W], [12.7, z]]), 'core'),
    M(lathe([[15.5, z + 0.05], [39.3, z + 0.05], [39.3, z + TAPE_W - 0.05], [15.5, z + TAPE_W - 0.05], [15.5, z + 0.05]], 64), 'tape'),
  ]
}

/** The Gen 1 USB stick: a slim 42 × 12 × 4.5 mm metal stick, plug and body the same section. */
function usbGen1() {
  return G(M(extrude(roundRect(30, 12, 1.2), 4.5, 0.6), 'grey', -6), M(box(12, 12, 4.5), 'steel', 15))
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
  return G(M(extrudeOutline(profile(OPEN_WRENCH, 0.4), 6.5, 0.5), 'steel'))
}

// ---------- Workstation ----------

/** Support Arm, from its lying outline: the post (left), the arm, and the two steel pegs that hook onto the Body. */
function supportArm() {
  const t = 12.5
  const all = profile(SUPPORT_ARM, 0.5)
  const pegX = boundsOf(all).x0 + 10.3
  const parts: THREE.Object3D[] = [M(extrudeOutline(profile(SUPPORT_ARM, 0.5, { minX: pegX }), t, 0.8), 'black')]
  for (const region of splitRegions(profile(SUPPORT_ARM, 0.5, { maxX: pegX + 0.01 }))) {
    const b = boundsOf(region)
    if (b.w < 1 || b.h < 1) continue
    const r = Math.min(b.h / 2, t / 2)
    // Along −x from the post's face.
    parts.push(M(cyl(r, r, b.w + 1, 32), 'steel', pegX + 1, b.cy, t / 2, 0, -90))
  }
  return G(...parts)
}

/** Angle Fence (white), lying flat; its Lock Screw is a separate item. */
function angleFence() {
  return G(M(extrudeOutline(profile(ANGLE_FENCE, 0.5), 9.5, 0.8), 'white'))
}

/** The Angle Fence's Lock Screw: knurled Ø18 × 13 head on a Ø7 × 15 screw (the hub's 13 / 28 mm pockets). */
function lockScrew() {
  return G(M(cyl(3.5, 3.5, 15.2, 24), 'steel'), M(faceted(knurled(9, 13)), 'knob', 0, 0, 15))
}

/**
 * Hold Down Clamp, stored as the hub inserts keep it: the lever on its side with the T-bolt through
 * it, and the star knob screwed off and lying flat at the end of the bolt.
 */
function holdDownClamp() {
  const t = 18
  const ch = boundsOf([{ closed: true, pts: CLAMP_BOLT }])
  const kb = boundsOf([{ closed: true, pts: CLAMP_KNOB }])
  const len = ch.h - 2
  return G(
    M(extrudeOutline(profile(CLAMP_LEVER, 0.5), t, 0.8), 'black'),
    M(cyl(4, 4, len, 24), 'steel', ch.cx, ch.y0 + 1, t / 2, -90),
    M(box(22, 9, 12), 'steel', ch.cx, ch.y1 - 6, t / 2 - 6),
    M(starKnob((Math.min(kb.w, kb.h) - 3) / 2, 26), 'knob', kb.cx, kb.cy, 0),
  )
}

/** A T-handle hex key lying flat: handle outline `t` thick, a 4 mm hex shaft through its middle. */
function tHexKey(handle: typeof LONG_HEX_HANDLE, t: number, y0: number, y1: number) {
  return () => G(M(extrudeOutline(profile(handle, 0.4), t, 0.8), 'knob'), M(hexBar(4, y1 - y0), 'steel', 0, y0, t / 2))
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
  ...COLLETS.map(
    ([id, name, d]): ItemDef => ({
      id,
      name,
      short: name.replace(' collet', ''),
      cats: ['origin'],
      note: `Origin collet with its nut: Ø20 nut over an Ø11 nose, 19 mm tall. ${HUB}`,
      poses: COLLET_POSES,
      build: collet(d),
    }),
  ),
  {
    id: 'collet-wrench',
    name: 'Collet wrench',
    short: 'Collet wrench',
    cats: ['origin', 'workstation'],
    note: `Origin’s open-end wrench, 169 × 43 × 6.5 mm (profile type A; shipped wrenches vary). ${HUB}`,
    poses: [
      flat(),
      { id: 'flipped', label: 'Flat, flipped', rot: [180, 0, 0] },
      { id: 'edge', label: 'On its edge', rot: [90, 0, 0], sink: () => 22 },
      { id: 'edge-b', label: 'Other edge', rot: [-90, 0, 0], sink: () => 22 },
    ],
    build: colletWrench,
  },
  {
    id: 'shapertape',
    name: 'ShaperTape roll',
    short: 'ShaperTape',
    cats: ['origin', 'trace'],
    note: `0.75 in (19 mm) wide, about 79 mm across on a 1 in core. Flat, the core keeps a foam post. ${HUB}`,
    islands: true,
    poses: [flat(), { id: 'edge', label: 'Standing on edge', rot: [90, 0, 0], sink: () => 30 }],
    build: () => G(...tapeRollParts()),
  },
  {
    id: 'shapertape-pair',
    name: 'ShaperTape, two rolls',
    short: 'ShaperTape ×2',
    cats: ['origin', 'trace'],
    note: `Two rolls side by side, standing on edge in one slot, as the hub inserts keep them. ${HUB}`,
    islands: true,
    poses: [
      { id: 'edge', label: 'Standing on edge', rot: [90, 0, 0], sink: () => 30 },
      { id: 'flat', label: 'Flat, stacked', rot: [0, 0, 0] },
    ],
    build: () => G(...tapeRollParts(0), ...tapeRollParts(TAPE_W)),
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
    poses: [
      { id: 'lying', label: 'Lying', rot: [0, 0, 0] },
      { id: 'lying-b', label: 'Lying, flipped', rot: [180, 0, 0] },
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
    poses: [
      flat(),
      { id: 'flipped', label: 'Flat, flipped', rot: [180, 0, 0] },
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
    note: `Lever on its side (147 × 33 × 18 mm) with the T-bolt through it, and the Ø50 star knob off and lying flat beside it, as the hub inserts store it. ${HUB}`,
    poses: [
      { id: 'lying', label: 'Lying, knob off', rot: [0, 0, 0] },
      { id: 'lying-b', label: 'Lying, flipped', rot: [180, 0, 0] },
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
      flat(),
      { id: 'edge', label: 'On its edge', rot: [0, 90, 0] },
      { id: 'standing', label: 'Standing, shaft in', rot: [90, 0, 0], sink: () => 70 },
    ],
    build: tHexKey(LONG_HEX_HANDLE, 9.5, LONG_HEX_SHAFT.tip, LONG_HEX_SHAFT.top),
  },
  {
    id: 'ws-t-wrench-short',
    name: 'Short 4 mm T-handle hex key',
    short: 'Short hex key',
    cats: ['workstation', 'origin'],
    note: `The short 4 mm key: about 85 mm long, 65 mm handle. ${HUB}`,
    poses: [
      flat(),
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
    poses: [flat('Round')],
    build: () => G(M(cyl(16, 16, 10, 48), 'ghost')),
  },
  {
    id: 'finger-slot',
    name: 'Finger slot',
    short: 'Finger slot',
    cats: ['basics'],
    notch: true,
    note: 'A long finger pull. It cuts as deep as the pocket it overlaps.',
    poses: [flat('Slot')],
    build: () => G(M(extrude(stadium(40, 13), 10, 0), 'ghost')),
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
