// Box joint basic / pro, built the way Shaper Studio builds them (see docs/research/box-joints-studio.md).
// Studio works y-up with the board ("stock") at x ∈ [0, W], y ∈ [0, T]. Our frame is y-down with
// the stock centred on (0,0): x ∈ [-W/2, W/2], y ∈ [-T/2, T/2], so y = -T/2 is the board top.
// All lengths are mm. Param keys match the template's: side (0 = A, 1 = B), length (W), thickness
// (T), bitDiameter, fingers (pin count), pinFactor (pro), glueGap, guides (1 show, 0 hide).
import type { Contour, Pt, Units } from '../model/types'
import { MM_PER_IN } from '../model/types'

export type BoxJointKind = 'basic' | 'pro'

export const BOX_JOINT_TEMPLATES: Record<string, BoxJointKind> = { boxJointBasic: 'basic', boxJointPro: 'pro' }

export const boxJointKind = (templateId: unknown): BoxJointKind | undefined =>
  typeof templateId === 'string' ? BOX_JOINT_TEMPLATES[templateId] : undefined

/** Studio's bit tolerance: a pin is never narrower than 1.1 bit diameters. */
export const BIT_TOL = 1.1

/** Depth of the channel under the pocket floor, in bit diameters (bit + 20%). */
export const CHANNEL_DEPTH = 1.2

export type BoxJointParams = Record<string, number>

const num = (p: BoxJointParams, k: string, d: number) => (Number.isFinite(p[k]) ? p[k] : d)

/** The values the generators read, with fall-backs for missing keys. */
function read(p: BoxJointParams) {
  return {
    side: num(p, 'side', 0) === 1 ? 1 : 0,
    W: num(p, 'length', 254),
    T: num(p, 'thickness', 19.05),
    bit: num(p, 'bitDiameter', 6.35),
    N: Math.max(2, Math.round(num(p, 'fingers', 5))),
    ratio: num(p, 'pinFactor', -0.75),
    gap: Math.max(0, num(p, 'glueGap', 0)),
    guides: num(p, 'guides', 1) === 0 ? 0 : 1,
  }
}

/**
 * Studio's validation: every value outside its rule is replaced by the bound it broke (non-integer
 * pin counts are rounded), then the whole set is checked again until nothing changes.
 * MIN_SIZE (0.005) and EPS (1e-6) are in the document's units.
 */
export function clampBoxJoint(kind: BoxJointKind, p: BoxJointParams, units: Units = 'mm'): BoxJointParams {
  const u = units === 'in' ? MM_PER_IN : 1
  const MIN = 0.005 * u
  const EPS = 1e-6 * u
  const out: BoxJointParams = { ...p }
  const v = read(out)
  out.side = v.side
  out.guides = v.guides
  out.length = v.W
  out.thickness = v.T
  out.bitDiameter = v.bit
  out.fingers = num(out, 'fingers', 5)
  out.glueGap = num(out, 'glueGap', 0)
  if (kind === 'pro') out.pinFactor = v.ratio
  const clamp = (k: string, lo: number, hi: number) => {
    const x = out[k]
    if (x < lo) out[k] = lo
    else if (x > hi) out[k] = hi
  }
  for (let pass = 0; pass < 8; pass++) {
    const before = JSON.stringify(out)
    clamp('length', MIN, Infinity)
    clamp('thickness', MIN, Infinity)
    clamp('bitDiameter', MIN, Math.max(out.thickness, MIN))
    if (!Number.isInteger(out.fingers)) out.fingers = Math.round(out.fingers)
    // A tiny tolerance so W / (bit·1.1) landing on a whole number in doc units isn't lost to rounding in mm.
    clamp('fingers', 2, Math.max(2, Math.floor(out.length / (out.bitDiameter * BIT_TOL) + 1e-9)))
    if (kind === 'pro') clamp('pinFactor', -1, 1)
    const N = out.fingers
    if (kind === 'basic') clamp('glueGap', 0, out.length / N - EPS)
    else clamp('glueGap', 0, N - 1 <= 0 ? 0 : Math.max(0, (out.length - out.bitDiameter * BIT_TOL * N) / (N - 1) - EPS))
    if (JSON.stringify(out) === before) break
  }
  return out
}

/** Pro pin widths (Studio's computeSegments): pins 0, 2, 4… get `odd`, pins 1, 3… get `even`. */
export function proSegments(W: number, pins: number, bit: number, ratio: number): { widths: number[]; bounds: number[] } {
  const N = Math.max(1, Math.round(pins))
  const minW = bit * BIT_TOL
  const nOdd = Math.ceil(N / 2)
  const nEven = Math.floor(N / 2)
  const avg = W / N
  let odd: number
  let even: number
  if (ratio <= 0) {
    const t = ratio + 1
    const E = nEven > 0 ? (W - nOdd * minW) / nEven : minW
    odd = minW + t * (avg - minW)
    even = E + t * (avg - E)
  } else {
    const t = ratio
    const O = nOdd > 0 ? (W - nEven * minW) / nOdd : minW
    odd = avg + t * (O - avg)
    even = avg + t * (minW - avg)
  }
  const widths: number[] = []
  const bounds: number[] = []
  let x = 0
  for (let k = 0; k < N; k++) {
    const w = k % 2 === 0 ? odd : even
    widths.push(w)
    bounds.push(x)
    x += w
  }
  return { widths, bounds }
}

/** Nominal pin widths and left edges (Studio's 0..W frame). Basic pins are all W/N. */
export function pinSegments(kind: BoxJointKind, p: BoxJointParams): { widths: number[]; bounds: number[] } {
  const v = read(p)
  if (kind === 'pro') return proSegments(v.W, v.N, v.bit, v.ratio)
  const w = v.W / v.N
  return { widths: Array.from({ length: v.N }, () => w), bounds: Array.from({ length: v.N }, (_, k) => k * w) }
}

/** Pins the pocket cuts away: odd pins on side A, even pins on side B. */
export const pinRemoved = (side: number, k: number) => (side === 1 ? k % 2 === 0 : k % 2 === 1)
/** Pins that keep a guide: the complement of the removed ones. */
export const pinGuided = (side: number, k: number) => !pinRemoved(side, k)

/** Studio frame (y-up, stock at 0..W × 0..T) to ours (y-down, stock centred on 0,0). */
const toLocal = (W: number, T: number) => (q: Pt): Pt => ({ x: q.x - W / 2, y: T / 2 - q.y })

/** Points along the arc from a0 to a1 (radians, signed sweep), excluding the start. */
function arcPts(c: Pt, r: number, a0: number, sweep: number): Pt[] {
  const perQuarter = Math.max(8, Math.min(48, Math.ceil(r * 4)))
  const n = Math.max(2, Math.ceil((Math.abs(sweep) / (Math.PI / 2)) * perQuarter))
  const out: Pt[] = []
  for (let i = 1; i <= n; i++) {
    const a = a0 + (sweep * i) / n
    out.push({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a) })
  }
  return out
}

/** Round the convex corners of a closed polygon with radius r (concave corners stay sharp). */
export function filletConvex(pts: Pt[], r: number): Pt[] {
  const n = pts.length
  if (n < 3 || !(r > 0)) return pts
  let area = 0
  for (let i = 0; i < n; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    area += a.x * b.y - b.x * a.y
  }
  const orient = Math.sign(area)
  const out: Pt[] = []
  for (let i = 0; i < n; i++) {
    const A = pts[(i - 1 + n) % n]
    const P = pts[i]
    const B = pts[(i + 1) % n]
    const la = Math.hypot(P.x - A.x, P.y - A.y)
    const lb = Math.hypot(B.x - P.x, B.y - P.y)
    if (la < 1e-12 || lb < 1e-12) continue
    const din = { x: (P.x - A.x) / la, y: (P.y - A.y) / la }
    const dout = { x: (B.x - P.x) / lb, y: (B.y - P.y) / lb }
    const cross = din.x * dout.y - din.y * dout.x
    if (Math.abs(cross) < 1e-12 || cross * orient < 0) {
      out.push(P) // straight or concave: keep the sharp corner
      continue
    }
    // Interior angle θ between the edges; the arc touches each edge r/tan(θ/2) from the corner.
    const cosT = -(din.x * dout.x + din.y * dout.y)
    const theta = Math.acos(Math.max(-1, Math.min(1, cosT)))
    const t = Math.min(r / Math.tan(theta / 2), la, lb)
    const rr = t * Math.tan(theta / 2)
    const T1 = { x: P.x - din.x * t, y: P.y - din.y * t }
    const T2 = { x: P.x + dout.x * t, y: P.y + dout.y * t }
    const c = { x: T1.x - orient * din.y * rr, y: T1.y + orient * din.x * rr }
    const a0 = Math.atan2(T1.y - c.y, T1.x - c.x)
    let sweep = Math.atan2(T2.y - c.y, T2.x - c.x) - a0
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    out.push(T1, ...arcPts(c, rr, a0, sweep))
  }
  return out
}

/**
 * The pocket (Studio's buildPocketModel): one closed contour. Each removed pin rises r above the
 * board top and drops r below the board bottom (widened by the glue gap, centred on its nominal
 * pin), the floor between them sits r below the board, and a channel 1.2·bit deep (bit + 20%) runs under the
 * whole span. Convex corners are filleted with r = bit/2, concave ones stay sharp.
 */
export function boxJointPocket(kind: BoxJointKind, p: BoxJointParams): Contour[] {
  const v = read(p)
  const r = v.bit / 2
  const { widths, bounds } = pinSegments(kind, p)
  const pts: Pt[] = []
  let first = NaN
  let last = NaN
  for (let k = 0; k < v.N; k++) {
    if (!pinRemoved(v.side, k)) continue
    const c = bounds[k] + widths[k] / 2
    const half = (widths[k] + v.gap) / 2
    const x0 = c - half
    const x1 = c + half
    if (Number.isNaN(first)) first = x0
    last = x1
    pts.push({ x: x0, y: -r }, { x: x0, y: v.T + r }, { x: x1, y: v.T + r }, { x: x1, y: -r })
  }
  if (!pts.length) return []
  const bottom = -r - CHANNEL_DEPTH * v.bit
  pts.push({ x: last, y: bottom }, { x: first, y: bottom })
  // The start point (first, -r) sits on the straight run from the channel up to the first pin, so it stays a plain point.
  const loop = filletConvex(pts, r)
  const map = toLocal(v.W, v.T)
  return [{ closed: true, pts: loop.map(map) }]
}

/** Studio's guide letters, 50 × 80 units, y-up, drawn as open lines (closing point repeated). */
export const GUIDE_LETTERS: Record<'A' | 'B', [number, number][]> = {
  A: [
    [0, 0],
    [7.5, 30],
    [42.5, 30],
    [50, 0],
    [30, 80],
    [20, 80],
    [0, 0],
  ],
  B: [
    [0, 0],
    [30, 0],
    [48, 10],
    [48, 30],
    [30, 40],
    [0, 40],
    [30, 40],
    [45, 50],
    [45, 70],
    [30, 80],
    [0, 80],
    [0, 0],
  ],
}

export interface BoxJointGuide {
  /** Pin index (0-based). */
  pin: number
  /** Guide box: pin width × thickness, on the board. */
  rect: Contour
  /** The side letter, centred in the box, height min(pin width, T)/2. */
  letter: Contour
}

/** One guide per kept pin of this side; none when guides are hidden. Nominal pin widths, no glue gap. */
export function boxJointGuides(kind: BoxJointKind, p: BoxJointParams): BoxJointGuide[] {
  const v = read(p)
  if (v.guides === 0) return []
  const { widths, bounds } = pinSegments(kind, p)
  const map = toLocal(v.W, v.T)
  const src = GUIDE_LETTERS[v.side === 1 ? 'B' : 'A']
  const out: BoxJointGuide[] = []
  for (let k = 0; k < v.N; k++) {
    if (!pinGuided(v.side, k)) continue
    const x = bounds[k]
    const w = widths[k]
    const rect: Contour = {
      closed: true,
      pts: [
        { x, y: 0 },
        { x: x + w, y: 0 },
        { x: x + w, y: v.T },
        { x, y: v.T },
      ].map(map),
    }
    const s = (Math.min(w, v.T) / 80) * 0.5
    const ox = x + w / 2 - 25 * s
    const oy = v.T / 2 - 40 * s
    const letter: Contour = { closed: false, pts: src.map(([lx, ly]) => map({ x: ox + lx * s, y: oy + ly * s })) }
    out.push({ pin: k, rect, letter })
  }
  return out
}

/** The stock (board) rectangle in our local frame. */
export function stockRect(p: BoxJointParams): { minX: number; minY: number; maxX: number; maxY: number } {
  const v = read(p)
  return { minX: -v.W / 2, minY: -v.T / 2, maxX: v.W / 2, maxY: v.T / 2 }
}

export type StockAnchor = 'stock-bottom-left' | 'stock-top-left' | 'stock-top-right' | 'stock-bottom-right' | 'stock-center'

export const STOCK_ANCHORS: StockAnchor[] = ['stock-top-left', 'stock-top-right', 'stock-center', 'stock-bottom-left', 'stock-bottom-right']

export const DEFAULT_STOCK_ANCHOR: StockAnchor = 'stock-top-left'

export const isStockAnchor = (a: unknown): a is StockAnchor => typeof a === 'string' && (STOCK_ANCHORS as string[]).includes(a)

/** A stock anchor in our local frame (y-down: "top" is the board's top edge at y = -T/2). */
export function stockAnchorPoint(p: BoxJointParams, a: StockAnchor): Pt {
  const b = stockRect(p)
  switch (a) {
    case 'stock-bottom-left':
      return { x: b.minX, y: b.maxY }
    case 'stock-top-left':
      return { x: b.minX, y: b.minY }
    case 'stock-top-right':
      return { x: b.maxX, y: b.minY }
    case 'stock-bottom-right':
      return { x: b.maxX, y: b.maxY }
    case 'stock-center':
      return { x: 0, y: 0 }
  }
}

/**
 * Studio's getParametersAfterScale: the bit never scales. A uniform scale multiplies width,
 * thickness and glue gap; otherwise width and glue gap follow x and thickness follows y.
 * The caller clamps the result.
 */
export function scaleBoxJointParams(p: BoxJointParams, dx: number, dy: number): BoxJointParams {
  const v = read(p)
  if (Math.abs(dx - dy) < 0.001) return { ...p, length: v.W * dx, thickness: v.T * dx, glueGap: v.gap * dx }
  return { ...p, length: v.W * dx, thickness: v.T * dy, glueGap: v.gap * dx }
}
