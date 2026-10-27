// Paper sizes and the true aspect ratio of a photographed sheet.
//
// A photo of a rectangle is a perspective quad whose edge lengths lie about the
// sheet's proportions (the far edge looks short). The camera's focal length can
// be recovered from the quad itself (Zhang & He, "Whiteboard scanning and image
// enhancement", 2007): with the principal point at the image centre and square
// pixels, the two vanishing directions of a rectangle must be orthogonal, which
// pins f. With f known, the sheet's real width / height ratio follows, and that
// ratio picks the paper family (ISO A, Letter, Legal, Tabloid, Shaper Trace).
import type { Pt } from '../../model/types'

/** What the drawing was photographed on. */
export type SheetKind = 'paper' | 'trace'

export interface PaperPreset {
  id: string
  label: string
  /** Portrait size in mm (w <= h). Custom uses the user's inputs. */
  w: number
  h: number
}

export const PRESETS: PaperPreset[] = [
  { id: 'a3', label: 'A3', w: 297, h: 420 },
  { id: 'a4', label: 'A4', w: 210, h: 297 },
  { id: 'a5', label: 'A5', w: 148, h: 210 },
  { id: 'letter', label: 'US Letter', w: 215.9, h: 279.4 },
  { id: 'legal', label: 'US Legal', w: 215.9, h: 355.6 },
  { id: 'tabloid', label: 'Tabloid', w: 279.4, h: 431.8 },
  { id: 'custom', label: 'Custom', w: 0, h: 0 },
]

/**
 * Shaper Trace frame: 338 x 248 mm outside, with a 263 x 173 mm capture window.
 * The window is what gets detected and flattened, so it sets the scale.
 */
export const TRACE_FRAME = { label: 'Shaper Trace', w: 173, h: 263, outerW: 248, outerH: 338 }

/** Long / short ratio of the Shaper Trace window (1.520). */
export const TRACE_ASPECT = TRACE_FRAME.h / TRACE_FRAME.w

/** A family shares one aspect ratio; ISO A sizes all share 1:sqrt(2). */
const FAMILIES: { ids: string[]; aspect: number }[] = [
  { ids: ['a4', 'a3', 'a5'], aspect: Math.SQRT2 },
  { ids: ['letter'], aspect: 279.4 / 215.9 },
  { ids: ['legal'], aspect: 355.6 / 215.9 },
  { ids: ['tabloid'], aspect: 431.8 / 279.4 },
]

/** Long / short ratios of every known sheet. */
export const KNOWN_ASPECTS = FAMILIES.map((f) => f.aspect)

/** A perspective-corrected ratio within this relative error matches a family. */
const MATCH_TOL = 0.045

export interface AspectEstimate {
  /** Real width / height of the sheet (TL->TR over TL->BL). */
  ratio: number
  /** Focal length (px) the estimate used. */
  focal: number
  /** True when f came from the quad itself, false when a typical phone lens was assumed. */
  measured: boolean
}

/**
 * True width / height of the rectangle photographed as `quad` (TL TR BR BL) in
 * a w x h image. Falls back to a typical phone lens (horizontal FOV ~70°) when
 * the quad is too close to a parallelogram to measure the focal length.
 */
export function estimateAspect(quad: Pt[], w: number, h: number): AspectEstimate {
  const u0 = w / 2
  const v0 = h / 2
  // Zhang & He order: m1 = (0,0), m2 = (W,0), m3 = (0,H), m4 = (W,H).
  const m = (p: Pt): [number, number, number] => [p.x - u0, p.y - v0, 1]
  const m1 = m(quad[0])
  const m2 = m(quad[1])
  const m4 = m(quad[2])
  const m3 = m(quad[3])
  const crossV = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const c14 = crossV(m1, m4)
  const k2 = dot(c14, m3) / dot(crossV(m2, m4), m3)
  const k3 = dot(c14, m2) / dot(crossV(m3, m4), m2)
  const n2 = [k2 * m2[0] - m1[0], k2 * m2[1] - m1[1], k2 * m2[2] - m1[2]]
  const n3 = [k3 * m3[0] - m1[0], k3 * m3[1] - m1[1], k3 * m3[2] - m1[2]]

  const long = Math.max(w, h)
  const prior = 0.75 * long
  let focal = prior
  let measured = false
  const denom = n2[2] * n3[2]
  // n_z ~ 0 means that pair of edges is parallel in the photo: no vanishing
  // point, so it says nothing about f.
  const scale = Math.hypot(n2[0], n2[1]) * Math.hypot(n3[0], n3[1]) / (long * long)
  if (Math.abs(denom) > 1e-6 * Math.max(scale, 1e-12)) {
    const f2 = -(n2[0] * n3[0] + n2[1] * n3[1]) / denom
    if (f2 > 0) {
      const f = Math.sqrt(f2)
      // Phone and camera lenses sit well inside 0.35x..4x the long side.
      if (f > 0.35 * long && f < 4 * long) {
        focal = f
        measured = true
      }
    }
  }
  const len2 = (n: number[]) => (n[0] * n[0] + n[1] * n[1]) / (focal * focal) + n[2] * n[2]
  const ratio = Math.sqrt(len2(n2) / Math.max(1e-12, len2(n3)))
  if (!Number.isFinite(ratio) || ratio <= 0) {
    const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y)
    const r = (d(quad[0], quad[1]) + d(quad[3], quad[2])) / Math.max(1e-9, d(quad[0], quad[3]) + d(quad[1], quad[2]))
    return { ratio: r, focal: prior, measured: false }
  }
  return { ratio, focal, measured }
}

/** Long / short form of a width / height ratio. */
export const longShort = (ratio: number) => (ratio >= 1 ? ratio : 1 / ratio)

/**
 * Plausibility weight (0..1] of a quad's true aspect for the sheet kind. A
 * Shaper Trace window has one exact ratio, so it is a strong prior; plain
 * paper only gets a mild nudge toward standard sizes.
 */
export function aspectPrior(ratio: number, kind: SheetKind): number {
  const a = longShort(ratio)
  if (kind === 'trace') {
    const e = a / TRACE_ASPECT - 1
    return 0.15 + 0.85 * Math.exp(-((e / 0.06) ** 2))
  }
  let e = Infinity
  for (const k of KNOWN_ASPECTS) e = Math.min(e, Math.abs(a / k - 1))
  return 0.8 + 0.2 * Math.exp(-((e / 0.05) ** 2))
}

export interface PaperGuess {
  /** Preset id, or 'custom' when no standard size fits. */
  presetId: string
  landscape: boolean
  /** Long / short ratio that was measured. */
  aspect: number
}

/**
 * Standard sheet whose proportions match the measured ratio. A photo cannot
 * tell A3 from A4 (same shape), so an ISO match keeps the current A size, or
 * A4. No match within tolerance means a custom size.
 */
export function guessPaper(ratio: number, currentId: string): PaperGuess {
  const aspect = longShort(ratio)
  const landscape = ratio > 1
  let best: (typeof FAMILIES)[number] | null = null
  let bestErr = MATCH_TOL
  for (const f of FAMILIES) {
    const e = Math.abs(aspect / f.aspect - 1)
    if (e < bestErr) {
      bestErr = e
      best = f
    }
  }
  if (!best) return { presetId: 'custom', landscape, aspect }
  return { presetId: best.ids.includes(currentId) ? currentId : best.ids[0], landscape, aspect }
}
