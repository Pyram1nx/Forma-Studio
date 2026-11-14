// The Shaper Trace frame (SX1-AA), modelled on Shaper's product photos (shapertools.com/trace).
//
// Size: Shaper's FAQ gives 338 × 248 mm outside, with a 263 × 173 mm capture area. The rest was
// measured on the top-down product shot (trace_product_picture_1.png: the frame is 869 × 1184 px,
// exactly 248:338, so 3.504 px/mm) and the underside shot (trace-product_image_3.png):
//
//   - Outline: 338 × 248, corner r 11.4.
//   - The inner edges are concentric: an offset ρ from one rectangle 253 × 163 (half 126.5 × 81.5)
//     is a rounded rectangle of radius ρ. The window is ρ 10 (273 × 183), the chamfer slopes up from
//     the window to the band at ρ 17.1, and the dots sit on ρ 25.2 (their track is 303 × 213, as
//     traceDots.ts self-calibrates).
//   - Outside the band the top rolls over into a slope down to a ~1 mm vertical edge at the outline.
//     The outline's corner is only r 11.4 against the band's r ~33, so the slope widens round the
//     corners: its corner morphs from concentric at the band to the outline's at the edge.
//   - Dots: four sizes, Ø 2.6 / 3.55 / 4.55 / 5.55, on a 9 mm pitch along the straight rows, three
//     slots 20° apart on each corner arc. Which slots hold which size is the frame's code, read slot by
//     slot off the photo (each slot is either clearly white, ~230 grey, or clearly empty, under 120).
//   - The SHAPER wordmark (in the Forma face) is debossed on one end's outer slope; the underside has inset pads round the same
//     track, a square pad, a QR sticker and the Shaper logo and wordmark.
//
// Heights aren't published: the band's 6 mm and the slope's angle are estimated from the oblique shots.
// The whole frame is one black: satin on the slopes and edges, dead matte on the dotted band.
//
// Frame: x along the long side (the wordmark's end at +x), y across, z up, lying on z = 0. Only a
// hidden footprint counts for pockets (the true outline with the window as an island); everything
// drawn is `deco`.
import * as THREE from 'three'
import { mergeGeometries, toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { drawShaperMark, formaLoaded, loadShaperMark, shaperMarkNow, shaperWordmark } from './shaperBrand'
import { extrude, M, roundRect } from './models'

export const TRACE_LONG = 338
export const TRACE_SHORT = 248
export const TRACE_CORNER_R = 11.4
const TOP_H = 6

/** Half-size of the rectangle the concentric edges are offset from. */
const BX = 126.5
const BY = 81.5
const WINDOW_RHO = 10
/** Window, 273 × 183 r 10: the through-opening at the paper. */
export const TRACE_WINDOW = { long: 2 * (BX + WINDOW_RHO), short: 2 * (BY + WINDOW_RHO), r: WINDOW_RHO }

/** The outer edge's offset from the base rectangle on the straight sides (338 / 2 − 126.5). */
const OUT = TRACE_LONG / 2 - BX
/** The outline's corner centres sit this far out from the base rectangle's: its corner is only r 11.4. */
const OUT_C = OUT - TRACE_CORNER_R
/** The outer slope: down from the band at this angle to a ~1 mm vertical edge at the outline. */
const SLOPE_DEG = 26
const EDGE_H = 1.6

type P2 = [number, number]

/** Arc points rounding the corner p1 between p0→p1 and p1→p2 with radius r (tangent points included). */
function fillet(p0: P2, p1: P2, p2: P2, r: number, n: number): P2[] {
  const unit = (a: P2, b: P2): P2 => {
    const l = Math.hypot(b[0] - a[0], b[1] - a[1])
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l]
  }
  const u1 = unit(p1, p0)
  const u2 = unit(p1, p2)
  const half = Math.acos(u1[0] * u2[0] + u1[1] * u2[1]) / 2
  const t = r / Math.tan(half)
  const bis = unit([0, 0], [u1[0] + u2[0], u1[1] + u2[1]])
  const c: P2 = [p1[0] + (bis[0] * r) / Math.sin(half), p1[1] + (bis[1] * r) / Math.sin(half)]
  const a0 = Math.atan2(p1[1] + u1[1] * t - c[1], p1[0] + u1[0] * t - c[0])
  let a1 = Math.atan2(p1[1] + u2[1] * t - c[1], p1[0] + u2[0] * t - c[0])
  if (a1 - a0 > Math.PI) a1 -= 2 * Math.PI
  if (a0 - a1 > Math.PI) a1 += 2 * Math.PI
  const out: P2[] = []
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n
    out.push([c[0] + r * Math.cos(a), c[1] + r * Math.sin(a)])
  }
  return out
}

/** Where the slope's line would meet the band's top and the outer wall (the fillets' corners). */
const SLOPE_TOP: P2 = [OUT - (TOP_H - EDGE_H) / Math.tan((SLOPE_DEG * Math.PI) / 180), TOP_H]
const SLOPE_FOOT: P2 = [OUT, EDGE_H]
const TOP_ROLL = fillet([17.25, TOP_H], SLOPE_TOP, SLOPE_FOOT, 4, 6)
const FOOT_ROLL = fillet(SLOPE_TOP, SLOPE_FOOT, [OUT, 0], 1, 5)
/** The band's flat top ends where the roll over into the slope begins. */
const BAND_END = TOP_ROLL[0][0]

/**
 * The whole cross-section as a closed loop of (d, z), d the offset outward along the straight sides:
 * the underside from the outline in to the window, the chamfer up from the window, the band (flat,
 * with the dots), the roll over into the outer slope, the slope down to the outer edge's round, and
 * the short vertical edge back to the underside. Inside the band d is a concentric offset (corner
 * radius d); from the band out to the outline the corner morphs to r 11.4 (`cornerOf`), so the slope
 * widens round each corner as the real frame's does.
 */
const PROFILE: P2[] = [
  [OUT, 0],
  [WINDOW_RHO, 0],
  [WINDOW_RHO + 0.05, 0.35],
  [16.5, 5.72],
  [16.85, 5.93],
  [17.25, TOP_H],
  ...TOP_ROLL,
  ...FOOT_ROLL,
  [OUT, 0],
]
/** Which material each profile segment takes: 0 the satin shell, 1 the matte band. */
const PROFILE_MAT = PROFILE.slice(1).map((_, j) => (j === 5 ? 1 : 0))

/** The corner for offset d: [how far the corner's centre moves out, the corner radius]. */
function cornerOf(d: number): [number, number] {
  const t = Math.min(1, Math.max(0, (d - BAND_END) / (OUT - BAND_END)))
  const c = OUT_C * t
  return [c, d - c]
}

/** The straight run of the outer slope, between its two rounds, for the wordmark that sits on it. */
const SLOPE_RUN = { from: TOP_ROLL[TOP_ROLL.length - 1], to: FOOT_ROLL[0] }

type DotSize = 's' | 'm' | 'l' | 'x'
const DOT_D: Record<DotSize, number> = { s: 2.6, m: 3.55, l: 4.55, x: 5.55 }
const TRACK_RHO = 25.2
const PITCH = 9

/**
 * The dot code, slot by slot ('.' = no dot), as the top-down photo shows it: long rows from -x to +x
 * (slots -126 … 126), the -y row then the +y row; end rows from +y to -y (slots 85.5 … -85.5), the
 * +x (wordmark) end then the -x end; each corner's three arc slots from the long row to the end row.
 */
const LONG_ROWS: Record<'-y' | '+y', string> = {
  '-y': 'ms..msx..lsm..sl.ms.smls.sms.',
  '+y': '..xsms.ms..sls..ms.mslm.ms.ms',
}
const END_ROWS: Record<'+x' | '-x', string> = {
  '+x': '..smsl..sm.lsm..xs.s',
  '-x': '.lm..slms..xs.msl.ls',
}
const CORNERS: [sx: number, sy: number, code: string][] = [
  [1, -1, '.lm'],
  [1, 1, 'lms'],
  [-1, 1, 'msm'],
  [-1, -1, '..m'],
]

interface Dot {
  x: number
  y: number
  d: number
}

/** Every dot of the frame, in mm on the band's top. */
export function traceDots(): Dot[] {
  const out: Dot[] = []
  const put = (x: number, y: number, c: string) => {
    if (c !== '.') out.push({ x, y, d: DOT_D[c as DotSize] })
  }
  const ty = BY + TRACK_RHO
  const tx = BX + TRACK_RHO
  for (const [side, code] of Object.entries(LONG_ROWS)) {
    const y = side === '+y' ? ty : -ty
    ;[...code].forEach((c, i) => put((i - 14) * PITCH, y, c))
  }
  for (const [end, code] of Object.entries(END_ROWS)) {
    const x = end === '+x' ? tx : -tx
    ;[...code].forEach((c, i) => put(x, 85.5 - i * PITCH, c))
  }
  for (const [sx, sy, code] of CORNERS) {
    ;[...code].forEach((c, i) => {
      // 20°, 40°, 60° from the long row's direction, round the corner's centre.
      const a = ((20 + 20 * i) * Math.PI) / 180
      put(sx * (BX + TRACK_RHO * Math.sin(a)), sy * (BY + TRACK_RHO * Math.cos(a)), c)
    })
  }
  return out
}

// ---------- Geometry ----------

interface Station {
  x: number
  y: number
  nx: number
  ny: number
}

/** Points round the base rectangle with their outward normals, counter-clockwise seen from above. */
function stations(perCorner = 28): Station[] {
  const out: Station[] = []
  const corners: [number, number, number][] = [
    [BX, -BY, -90],
    [BX, BY, 0],
    [-BX, BY, 90],
    [-BX, -BY, 180],
  ]
  for (const [x, y, a0] of corners)
    for (let i = 0; i <= perCorner; i++) {
      const a = ((a0 + (90 * i) / perCorner) * Math.PI) / 180
      out.push({ x, y, nx: Math.cos(a), ny: Math.sin(a) })
    }
  return out
}

/** The profile swept round the base rectangle, one material group per profile segment. */
function sweep(): THREE.BufferGeometry {
  const st = stations()
  const pos: number[] = []
  const g = new THREE.BufferGeometry()
  const at = (s: Station, [d, z]: P2) => {
    const [c, r] = cornerOf(d)
    return [s.x + Math.sign(s.x) * c + r * s.nx, s.y + Math.sign(s.y) * c + r * s.ny, z]
  }
  let start = 0
  for (let j = 0; j + 1 < PROFILE.length; j++) {
    for (let k = 0; k < st.length; k++) {
      const s0 = st[k]
      const s1 = st[(k + 1) % st.length]
      const a = at(s0, PROFILE[j])
      const b = at(s0, PROFILE[j + 1])
      const c = at(s1, PROFILE[j + 1])
      const d = at(s1, PROFILE[j])
      // Profile direction × path direction points out of the solid.
      pos.push(...a, ...b, ...c, ...a, ...c, ...d)
    }
    const n = st.length * 6
    g.addGroup(start, n, PROFILE_MAT[j])
    start += n
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  return planarUV(toCreasedNormals(g, (32 * Math.PI) / 180))
}

/** Box-projected UVs (by each normal's dominant axis) in units of the grain texture's tile. */
function planarUV(g: THREE.BufferGeometry, tile = 24): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  const n = g.getAttribute('normal')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i))
    const ay = Math.abs(n.getY(i))
    const az = Math.abs(n.getZ(i))
    const [u, v] = az >= ax && az >= ay ? [p.getX(i), p.getY(i)] : ay >= ax ? [p.getX(i), p.getZ(i)] : [p.getY(i), p.getZ(i)]
    uv[i * 2] = u / tile
    uv[i * 2 + 1] = v / tile
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

/** UVs spanning the frame's outline, for the one-off textures. */
function frameUV(g: THREE.BufferGeometry): THREE.BufferGeometry {
  const p = g.getAttribute('position')
  const uv = new Float32Array(p.count * 2)
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = (p.getX(i) + TRACE_LONG / 2) / TRACE_LONG
    uv[i * 2 + 1] = (p.getY(i) + TRACE_SHORT / 2) / TRACE_SHORT
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2))
  return g
}

function outline(): THREE.Shape {
  return roundRect(TRACE_LONG, TRACE_SHORT, TRACE_CORNER_R)
}

function rrPath(rho: number, pts = 16): THREE.Path {
  return new THREE.Path(roundRect(2 * (BX + rho), 2 * (BY + rho), rho).getPoints(pts))
}

function dotsGeometry(): THREE.BufferGeometry {
  const geos = traceDots().map((d) => new THREE.CircleGeometry(d.d / 2, 28).translate(d.x, d.y, 0))
  return mergeGeometries(geos)
}

// ---------- Textures ----------

const canDraw = () => typeof document !== 'undefined'

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas')
  c.width = Math.round(w)
  c.height = Math.round(h)
  return [c, c.getContext('2d')!]
}

function texture(c: HTMLCanvasElement, wrap: THREE.Wrapping = THREE.ClampToEdgeWrapping): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c)
  t.colorSpace = THREE.SRGBColorSpace
  t.anisotropy = 8
  t.wrapS = t.wrapT = wrap
  return t
}

/** Deterministic noise, so every build draws the same grain. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

/** Fine speckle of the moulded matte surface: a tile around white, to multiply the base colour. */
function grainCanvas(px: number, seed: number, amount = 26): HTMLCanvasElement {
  const [c, g] = canvas(px, px)
  const img = g.createImageData(px, px)
  const r = rng(seed)
  for (let i = 0; i < px * px; i++) {
    let v = 228 + (r() - 0.5) * amount
    // Sparse brighter flecks, as the photos show on the band.
    if (r() < 0.035) v += 22 + r() * 18
    v = Math.max(0, Math.min(255, v))
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  g.putImageData(img, 0, 0)
  return c
}

/**
 * A canvas texture drawn by `draw`, drawn again once the Forma face and Shaper's logo mark have loaded
 * if either arrives only afterwards.
 */
function fontTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D, c: HTMLCanvasElement) => void): THREE.CanvasTexture {
  const [c, g] = canvas(w, h)
  const paint = () => {
    g.setTransform(1, 0, 0, 1, 0, 0)
    g.clearRect(0, 0, c.width, c.height)
    draw(g, c)
  }
  paint()
  const t = texture(c)
  if (!shaperMarkNow() || !document.fonts.check('10px "Forma Studio"'))
    Promise.all([loadShaperMark(), formaLoaded()]).then(() => {
      paint()
      t.needsUpdate = true
    })
  return t
}

/** The debossed SHAPER on the +x end's outer slope: 28.7 mm long, reading from beyond that end. */
const MARK = { w: 8, h: 34 }
function markTexture(): THREE.Texture {
  const PX = 24
  return fontTexture(MARK.w * PX, MARK.h * PX, (g) => {
    // Plane: canvas right = +x, canvas up = +y. The letters read along +y with their tops towards the
    // frame's centre (-x), so text-x maps to canvas up and text-down to canvas right.
    const place = (dx: number) => g.setTransform(0, -PX, PX, 0, (MARK.w / 2 + dx) * PX, (MARK.h / 2) * PX)
    // A faint highlight on the lit side of each cut, then the cut itself.
    place(0.12)
    g.fillStyle = 'rgba(255,255,255,0.10)'
    shaperWordmark(g, 0, 0, 28.7)
    place(0)
    g.fillStyle = 'rgba(0,0,0,0.62)'
    shaperWordmark(g, 0, 0, 28.7)
  })
}

/** A QR-like sticker: three finder squares and a fixed scatter of modules. */
function drawQR(g: CanvasRenderingContext2D, cx: number, cy: number, size: number) {
  const n = 25
  const m = size / (n + 2)
  g.fillStyle = '#efefea'
  g.fillRect(cx - size / 2, cy - size / 2, size, size)
  const x0 = cx - size / 2 + m
  const y0 = cy - size / 2 + m
  const r = rng(77)
  g.fillStyle = '#16171a'
  const finder = (i: number, j: number) => i < 8 && j < 8 ? [i, j] : i >= n - 8 && j < 8 ? [i - (n - 7), j] : i < 8 && j >= n - 8 ? [i, j - (n - 7)] : null
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      const f = finder(i, j)
      let on: boolean
      if (f) {
        const [a, b] = f
        if (a === 7 || b === 7 || a < 0 || b < 0) on = false
        else {
          const ring = Math.max(Math.abs(a - 3), Math.abs(b - 3))
          on = ring !== 2
        }
      } else on = r() < 0.5
      if (on) g.fillRect(x0 + i * m, y0 + j * m, m + 0.02, m + 0.02)
    }
}

/**
 * Underside, drawn in the frame's outline (canvas right = +x, canvas up = +y, as seen from above, so
 * text is mirrored to read from below): inset pads in the band's track, a square pad at +x, the QR
 * sticker at -x, and Shaper's logo and wordmark on the middle pad of the +y side.
 */
function undersideTexture(): THREE.Texture {
  const PX = 5
  return fontTexture(TRACE_LONG * PX, TRACE_SHORT * PX, (g, c) => drawUnderside(g, c, PX))
}

function drawUnderside(g: CanvasRenderingContext2D, c: HTMLCanvasElement, PX: number) {
  const X = TRACE_LONG / 2
  const Y = TRACE_SHORT / 2
  // Base colour and grain in canvas pixels, then draw in mm: canvas = ((X + x) PX, (Y - y) PX).
  g.fillStyle = '#26272a'
  g.fillRect(0, 0, c.width, c.height)
  g.globalCompositeOperation = 'multiply'
  g.fillStyle = g.createPattern(grainCanvas(128, 5, 34), 'repeat')!
  g.fillRect(0, 0, c.width, c.height)
  g.globalCompositeOperation = 'source-over'
  const world = (x0 = 0, y0 = 0) => g.setTransform(PX, 0, 0, -PX, (X + x0) * PX, (Y - y0) * PX)
  world()

  const ring = (r0: number, r1: number) => {
    g.beginPath()
    for (const rho of [r1, r0]) {
      const pts = roundRect(2 * (BX + rho), 2 * (BY + rho), rho).getPoints(16)
      pts.forEach((p, i) => (i ? g.lineTo(p.x, p.y) : g.moveTo(p.x, p.y)))
      g.closePath()
    }
  }
  type Rect = [x0: number, x1: number, y0: number, y1: number]
  // Each pad is the track ring cut to a region (a union of rectangles); `d` pulls the cut ends in.
  // Measured on the underside shot: three pads down each long side, an L round each corner.
  const span = (s: number, a: number, b: number): [number, number] => (s > 0 ? [a, b] : [-b, -a])
  const pads: ((d: number) => Rect[])[] = []
  for (const sy of [1, -1]) {
    for (const [a, b] of [[-113, -37.15], [-32.85, 32.85], [37.15, 113]])
      pads.push((d) => [[a + d, b - d, ...span(sy, BY, Y)]])
    for (const sx of [1, -1])
      pads.push((d) => [
        [...span(sx, 117.3 + d, X), ...span(sy, BY, Y)],
        [...span(sx, BX, X), ...span(sy, 14.5 + d, Y)],
      ])
  }
  for (const sx of [1, -1]) pads.push((d) => [[sx > 0 ? BX : -X, sx > 0 ? X : -BX, -11 + d, 11 - d]])
  const padIn = (rects: Rect[], r0: number, r1: number, fill: string) => {
    g.save()
    g.beginPath()
    for (const [x0, x1, y0, y1] of rects) g.rect(x0, y0, x1 - x0, y1 - y0)
    g.clip()
    ring(r0, r1)
    g.fillStyle = fill
    g.fill('evenodd')
    g.restore()
  }
  for (const p of pads) {
    padIn(p(0), 12.9, 32.6, '#3d3e42')
    padIn(p(0.55), 13.45, 32.05, '#1b1c1e')
    padIn(p(2.1), 15, 30.5, '#202124')
  }
  // The mark's pad is a darker black.
  padIn([[-32.85 + 2.1, 32.85 - 2.1, BY, Y]], 15, 30.5, '#141517')

  // QR sticker at -x, on its pad.
  drawQR(g, -(BX + 22.3), 0, 17.5)

  // The logo and SHAPER, read from below: along +x, letter tops towards the centre (-y). Text space is x along
  // the reading direction and y down the letters, i.e. world (+x, +y): `world` maps it as it is,
  // which is the mirror image seen from above and reads right from below.
  const yMark = BY + 22.3
  // Shaper's logo mark (public/images/shaper-mark.svg), 5.6 mm across, upright with the letters.
  const mark = shaperMarkNow()
  g.fillStyle = '#dcdcd8'
  world(-14.3, yMark)
  if (mark) drawShaperMark(g, mark, 0, 0, 5.6)
  // Centred on the pad, the letters' baseline on the outer side.
  world(7.15, yMark)
  shaperWordmark(g, 0, 0, 20.1)
}

// ---------- Materials ----------

interface Mats {
  shell: THREE.Material
  band: THREE.Material
  dot: THREE.Material
  mark: THREE.Material | null
  under: THREE.Material | null
}
let mats: Mats | null = null

function decal(map: THREE.Texture, transparent: boolean): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map,
    transparent,
    roughness: 0.8,
    metalness: 0,
    depthWrite: !transparent,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  })
}

function materials(): Mats {
  if (mats) return mats
  const draw = canDraw()
  const grain = draw ? texture(grainCanvas(256, 3), THREE.RepeatWrapping) : null
  const grainFine = draw ? texture(grainCanvas(256, 9, 18), THREE.RepeatWrapping) : null
  mats = {
    // One black throughout: the slopes and edges satin, the dotted band the same black but dead matte
    // and speckled.
    shell: new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 0.58, metalness: 0, map: grainFine }),
    band: new THREE.MeshStandardMaterial({ color: 0x1a1b1d, roughness: 1, metalness: 0, map: grain }),
    dot: new THREE.MeshStandardMaterial({
      color: 0xf1f1ec,
      roughness: 0.55,
      metalness: 0,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
    }),
    mark: draw ? decal(markTexture(), true) : null,
    under: draw ? decal(undersideTexture(), false) : null,
  }
  return mats
}

function deco<T extends THREE.Object3D>(o: T): T {
  o.userData.deco = true
  return o
}

/** The Trace frame lying face up. */
export function shaperTraceFrame(): THREE.Object3D {
  const m = materials()
  const g = new THREE.Group()
  g.add(deco(new THREE.Mesh(sweep(), [m.shell, m.band])))
  const dots = deco(new THREE.Mesh(dotsGeometry(), m.dot))
  dots.position.z = TOP_H + 0.01
  g.add(dots)
  if (m.mark) {
    // Laid on the slope's straight run: plane +x down the slope, its normal out of the surface.
    const { from, to } = SLOPE_RUN
    const tilt = Math.atan2(from[1] - to[1], to[0] - from[0])
    const p = deco(new THREE.Mesh(new THREE.PlaneGeometry(MARK.w, MARK.h), m.mark))
    p.rotation.y = tilt
    p.position.set(
      BX + (from[0] + to[0]) / 2 + 0.02 * Math.sin(tilt),
      0,
      (from[1] + to[1]) / 2 + 0.02 * Math.cos(tilt),
    )
    g.add(p)
  }
  if (m.under) {
    const s = outline()
    s.holes.push(rrPath(WINDOW_RHO))
    const geo = new THREE.ShapeGeometry(s, 24)
    // Face down: (x, y) → (x, -y); the outline is symmetric, so it stays in place.
    geo.rotateX(Math.PI)
    g.add(deco(new THREE.Mesh(frameUV(geo), m.under)))
    g.children[g.children.length - 1].position.z = -0.01
  }
  // The pocket: the true outline, the window kept as a foam island.
  const foot = outline()
  foot.holes.push(rrPath(WINDOW_RHO, 24))
  g.add(M(extrude(foot, TOP_H, 0, 24), 'hidden'))
  return g
}
