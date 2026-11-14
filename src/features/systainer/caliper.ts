// The Shaper Connected Caliper (SY1-CC1): the owner's Blender model (caliperMesh.ts, exported by
// scripts/export-caliper-blend.py) dressed in the real thing's finishes, read off Shaper's product
// photos (7.8 px/mm, calibrated on both scales):
//
// - Beam and jaws: brushed stainless. The beam's face carries a black printed band (the model's two
//   lengthwise loops, |y| ≤ 6.3) with ~1.7 mm of bare steel either side. Inch scale hanging from the
//   top edge (1/16 in), mm scale standing on the bottom edge (1 mm), white print, then "in"/"mm" and
//   the SHAPER mark past 200 mm. 0 is where the jaws meet, so x here is the scale.
// - Slider: matte black housing; a gloss black rim round the LCD (switched off) with IN/MM and 0/⏻
//   printed in it over black rubber buttons; a yellow send button and a knurled lock screw on the
//   top edge; a knurled steel thumb roller.
//
// Frame (mm): x along the beam (scale 0 at x = 0), jaws toward −y, display up (+z).
import * as THREE from 'three'
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { drawShaperMark, formaLoaded, loadShaperMark, shaperMarkNow, shaperWordmark, type ShaperMark } from './shaperBrand'
import { CALIPER_CLS, CALIPER_IDX, CALIPER_PART, CALIPER_POS } from './caliperMesh'
import type { Pt } from '../../model/types'
import { cyl, extrude, extrudeOutline, G, knurled, M, roundRect } from './models'

/** Beam face: its x extent (a little past the model's −16.5 … 270) and the printed band. */
const BEAM_X0 = -17
const BEAM_X1 = 271
const BEAM_HALF = 8
const BAND_HALF = 6.3

/**
 * Rim (Plane.004, the gloss bezel) and LCD window in this frame. The photo's rim is 58.5 × 23.3 mm
 * round a 47.5 × 15.4 mm LCD, 5.5 / 5.8 mm in from the ends, 4.2 mm from the top, 3.85 mm from the
 * bottom; the model's rim is 59 × 22.8.
 */
const BEZEL = { x0: 1.64, x1: 60.64, y0: -9.58, y1: 13.22 }
const LCD = { x0: BEZEL.x0 + 5.45, x1: BEZEL.x1 - 5.75, y0: BEZEL.y0 + 3.75, y1: BEZEL.y1 - 4.1 }

/** The buttons' centres along x; their labels sit in the rim's bottom margin, centred over them. */
const BUTTONS = { inMm: 27.89, power: 48.39 }

/** Thumb roller axis, radius and height. */
const ROLLER = { x: 71.25, y: -13.66, r: 5.75, z0: -3, z1: 6.5 }

/** Housing's top edge (where the lock screw and send button sit) and its height. */
const EDGE_Y = 14.22
const EDGE_Z = 8.8

const COLORS = {
  steel: '#c6c9cd',
  band: '#1e1c1d',
  print: '#f3f1ef',
  housing: '#2c2e2f',
  bezel: '#131415',
  label: '#ecebe8',
}

type Decoded = { pos: Float32Array; idx: Uint16Array; cls: Uint8Array }
let decoded: Decoded | null = null

function b64(s: string): Uint8Array {
  const bin = atob(s)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decode(): Decoded {
  if (decoded) return decoded
  const pb = b64(CALIPER_POS)
  const q = new Int16Array(pb.buffer, pb.byteOffset, pb.byteLength / 2)
  const pos = new Float32Array(q.length)
  for (let i = 0; i < q.length; i++) pos[i] = q[i] / 100
  const ib = b64(CALIPER_IDX)
  const idx = new Uint16Array(ib.buffer, ib.byteOffset, ib.byteLength / 2)
  decoded = { pos, idx, cls: b64(CALIPER_CLS) }
  return decoded
}

/** The triangles of one part class (optionally filtered), with creased normals. */
function partGeometry(cls: number, keep?: (n: THREE.Vector3) => boolean): THREE.BufferGeometry {
  const { pos, idx, cls: tc } = decode()
  const out: number[] = []
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  const n = new THREE.Vector3()
  for (let t = 0; t < tc.length; t++) {
    if (tc[t] !== cls) continue
    const i0 = idx[t * 3] * 3
    const i1 = idx[t * 3 + 1] * 3
    const i2 = idx[t * 3 + 2] * 3
    a.set(pos[i0], pos[i0 + 1], pos[i0 + 2])
    b.set(pos[i1], pos[i1 + 1], pos[i1 + 2])
    c.set(pos[i2], pos[i2 + 1], pos[i2 + 2])
    if (keep && !keep(n.subVectors(c, b).cross(a.clone().sub(b)).normalize())) continue
    out.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z)
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(out, 3))
  return toCreasedNormals(g, Math.PI / 6)
}

/** Planar UVs from x, y over a rectangle (u along x, v up along y). */
function planarUV(g: THREE.BufferGeometry, r: { x0: number; x1: number; y0: number; y1: number }): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) - r.x0) / (r.x1 - r.x0)
    uv[i * 2 + 1] = (p.getY(i) - r.y0) / (r.y1 - r.y0)
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/** Box-projected UVs (by the dominant normal axis) in units of `size` mm, for tiling brushed steel. */
function boxUV(g: THREE.BufferGeometry, size: number): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  const nr = g.getAttribute('normal')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(nr.getX(i))
    const ay = Math.abs(nr.getY(i))
    const az = Math.abs(nr.getZ(i))
    const [u, v] = az >= ax && az >= ay ? [p.getX(i), p.getY(i)] : ay >= ax ? [p.getX(i), p.getZ(i)] : [p.getY(i), p.getZ(i)]
    uv[i * 2] = u / size
    uv[i * 2 + 1] = v / size
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/** Cylindrical UVs round the roller's axis: u round, v up. */
function rollerUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (Math.atan2(p.getY(i) - ROLLER.y, p.getX(i) - ROLLER.x) / (Math.PI * 2) + 1) % 1
    uv[i * 2 + 1] = (p.getZ(i) - ROLLER.z0) / (ROLLER.z1 - ROLLER.z0)
  }
  // Triangles across the seam: unwrap, so they don't smear the whole knurl (the texture repeats).
  for (let t = 0; t < p.count; t += 3) {
    const us = [uv[t * 2], uv[t * 2 + 2], uv[t * 2 + 4]]
    if (Math.max(...us) - Math.min(...us) > 0.5) for (let k = 0; k < 3; k++) if (us[k] < 0.5) uv[(t + k) * 2] += 1
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

// ---------------------------------------------------------------------------------------------
// Textures (canvas, drawn once).

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = Math.round(w)
  c.height = Math.round(h)
  return [c, c.getContext('2d')!]
}

function texture(c: HTMLCanvasElement, srgb = true, wrap: THREE.Wrapping = THREE.ClampToEdgeWrapping): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  if (srgb) t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.wrapS = t.wrapT = wrap
  return t
}

/** Deterministic noise, so every build draws the same steel. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Brushed steel: streaks along the canvas x, fine grain across them. */
function brushed(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, base: number, seed: number, grain = 0.16) {
  const r = rng(seed)
  for (let j = 0; j < h; j++) {
    const v = base + (r() - 0.5) * 22
    g.fillStyle = `rgb(${v},${v + 2},${v + 5})`
    g.fillRect(x, y + j, w, 1)
  }
  // Grain along x, so where the texture is clamped (the jaws) it streaks the other way.
  for (let i = 0; i < w; i += 2) {
    const v = (r() - 0.5) * grain
    g.fillStyle = v > 0 ? `rgba(255,255,255,${v})` : `rgba(0,0,0,${-v})`
    g.fillRect(x + i, y, 2, h)
  }
}

const FONT = '"Helvetica Neue", Helvetica, Arial, sans-serif'

/** Beam face: steel edges, black band, both scales and the SHAPER mark. */
function scaleTextures(): { map: THREE.Texture; mr: THREE.Texture } {
  const PX = 20
  const W = (BEAM_X1 - BEAM_X0) * PX
  const H = 2 * BEAM_HALF * PX
  const [c, g] = canvas(W, H)
  const X = (x: number) => (x - BEAM_X0) * PX
  const Y = (y: number) => (BEAM_HALF - y) * PX
  // Steel edges, band.
  brushed(g, 0, 0, W, H, 198, 11)
  g.fillStyle = COLORS.band
  g.fillRect(0, Y(BAND_HALF), W, 2 * BAND_HALF * PX)

  g.fillStyle = COLORS.print
  const tick = (x: number, y0: number, y1: number, w: number) => g.fillRect(X(x) - (w * PX) / 2, Y(Math.max(y0, y1)), w * PX, Math.abs(y1 - y0) * PX)
  const top = BAND_HALF
  const bot = -BAND_HALF
  // 0: one line across the band.
  tick(0, bot, top, 0.3)
  // mm: 1 / 5 / 10 mm ticks of 1.15 / 1.8 / 4.2 mm.
  for (let i = 1; i <= 200; i++) {
    const long = i % 10 === 0
    tick(i, bot, bot + (long ? 4.2 : i % 5 === 0 ? 1.8 : 1.15), long ? 0.38 : 0.25)
  }
  // Inch: 1/16 … 1 in ticks of 1.0 / 2.05 / 2.55 / 3.6 / 5.1 mm.
  const IN = 25.4
  for (let j = 1; j <= 128; j++) {
    const len = j % 16 === 0 ? 5.1 : j % 8 === 0 ? 3.6 : j % 4 === 0 ? 2.55 : j % 2 === 0 ? 2.05 : 1.0
    tick((j * IN) / 16, top - len, top, j % 16 === 0 ? 0.38 : 0.25)
  }
  // Numbers: 2.2 mm caps (Helvetica caps are 0.72 em), right-aligned 0.75 mm short of their tick.
  const CAP = 2.2
  g.font = `400 ${(CAP / 0.72) * PX}px ${FONT}`
  g.textBaseline = 'alphabetic'
  const text = (s: string, x: number, base: number, align: CanvasTextAlign) => {
    g.textAlign = align
    g.fillText(s, X(x), Y(base))
  }
  const mmBase = bot + 2.55
  const inBase = top - 2.95 - CAP
  for (let n = 10; n <= 200; n += 10) text(String(n), n - 0.19 - 0.75, mmBase, 'right')
  for (let n = 1; n <= 8; n++) text(String(n), n * IN - 0.19 - 0.7, inBase, 'right')
  text('0', -0.75, -CAP / 2, 'right')
  text('mm', 200 + 0.19 + 0.8, mmBase, 'left')
  text('in', 8 * IN + 0.19 + 0.7, inBase, 'left')

  // SHAPER mark: Shaper's round logo (public/images/shaper-mark.svg), 4.85 mm across, then the
  // wordmark in the Forma face, spanning 233.5 to 251.3. Both may arrive after the first paint (the
  // logo is fetched, the face loads), so the patch of band under them is repainted when they do.
  const logo = (mark: ShaperMark | null) => {
    g.fillStyle = COLORS.band
    g.fillRect(X(226.5), Y(BAND_HALF), 26 * PX, 2 * BAND_HALF * PX)
    g.fillStyle = COLORS.print
    if (mark) drawShaperMark(g, mark, X(229.2), Y(0), 4.85 * PX)
    shaperWordmark(g, X(242.4), Y(0), 17.8 * PX)
  }
  logo(shaperMarkNow())

  // Roughness (G) and metalness (B): steel edges metal, the band and print paint.
  const [m, mg] = canvas(4, H)
  mg.fillStyle = 'rgb(0,85,255)'
  mg.fillRect(0, 0, 4, H)
  mg.fillStyle = 'rgb(0,120,0)'
  mg.fillRect(0, Y(BAND_HALF), 4, 2 * BAND_HALF * PX)
  const map = texture(c)
  if (!shaperMarkNow() || !document.fonts.check('10px "Forma Studio"'))
    Promise.all([loadShaperMark(), formaLoaded()]).then(([mark]) => {
      logo(mark)
      map.needsUpdate = true
    })
  return { map, mr: texture(m, false) }
}

/** Text with even letter spacing, `w` mm wide, centred on (x, base). */
function spaced(g: CanvasRenderingContext2D, txt: string, x: number, base: number, w: number) {
  g.textAlign = 'left'
  const widths = [...txt].map((ch) => g.measureText(ch).width)
  const gap = (w - widths.reduce((a, b) => a + b, 0)) / Math.max(1, txt.length - 1)
  let at = x - w / 2
  ;[...txt].forEach((ch, i) => {
    g.fillText(ch, at, base)
    at += widths[i] + gap
  })
}

/** The rim (gloss black), the LCD switched off, and the button labels printed in the rim. */
function displayTextures(): { map: THREE.Texture; mr: THREE.Texture } {
  const PX = 24
  const W = (BEZEL.x1 - BEZEL.x0) * PX
  const H = (BEZEL.y1 - BEZEL.y0) * PX
  const [c, g] = canvas(W, H)
  const X = (x: number) => (x - BEZEL.x0) * PX
  const Y = (y: number) => (BEZEL.y1 - y) * PX
  g.fillStyle = COLORS.bezel
  g.fillRect(0, 0, W, H)
  const lx = X(LCD.x0)
  const ly = Y(LCD.y1)
  const lw = (LCD.x1 - LCD.x0) * PX
  const lh = (LCD.y1 - LCD.y0) * PX
  // An LCD with no power: the polariser's flat grey-green, a little darker toward the bottom.
  const grad = g.createLinearGradient(0, ly, 0, ly + lh)
  grad.addColorStop(0, '#8fa59a')
  grad.addColorStop(1, '#7f958a')
  g.fillStyle = grad
  g.fillRect(lx, ly, lw, lh)
  g.strokeStyle = 'rgba(5,10,8,0.7)'
  g.lineWidth = 0.25 * PX
  g.strokeRect(lx + 0.12 * PX, ly + 0.12 * PX, lw - 0.24 * PX, lh - 0.24 * PX)

  // IN/MM and 0/⏻: 1.65 mm caps, 7.8 / 4.6 mm wide, centred in the margin under the LCD.
  const cap = 1.65
  const mid = (BEZEL.y0 + LCD.y0) / 2
  const base = Y(mid - cap / 2)
  g.fillStyle = COLORS.label
  g.font = `500 ${(cap / 0.72) * PX}px ${FONT}`
  g.textBaseline = 'alphabetic'
  spaced(g, 'IN/MM', X(BUTTONS.inMm), base, 7.8 * PX)
  const pr = cap * 0.62
  const zeroW = 4.6 - 2 * pr - 0.35
  spaced(g, '0/', X(BUTTONS.power - 2.3 + zeroW / 2), base, zeroW * PX)
  const cx = X(BUTTONS.power + 2.3 - pr)
  const cy = Y(mid)
  g.strokeStyle = COLORS.label
  g.lineWidth = 0.22 * PX
  g.lineCap = 'round'
  g.beginPath()
  g.arc(cx, cy, pr * PX, -Math.PI / 2 + 0.75, -Math.PI / 2 - 0.75 + Math.PI * 2)
  g.stroke()
  g.beginPath()
  g.moveTo(cx, cy - (pr + 0.2) * PX)
  g.lineTo(cx, cy - 0.05 * PX)
  g.stroke()

  // Roughness (G): the rim glossy, the LCD's film satin.
  const [m, mg] = canvas(W / 8, H / 8)
  mg.fillStyle = 'rgb(0,105,0)'
  mg.fillRect(0, 0, W / 8, H / 8)
  mg.fillStyle = 'rgb(0,170,0)'
  mg.fillRect(lx / 8, ly / 8, lw / 8, lh / 8)
  return { map: texture(c), mr: texture(m, false) }
}

/** Steel grain for the unprinted steel (tiled). */
function steelTexture(): THREE.Texture {
  const [c, g] = canvas(256, 256)
  brushed(g, 0, 0, 256, 256, 200, 5, 0.03)
  return texture(c, true, THREE.RepeatWrapping)
}

/** Straight knurl round the roller: ridges along its height. */
function knurlTexture(): THREE.Texture {
  const N = 60
  const [c, g] = canvas(N * 16, 8)
  for (let i = 0; i < N * 16; i++) {
    const v = Math.round(128 + 127 * Math.cos((i / 16) * Math.PI * 2))
    g.fillStyle = `rgb(${v},${v},${v})`
    g.fillRect(i, 0, 1, 8)
  }
  return texture(c, false, THREE.RepeatWrapping)
}

// ---------------------------------------------------------------------------------------------

type Mats = Record<'steel' | 'scale' | 'housing' | 'display' | 'rubber' | 'roller' | 'rollerCap' | 'yellow', THREE.Material>
let mats: Mats | null = null

function materials(): Mats {
  if (mats) return mats
  const canDraw = typeof document !== 'undefined'
  const steel = { color: 0xffffff, metalness: 0.88, roughness: 0.34 }
  const scale = canDraw ? scaleTextures() : null
  const display = canDraw ? displayTextures() : null
  const steelMap = canDraw ? steelTexture() : null
  const knurl = canDraw ? knurlTexture() : null
  mats = {
    steel: new THREE.MeshStandardMaterial({ ...steel, map: steelMap, ...(steelMap ? {} : { color: COLORS.steel }) }),
    scale: scale
      ? new THREE.MeshStandardMaterial({ map: scale.map, roughnessMap: scale.mr, metalnessMap: scale.mr, roughness: 1, metalness: 1 })
      : new THREE.MeshStandardMaterial({ color: COLORS.band, roughness: 0.45 }),
    housing: new THREE.MeshStandardMaterial({ color: COLORS.housing, roughness: 0.62, metalness: 0 }),
    display: display
      ? new THREE.MeshStandardMaterial({ map: display.map, roughnessMap: display.mr, roughness: 1, metalness: 0 })
      : new THREE.MeshStandardMaterial({ color: COLORS.bezel, roughness: 0.12 }),
    rubber: new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.82, metalness: 0 }),
    roller: new THREE.MeshStandardMaterial({ color: 0xd2d5d9, metalness: 0.9, roughness: 0.3, ...(knurl && { bumpMap: knurl, bumpScale: 1.2 }) }),
    rollerCap: new THREE.MeshStandardMaterial({ color: 0xd6d9dc, metalness: 0.92, roughness: 0.22 }),
    yellow: new THREE.MeshStandardMaterial({ color: 0xf7cd0b, roughness: 0.42, metalness: 0 }),
  }
  return mats
}

/**
 * Pocket only (hidden): fills the sharp notch of foam between the thumb roller and the beam's lower
 * edge on the roller's far side with a concave fillet of radius `R`, tangent to both. At the beam's
 * depth (z 0 … 3.5), so the roller keeps its own deeper pocket.
 */
function rollerFillet(R = 3): THREE.Mesh {
  const edge = -BEAM_HALF
  const { x: cx, y: cy, r } = ROLLER
  const fy = edge - R
  const fx = cx + Math.sqrt((r + R) ** 2 - (fy - cy) ** 2)
  const a0 = Math.PI / 2
  const a1 = Math.atan2(cy - fy, cx - fx) + Math.PI * 2 * (Math.atan2(cy - fy, cx - fx) < a0 ? 1 : 0)
  const pts: Pt[] = []
  for (let i = 0; i <= 16; i++) {
    const a = a0 + ((a1 - a0) * i) / 16
    pts.push({ x: fx + R * Math.cos(a), y: fy + R * Math.sin(a) })
  }
  pts.push({ x: cx, y: cy }, { x: cx, y: edge })
  let area = 0
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const q = pts[(i + 1) % pts.length]
    area += p.x * q.y - q.x * p.y
  }
  if (area < 0) pts.reverse()
  return M(extrudeOutline([{ closed: true, pts }], 3.5, 0), 'hidden')
}

/** The Connected Caliper, lying display up, jaws closed. */
export function connectedCaliper(): THREE.Object3D {
  const m = materials()
  const P = CALIPER_PART
  const mesh = (g: THREE.BufferGeometry, mt: THREE.Material) => new THREE.Mesh(g, mt)
  const beam = { x0: BEAM_X0, x1: BEAM_X1, y0: -BEAM_HALF, y1: BEAM_HALF }

  // Send button (Shaper yellow) and lock screw on the housing's top edge, where the photos put them.
  const send = mesh(extrude(roundRect(8, 1.8, 0.6), 4.2, 0.45), m.yellow)
  send.position.set(55.7, EDGE_Y + 0.9 - 0.6, EDGE_Z - 2.1)
  const screwNeck = mesh(cyl(1.6, 1.6, 1.6, 24), m.rollerCap)
  const screwKnob = mesh(knurled(3.5, 2.6, 20), m.rollerCap)
  for (const [o, y] of [[screwNeck, EDGE_Y - 0.4], [screwKnob, EDGE_Y + 1.2]] as const) {
    o.rotation.x = -Math.PI / 2
    o.position.set(31, y, EDGE_Z)
  }

  return G(
    mesh(boxUV(partGeometry(P.steel), 60), m.steel),
    mesh(planarUV(partGeometry(P.scale), beam), m.scale),
    mesh(partGeometry(P.housing), m.housing),
    mesh(planarUV(partGeometry(P.display), BEZEL), m.display),
    mesh(partGeometry(P.rubber), m.rubber),
    mesh(rollerUV(partGeometry(P.roller, (n) => Math.abs(n.z) < 0.6)), m.roller),
    mesh(partGeometry(P.roller, (n) => Math.abs(n.z) >= 0.6), m.rollerCap),
    send,
    screwNeck,
    screwKnob,
    rollerFillet(),
  )
}
