// Ink mask for an arbitrary image (logo, clip art, artwork, photo): there is
// no sheet of paper to normalise, so the whole image is split into "design"
// and "background" by one threshold on a per-pixel field:
//
//   transparent images  the alpha channel (the silhouette of what is drawn)
//   plain background    colour distance from the border's median colour, so a
//                       red logo on blue reads as well as black on white
//   anything else       darkness, flipped when the border is the dark side
//
// The threshold is Otsu's on that field, shifted by the detail slider. Small
// specks and pinholes are removed relative to the image size.
import { removeSpecks } from './ink'
import { otsuThreshold } from './detect'

export interface ImageMaskOptions {
  /** 1..100. Higher = more pixels count as part of the design. */
  detail: number
  /** Swap design and background. */
  invert: boolean
}

/** Share of pixels that must be see-through before alpha alone decides. */
const TRANSPARENT_FRAC = 0.01
/** Border pixels within this colour distance of the median count as background. */
const BORDER_NEAR = 48
/** Share of border pixels near the median for the background to count as plain. */
const BORDER_PLAIN = 0.6
/** Specks and holes smaller than this share of the image are dropped. */
const SPECK_FRAC = 2e-5

/** Median of a byte histogram. */
function histMedian(hist: Uint32Array, n: number): number {
  let acc = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc * 2 >= n) return v
  }
  return 255
}

/** Indexes of the image's outer ring of pixels. */
function borderIndexes(w: number, h: number): number[] {
  const out: number[] = []
  for (let x = 0; x < w; x++) {
    out.push(x)
    if (h > 1) out.push((h - 1) * w + x)
  }
  for (let y = 1; y < h - 1; y++) {
    out.push(y * w)
    if (w > 1) out.push(y * w + w - 1)
  }
  return out
}

/** One 3x3 box blur pass (edges clamped): softens JPEG noise and stair-steps. */
function blur3(src: Uint8Array, w: number, h: number): Uint8Array {
  const tmp = new Uint16Array(w * h)
  for (let y = 0; y < h; y++) {
    const r = y * w
    for (let x = 0; x < w; x++) {
      const a = src[r + (x > 0 ? x - 1 : x)]
      const c = src[r + (x < w - 1 ? x + 1 : x)]
      tmp[r + x] = a + src[r + x] + c
    }
  }
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const up = (y > 0 ? y - 1 : y) * w
    const dn = (y < h - 1 ? y + 1 : y) * w
    const r = y * w
    for (let x = 0; x < w; x++) out[r + x] = Math.round((tmp[up + x] + tmp[r + x] + tmp[dn + x]) / 9)
  }
  return out
}

/**
 * Per-pixel "design-ness" (0 = background, 255 = design) and how it was
 * measured. Exported for tests.
 */
export function designField(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): { field: Uint8Array; source: 'alpha' | 'colour' | 'dark' } {
  const n = w * h
  const field = new Uint8Array(n)

  let clear = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) clear++
  if (clear > n * TRANSPARENT_FRAC && clear < n) {
    for (let i = 0, j = 3; i < n; i++, j += 4) field[i] = rgba[j]
    return { field, source: 'alpha' }
  }

  // Background colour: the per-channel median of the border.
  const ring = borderIndexes(w, h)
  const hr = new Uint32Array(256)
  const hg = new Uint32Array(256)
  const hb = new Uint32Array(256)
  for (const i of ring) {
    hr[rgba[i * 4]]++
    hg[rgba[i * 4 + 1]]++
    hb[rgba[i * 4 + 2]]++
  }
  const br = histMedian(hr, ring.length)
  const bg = histMedian(hg, ring.length)
  const bb = histMedian(hb, ring.length)
  // Weighted RGB distance (rough perceptual weights), 0..~255.
  const dist = (j: number) => {
    const dr = rgba[j] - br
    const dg = rgba[j + 1] - bg
    const db = rgba[j + 2] - bb
    return Math.sqrt(0.3 * dr * dr + 0.59 * dg * dg + 0.11 * db * db)
  }
  let near = 0
  for (const i of ring) if (dist(i * 4) < BORDER_NEAR) near++
  if (near >= ring.length * BORDER_PLAIN) {
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      const d = Math.round(dist(j))
      field[i] = d > 255 ? 255 : d
    }
    return { field, source: 'colour' }
  }

  // Busy background (a photo): darkness, with the border's side as background.
  for (let i = 0, j = 0; i < n; i++, j += 4) field[i] = 255 - ((rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8)
  const t = otsuThreshold(field)
  let darkRing = 0
  for (const i of ring) if (field[i] > t) darkRing++
  if (darkRing * 2 > ring.length) for (let i = 0; i < n; i++) field[i] = 255 - field[i]
  return { field, source: 'dark' }
}

/** Threshold on the design field for a detail setting (50 = Otsu's split). */
export function fieldThreshold(field: Uint8Array, detail: number): number {
  const t0 = Math.min(240, Math.max(16, otsuThreshold(field)))
  const t = t0 * 2 ** ((50 - detail) / 30)
  return Math.min(250, Math.max(4, Math.round(t)))
}

/** Mask (1 = design) for an RGBA image. */
export function imageInkMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, o: ImageMaskOptions): Uint8Array {
  const { field: raw } = designField(rgba, w, h)
  const field = blur3(raw, w, h)
  const t = fieldThreshold(field, o.detail)
  const n = w * h
  const mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) mask[i] = (field[i] > t) !== o.invert ? 1 : 0
  const minPx = Math.max(6, Math.round(n * SPECK_FRAC))
  removeSpecks(mask, w, h, minPx)
  // Pinholes: specks of background inside the design.
  for (let i = 0; i < n; i++) mask[i] ^= 1
  removeSpecks(mask, w, h, minPx)
  for (let i = 0; i < n; i++) mask[i] ^= 1
  return mask
}
