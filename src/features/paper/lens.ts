// The camera's lens, calibrated from the Shaper Trace frame's dots while the
// user aims.
//
// A phone's live video is not lens-corrected the way its camera app's photos
// are: straight lines bow a little, more the further they are from the middle
// of the picture. In one shot of the frame every dot sits around its edge, at
// much the same distance from the middle, so the bow looks almost like a
// change of scale — the perspective fit swallows it, and the drawing in the
// middle (bowed by a different amount) comes out the wrong size.
//
// The bow belongs to the lens, the dots move through it: while aiming, the
// frame sits at many places and sizes in the picture. Every dot of every live
// frame is paired with its slot on the 9 mm grid (traceDots.ts); the one
// radial bow that lets all those frames be straight perspective views of the
// grid at once is the lens. The captured frame is straightened with it before
// it is measured.
//
// Model (radial, about the picture's centre, r in half-diagonals of the
// picture, so it holds at any resolution of the same stream):
//   straight = bowed * (1 + k1 r^2 + k2 r^4)
import { homographyLS, project, type SlotPair } from './traceDots'

export interface Lens {
  k1: number
  k2: number
}

export interface LensEstimate extends Lens {
  /**
   * Standard error of the lens's scale between the middle of the picture
   * and the dots (k1 r^2 + k2 r^4 at r = 0.75): what the drawing's size
   * depends on. 0.001 is 0.1%, 0.15 mm on 150 mm.
   */
  sigma: number
  /** Frames and dots it was solved from. */
  frames: number
  dots: number
  /** RMS of the dots off their grid (picture px at the frames' size) before / after. */
  rms0: number
  rms1: number
}

/** A lens is trusted once its scale is known to this (0.12%, ~0.2 mm on 150 mm). */
export const LENS_SIGMA_OK = 0.0012
/** Frames gathered before a solve is attempted. */
export const LENS_MIN_FRAMES = 8
/** Frames kept: the most varied views win a place (see `add`). */
const MAX_FRAMES = 64
/** Radius (half-diagonals) at which the scale's error is judged: about where the dots run. */
const R_JUDGE = 0.75

/** One live frame's dots, in the normalised picture (centre 0, half-diagonal 1). */
interface Frame {
  slots: { x: number; y: number }[]
  pts: { x: number; y: number }[]
  /** Half-diagonal in px, to report the residual in pixels. */
  s: number
  /** Where the dots sit in the picture, and how spread: for keeping varied views. */
  centre: { x: number; y: number }
  size: number
  /** Which camera session it came from (a stored frame is from an earlier one). */
  session: number
}

const norm = (W: number, H: number) => ({ cx: (W - 1) / 2, cy: (H - 1) / 2, s: Math.hypot(W, H) / 2 })

/** Scale change of the lens at radius r (half-diagonals). */
const scaleAt = (l: Lens, r: number) => l.k1 * r * r + l.k2 * r ** 4

/** Straighten a picture point (px) of a W x H picture. */
export function straightenPoint(p: { x: number; y: number }, W: number, H: number, lens: Lens): { x: number; y: number } {
  const { cx, cy, s } = norm(W, H)
  const x = (p.x - cx) / s
  const y = (p.y - cy) / s
  const r2 = x * x + y * y
  const f = 1 + lens.k1 * r2 + lens.k2 * r2 * r2
  return { x: cx + x * f * s, y: cy + y * f * s }
}

/** Where a straightened picture point (px) was in the bowed picture (Newton on the radius). */
export function bowPoint(p: { x: number; y: number }, W: number, H: number, lens: Lens): { x: number; y: number } {
  const { cx, cy, s } = norm(W, H)
  const x = (p.x - cx) / s
  const y = (p.y - cy) / s
  const ru = Math.hypot(x, y)
  if (ru < 1e-9) return { x: p.x, y: p.y }
  let r = ru
  for (let i = 0; i < 8; i++) {
    const r2 = r * r
    const g = r * (1 + lens.k1 * r2 + lens.k2 * r2 * r2) - ru
    const dg = 1 + 3 * lens.k1 * r2 + 5 * lens.k2 * r2 * r2
    const step = g / (Math.abs(dg) < 1e-6 ? 1e-6 : dg)
    r -= step
    if (Math.abs(step) < 1e-10) break
  }
  const k = r / ru
  return { x: cx + x * k * s, y: cy + y * k * s }
}

/**
 * Gathers the dots of live frames and solves the lens from them. Frames of
 * one stream only (one camera at one resolution and crop). The frames can be
 * stored and brought back next time (`toJSON` / `restore`), so every scan
 * adds views — near, far, off to the side — and the lens is pinned down
 * across the whole picture, its middle included, not just where the frame
 * happened to sit today.
 */
export class LensCalibrator {
  private frames: Frame[] = []
  private aspect = 0
  private session = 1

  get count(): number {
    return this.frames.length
  }

  /** Frames from this camera session (not brought back from storage). */
  get fresh(): number {
    return this.frames.filter((f) => f.session === this.session).length
  }

  clear(): void {
    this.frames = []
    this.aspect = 0
  }

  /** Add one live frame's dots (picture px of a W x H frame). Ignored with too few dots. */
  add(pairs: SlotPair[], W: number, H: number): void {
    if (pairs.length < 30) return
    // A different picture shape is a different crop of the sensor: start over.
    const aspect = Math.max(W, H) / Math.min(W, H)
    if (this.aspect && Math.abs(aspect - this.aspect) > 0.01) this.frames = []
    this.aspect = aspect
    const { cx, cy, s } = norm(W, H)
    this.push(
      pairs.map((q) => ({ x: q.u, y: q.v })),
      pairs.map((q) => ({ x: (q.x - cx) / s, y: (q.y - cy) / s })),
      s,
      this.session,
    )
  }

  private push(slots: { x: number; y: number }[], pts: { x: number; y: number }[], s: number, session: number) {
    let mx = 0
    let my = 0
    for (const p of pts) {
      mx += p.x
      my += p.y
    }
    mx /= pts.length
    my /= pts.length
    let size = 0
    for (const p of pts) size += Math.hypot(p.x - mx, p.y - my)
    size /= pts.length
    this.frames.push({ slots, pts, s, centre: { x: mx, y: my }, size, session })
    if (this.frames.length <= MAX_FRAMES) return
    // Full: drop one of the two most alike views (the older of them), so
    // the kept frames spread over as many places and sizes as were seen.
    let bi = 0
    let bd = Infinity
    const f = this.frames
    for (let i = 0; i < f.length; i++)
      for (let j = i + 1; j < f.length; j++) {
        const d = Math.hypot(f[i].centre.x - f[j].centre.x, f[i].centre.y - f[j].centre.y, f[i].size - f[j].size)
        if (d < bd) {
          bd = d
          bi = i
        }
      }
    f.splice(bi, 1)
  }

  /**
   * How varied the frames' views are (0..1): spread of where the frame sits
   * and how big it is in the picture. One fixed view still averages away the
   * dots' noise, but a moving view pins the bow down far better.
   */
  variety(): number {
    const f = this.frames
    if (f.length < 2) return 0
    const sd = (v: number[]) => {
      const m = v.reduce((a, b) => a + b, 0) / v.length
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
    }
    const spread = Math.hypot(sd(f.map((q) => q.centre.x)), sd(f.map((q) => q.centre.y))) + sd(f.map((q) => q.size))
    return Math.min(1, spread / 0.08)
  }

  /**
   * Solve the lens from the gathered frames (null with too few). Frames of
   * a view held still share much of their dots' error, so the standard error
   * is widened toward that of a single frame the less the view has moved.
   *
   * Frames brought back from storage are checked against today's: if today's
   * alone disagree clearly (another lens behind the same camera name, a
   * changed crop), the old ones are dropped.
   */
  solve(): LensEstimate | null {
    const old = this.frames.filter((f) => f.session !== this.session)
    const now = this.frames.filter((f) => f.session === this.session)
    if (old.length && now.length >= LENS_MIN_FRAMES * 2) {
      const a = this.solveSet(old)
      const b = this.solveSet(now)
      if (a && b) {
        const d = Math.abs(scaleAt(a, R_JUDGE) - scaleAt(b, R_JUDGE))
        if (d > 0.002 && d > 3 * Math.hypot(a.sigma, b.sigma)) this.frames = now
      }
    }
    return this.solveSet(this.frames)
  }

  private solveSet(frames: Frame[]): LensEstimate | null {
    const e = solveLens(frames)
    if (!e) return null
    const n = frames.length
    const sd = (v: number[]) => {
      const m = v.reduce((a, b) => a + b, 0) / v.length
      return Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length)
    }
    const spread = n < 2 ? 0 : Math.hypot(sd(frames.map((q) => q.centre.x)), sd(frames.map((q) => q.centre.y))) + sd(frames.map((q) => q.size))
    const independent = 1 + (n - 1) * Math.min(1, spread / 0.08)
    return { ...e, sigma: e.sigma * Math.sqrt(n / independent) }
  }

  /** The frames, compactly, for storage. */
  toJSON(): StoredFrames {
    return {
      aspect: +this.aspect.toFixed(4),
      frames: this.frames.map((f) => ({
        s: +f.s.toFixed(2),
        u: f.slots.flatMap((p) => [+p.x.toFixed(3), +p.y.toFixed(3)]),
        p: f.pts.flatMap((p) => [+p.x.toFixed(6), +p.y.toFixed(6)]),
      })),
    }
  }

  /** Bring back stored frames (from an earlier session) under this session's new ones. */
  restore(data: StoredFrames | null): void {
    if (!data || !Array.isArray(data.frames)) return
    if (this.aspect && Math.abs(data.aspect - this.aspect) > 0.01) return
    this.aspect = data.aspect
    this.session++
    const pairsOf = (v: number[]) => {
      const out: { x: number; y: number }[] = []
      for (let i = 0; i + 1 < v.length; i += 2) out.push({ x: v[i], y: v[i + 1] })
      return out
    }
    const now = this.frames
    this.frames = []
    for (const f of data.frames) {
      const slots = pairsOf(f.u)
      const pts = pairsOf(f.p)
      if (slots.length === pts.length && slots.length >= 30) this.push(slots, pts, f.s, this.session - 1)
    }
    for (const f of now) this.push(f.slots, f.pts, f.s, this.session)
  }
}

export interface StoredFrames {
  aspect: number
  frames: { s: number; u: number[]; p: number[] }[]
}

/** A lens worth straightening with: well pinned down and of a plausible size. */
export function trustedLens(e: LensEstimate | null): e is LensEstimate {
  return !!e && e.sigma <= LENS_SIGMA_OK && Math.abs(scaleAt(e, 1)) <= 0.2
}

/**
 * Every dot's offset from its slot (normalised units, x then y per dot) once
 * each frame is straightened by the lens and fitted with its own perspective.
 */
function residuals(frames: Frame[], lens: Lens): Float64Array | null {
  let n = 0
  for (const f of frames) n += f.pts.length * 2
  const out = new Float64Array(n)
  let o = 0
  for (const f of frames) {
    const st = f.pts.map((p) => {
      const r2 = p.x * p.x + p.y * p.y
      const k = 1 + lens.k1 * r2 + lens.k2 * r2 * r2
      return { x: p.x * k, y: p.y * k }
    })
    const Hm = homographyLS(f.slots, st)
    if (!Hm) return null
    for (let i = 0; i < st.length; i++) {
      const q = project(Hm, f.slots[i])
      out[o++] = st[i].x - q.x
      out[o++] = st[i].y - q.y
    }
  }
  return out
}

const sumSq = (v: Float64Array) => v.reduce((a, b) => a + b * b, 0)

/** Prior on k2 (standard deviation): keeps it sane when the views cannot tell it from k1. */
const K2_PRIOR = 0.15

/**
 * The radial bow (k1, k2) that best straightens every frame at once:
 * Gauss-Newton on the dots' offsets, each frame refitted with its own
 * perspective at every step (so the lens is only what no perspective can
 * explain). The covariance gives the scale's standard error.
 */
function solveLens(frames: Frame[]): LensEstimate | null {
  if (frames.length < LENS_MIN_FRAMES) return null
  const r0 = residuals(frames, { k1: 0, k2: 0 })
  if (!r0 || r0.length < 200) return null
  const nDots = r0.length / 2
  let k = [0, 0]
  let r = r0
  let sse = sumSq(r0)
  const prior = (kk: number[]) => (kk[1] / K2_PRIOR) ** 2
  let A: number[] = [1, 0, 0, 1]
  let s2 = sse / Math.max(1, r0.length)
  for (let it = 0; it < 8; it++) {
    const d = 1e-4
    const J = [0, 1].map((j) => {
      const kk = k.slice()
      kk[j] += d
      const rj = residuals(frames, { k1: kk[0], k2: kk[1] })!
      const col = new Float64Array(r.length)
      for (let i = 0; i < r.length; i++) col[i] = (rj[i] - r[i]) / d
      return col
    })
    let a00 = 0, a01 = 0, a11 = 0, g0 = 0, g1 = 0
    for (let i = 0; i < r.length; i++) {
      a00 += J[0][i] * J[0][i]
      a01 += J[0][i] * J[1][i]
      a11 += J[1][i] * J[1][i]
      g0 += J[0][i] * r[i]
      g1 += J[1][i] * r[i]
    }
    // The k2 prior, weighted by the dots' noise (so it is as strong as one
    // more observation of that size).
    s2 = sse / Math.max(1, r.length - 8 * frames.length - 2)
    a11 += s2 / K2_PRIOR ** 2
    g1 += (s2 / K2_PRIOR ** 2) * k[1]
    A = [a00, a01, a01, a11]
    const det = a00 * a11 - a01 * a01
    if (!(det > 0)) break
    let step = [-(a11 * g0 - a01 * g1) / det, -(-a01 * g0 + a00 * g1) / det]
    // Halve the step until it helps.
    let improved = false
    for (let h = 0; h < 6; h++) {
      const kk = [Math.max(-0.5, Math.min(0.5, k[0] + step[0])), Math.max(-0.5, Math.min(0.5, k[1] + step[1]))]
      const rr = residuals(frames, { k1: kk[0], k2: kk[1] })
      if (rr && sumSq(rr) + s2 * prior(kk) <= sse + s2 * prior(k)) {
        const small = Math.abs(kk[0] - k[0]) + Math.abs(kk[1] - k[1]) < 1e-6
        k = kk
        r = rr
        sse = sumSq(rr)
        improved = !small
        break
      }
      step = step.map((v) => v / 2)
    }
    if (!improved) break
  }
  // Covariance s2 A^-1; the scale at R_JUDGE is g = [R^2, R^4] . k.
  const det = A[0] * A[3] - A[1] * A[2]
  if (!(det > 0)) return null
  const inv = [A[3] / det, -A[1] / det, -A[2] / det, A[0] / det]
  const g = [R_JUDGE ** 2, R_JUDGE ** 4]
  const varScale = s2 * (g[0] * (inv[0] * g[0] + inv[1] * g[1]) + g[1] * (inv[2] * g[0] + inv[3] * g[1]))
  const px = (v: Float64Array) => {
    let e = 0
    let o = 0
    for (const f of frames)
      for (let i = 0; i < f.pts.length; i++, o += 2) e += (v[o] ** 2 + v[o + 1] ** 2) * f.s * f.s
    return Math.sqrt(e / nDots)
  }
  return {
    k1: k[0],
    k2: k[1],
    sigma: Math.sqrt(Math.max(0, varScale)),
    frames: frames.length,
    dots: nDots,
    rms0: px(r0),
    rms1: px(r),
  }
}

/**
 * Straighten a picture (RGBA, W x H) with the lens: each output pixel samples
 * the bowed picture where that straight point was (bilinear). The source
 * position is solved on a coarse grid and interpolated between, so a 4K frame
 * stays quick. The picture keeps its size; its middle keeps its scale.
 */
export function straightenRgba(src: Uint8ClampedArray, W: number, H: number, lens: Lens): Uint8ClampedArray {
  const out = new Uint8ClampedArray(W * H * 4)
  const G = 16
  const gw = Math.ceil(W / G) + 1
  const gh = Math.ceil(H / G) + 1
  const mapX = new Float32Array(gw * gh)
  const mapY = new Float32Array(gw * gh)
  for (let j = 0; j < gh; j++)
    for (let i = 0; i < gw; i++) {
      const q = bowPoint({ x: i * G, y: j * G }, W, H, lens)
      mapX[j * gw + i] = q.x
      mapY[j * gw + i] = q.y
    }
  for (let y = 0; y < H; y++) {
    const gy = y / G
    const j0 = Math.floor(gy)
    const fy = gy - j0
    for (let x = 0; x < W; x++) {
      const gx = x / G
      const i0 = Math.floor(gx)
      const fx = gx - i0
      const a = j0 * gw + i0
      const sx = (mapX[a] * (1 - fx) + mapX[a + 1] * fx) * (1 - fy) + (mapX[a + gw] * (1 - fx) + mapX[a + gw + 1] * fx) * fy
      const sy = (mapY[a] * (1 - fx) + mapY[a + 1] * fx) * (1 - fy) + (mapY[a + gw] * (1 - fx) + mapY[a + gw + 1] * fx) * fy
      // Clamp to the picture (the straightened corners reach a little past it).
      const X = Math.max(0, Math.min(W - 1.001, sx))
      const Y = Math.max(0, Math.min(H - 1.001, sy))
      const x0 = X | 0
      const y0 = Y | 0
      const u = X - x0
      const v = Y - y0
      const p00 = (y0 * W + x0) * 4
      const p10 = p00 + 4
      const p01 = p00 + W * 4
      const p11 = p01 + 4
      const o = (y * W + x) * 4
      for (let c = 0; c < 3; c++)
        out[o + c] = (src[p00 + c] * (1 - u) + src[p10 + c] * u) * (1 - v) + (src[p01 + c] * (1 - u) + src[p11 + c] * u) * v
      out[o + 3] = 255
    }
  }
  return out
}

/** Straighten a canvas with the lens (a new canvas of the same size). */
export function straightenCanvas(c: HTMLCanvasElement, lens: Lens): HTMLCanvasElement {
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) return c
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const out = document.createElement('canvas')
  out.width = c.width
  out.height = c.height
  const octx = out.getContext('2d')
  if (!octx) return c
  const data = octx.createImageData(c.width, c.height)
  data.data.set(straightenRgba(img.data, c.width, c.height, lens))
  octx.putImageData(data, 0, 0)
  return out
}

/* Remembered per camera, so the next scan starts out calibrated. */

const STORE = 'forma-trace-lens-v2'

export function lensKey(label: string, W: number, H: number): string {
  return `${label || 'camera'}|${(Math.max(W, H) / Math.min(W, H)).toFixed(2)}`
}

export function loadLensFrames(key: string): StoredFrames | null {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, StoredFrames>
    return all[key] ?? null
  } catch {
    return null
  }
}

export function saveLensFrames(key: string, cal: LensCalibrator): void {
  try {
    const all = JSON.parse(localStorage.getItem(STORE) ?? '{}') as Record<string, StoredFrames>
    all[key] = cal.toJSON()
    localStorage.setItem(STORE, JSON.stringify(all))
  } catch {
    /* private mode / full: just not remembered */
  }
}
