// Ink mask for an arbitrary image (logo, clip art, artwork, photo): there is
// no sheet of paper to normalise, so the whole image is split into "design"
// and "background" by one threshold on a per-pixel field:
//
//   transparent images  the alpha channel (the silhouette of what is drawn)
//   plain background    colour distance from the border's median colour, so a
//                       red logo on blue reads as well as black on white
//   multi-hue border    colour distance from the nearest dominant border
//                       colour (k-means clusters of the border), so a red
//                       flower reads against green foliage even where the two
//                       are equally bright
//   anything else       darkness, flipped when the border is the dark side
//
// The threshold is grounded in the background's own noise: border pixels are
// background samples, and a mark must stand that spread times a detail-scaled
// multiplier above them (plain and multi-hue backgrounds). Otsu's split stays
// for the paths without background samples (alpha, darkness). Small specks and
// pinholes are removed relative to the image size.
import { labelComponents, removeSpecks } from './ink'
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
const BORDER_NEAR = 55
/** Share of border pixels near the median for the background to count as plain. */
const BORDER_PLAIN = 0.85
/** Specks and holes smaller than this share of the image are dropped. */
const SPECK_FRAC = 2e-5
/** A border colour owning at least this share of the ring counts as background. */
const BG_SHARE = 0.08
/** k-means clusters for a border of mixed colours, and how many passes. */
const CLUSTERS = 7
const KMEANS_ITERS = 8
/** k-means samples every this-many-th pixel. */
const SAMPLE_STRIDE = 7

/** Plain Euclidean RGB distance: chroma counts in full, so yellow reads on
 * white and blue on red as clearly as black does (a luma-weighted distance
 * discounts the blue channel and loses them). */
function colourDist2(rgba: Uint8ClampedArray | Uint8Array, j: number, r: number, g: number, b: number): number {
  const dr = rgba[j] - r
  const dg = rgba[j + 1] - g
  const db = rgba[j + 2] - b
  return dr * dr + dg * dg + db * db
}

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

/** Median and MAD (robust spread) of a list of distances. */
function medianMad(samples: number[]): { m: number; s: number } {
  if (!samples.length) return { m: 0, s: 0 }
  const sorted = samples.slice().sort((a, b) => a - b)
  const m = sorted[sorted.length >> 1]
  const devs = sorted.map((v) => Math.abs(v - m)).sort((a, b) => a - b)
  return { m, s: 1.4826 * devs[devs.length >> 1] }
}

/** Multiplier on the background's noise spread for a detail setting: only the
 * boldest marks clear it at detail 1; near the background's own noise at 100. */
function noiseK(detail: number): number {
  return Math.max(2, Math.min(14, 14 * 2 ** (-detail / 30)))
}

/** Absolute floor of the grounded threshold. The spread and percentile terms
 * read zero on a pristine background, where the nearest stray pixel would
 * otherwise pass whatever remains; the floor keeps the detail slider honest —
 * at its low end only marks a real distance from the paper count as design. */
function thresholdFloor(detail: number): number {
  return 6 + 14 * 2 ** (-detail / 25)
}

/** The p-th percentile (0..1) of a sorted list. */
function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]
}

/**
 * Threshold for a field measured against background samples: median plus a
 * detail-scaled multiple of the background's own spread. Unlike Otsu's split,
 * which lands between the two loudest populations and drops every colour
 * fainter than them, this keeps any mark that measurably differs from the
 * background, faint colours included.
 *
 * Two guards on top of the median+MAD term: a high percentile of the ring's
 * own distances (the spread statistic reads zero when most of the background
 * sits exactly on the reference colour and only scattered pixels stray), and
 * an absolute floor that keeps single-pixel dust out.
 */
export function bgThreshold(bgSamples: number[], detail: number): number {
  const { m, s } = medianMad(bgSamples)
  const p = 0.98 - (0.13 * detail) / 100
  const t = Math.max(m + noiseK(detail) * s, percentile(bgSamples.slice().sort((a, b) => a - b), p))
  return Math.min(250, Math.max(thresholdFloor(detail), Math.round(t)))
}

/** Threshold on the design field for a detail setting (50 = Otsu's split). */
export function fieldThreshold(field: Uint8Array, detail: number): number {
  const t0 = Math.min(240, Math.max(16, otsuThreshold(field)))
  const t = t0 * 2 ** ((50 - detail) / 30)
  return Math.min(250, Math.max(4, Math.round(t)))
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
 * k-means over a strided sample of the image's colours. Deterministic: the
 * centres start evenly spaced through the sample list. Returns one centre per
 * cluster (an empty cluster keeps its previous centre).
 */
function kmeans(rgba: Uint8ClampedArray | Uint8Array, samples: number[]): Float64Array[] {
  const k = Math.min(CLUSTERS, Math.max(1, Math.floor(samples.length / 4)))
  const centres: Float64Array[] = []
  for (let c = 0; c < k; c++) {
    const j = samples[Math.floor((c * samples.length) / k)] * 4
    centres.push(Float64Array.from([rgba[j], rgba[j + 1], rgba[j + 2]]))
  }
  const sums = new Float64Array(k * 4)
  for (let it = 0; it < KMEANS_ITERS; it++) {
    sums.fill(0)
    for (const i of samples) {
      const j = i * 4
      let best = 0
      let bd = Infinity
      for (let c = 0; c < k; c++) {
        const d = colourDist2(rgba, j, centres[c][0], centres[c][1], centres[c][2])
        if (d < bd) {
          bd = d
          best = c
        }
      }
      sums[best * 4] += rgba[j]
      sums[best * 4 + 1] += rgba[j + 1]
      sums[best * 4 + 2] += rgba[j + 2]
      sums[best * 4 + 3]++
    }
    for (let c = 0; c < k; c++) {
      const n = sums[c * 4 + 3]
      if (n > 0) {
        centres[c][0] = sums[c * 4] / n
        centres[c][1] = sums[c * 4 + 1] / n
        centres[c][2] = sums[c * 4 + 2] / n
      }
    }
  }
  return centres
}

/**
 * Per-pixel "design-ness" (0 = background, 255 = design), how it was measured,
 * and — for the colour paths — the border distances the threshold is grounded
 * on. Exported for tests.
 */
export function designField(
  rgba: Uint8ClampedArray | Uint8Array,
  w: number,
  h: number,
): { field: Uint8Array; source: 'alpha' | 'colour' | 'cluster' | 'dark'; bgSamples?: number[] } {
  const n = w * h
  const field = new Uint8Array(n)

  let clear = 0
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] < 128) clear++
  if (clear > n * TRANSPARENT_FRAC && clear < n) {
    for (let i = 0, j = 3; i < n; i++, j += 4) field[i] = rgba[j]
    return { field, source: 'alpha' }
  }

  const ring = borderIndexes(w, h)

  // Background colour: the per-channel median of the border.
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
  let near = 0
  const ringDist: number[] = []
  for (const i of ring) {
    const d = Math.sqrt(colourDist2(rgba, i * 4, br, bg, bb))
    ringDist.push(d)
    if (d < BORDER_NEAR) near++
  }
  if (near >= ring.length * BORDER_PLAIN) {
    for (let i = 0, j = 0; i < n; i++, j += 4) field[i] = Math.min(255, Math.round(Math.sqrt(colourDist2(rgba, j, br, bg, bb))))
    return { field, source: 'colour', bgSamples: ringDist }
  }

  // Multi-hue border (foliage behind a flower, a photo): distance from the
  // nearest dominant border colour. Clusters owning a real share of the ring
  // are background; a pixel's design-ness is how far it sits from all of them.
  const samples: number[] = []
  for (let i = 0; i < n; i += SAMPLE_STRIDE) samples.push(i)
  const centres = kmeans(rgba, samples)
  const owned = new Uint32Array(centres.length)
  const nearest = new Int32Array(ring.length)
  const ringBgDist: number[] = []
  for (let r = 0; r < ring.length; r++) {
    const j = ring[r] * 4
    let best = 0
    let bd = Infinity
    for (let c = 0; c < centres.length; c++) {
      const d = colourDist2(rgba, j, centres[c][0], centres[c][1], centres[c][2])
      if (d < bd) {
        bd = d
        best = c
      }
    }
    nearest[r] = best
    owned[best]++
  }
  const isBg = centres.map((_, c) => owned[c] >= ring.length * BG_SHARE)
  if (isBg.some((v) => v)) {
    for (let r = 0; r < ring.length; r++) {
      if (!isBg[nearest[r]]) continue
      const c = centres[nearest[r]]
      ringBgDist.push(Math.sqrt(colourDist2(rgba, ring[r] * 4, c[0], c[1], c[2])))
    }
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      let bd = Infinity
      for (let c = 0; c < centres.length; c++) {
        if (!isBg[c]) continue
        const d = colourDist2(rgba, j, centres[c][0], centres[c][1], centres[c][2])
        if (d < bd) bd = d
      }
      field[i] = Math.min(255, Math.round(Math.sqrt(bd)))
    }
    return { field, source: 'cluster', bgSamples: ringBgDist }
  }

  // Busy border with no dominant colour (a cluttered photo): darkness, with
  // the border's side as background.
  for (let i = 0, j = 0; i < n; i++, j += 4) field[i] = 255 - ((rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8)
  const t = otsuThreshold(field)
  let darkRing = 0
  for (const i of ring) if (field[i] > t) darkRing++
  if (darkRing * 2 > ring.length) for (let i = 0; i < n; i++) field[i] = 255 - field[i]
  return { field, source: 'dark' }
}

/** Mask (1 = design) for an RGBA image. */
export function imageInkMask(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, o: ImageMaskOptions): Uint8Array {
  const { field: raw, bgSamples } = designField(rgba, w, h)
  // A grounded threshold sits near the background's own noise, so it is applied
  // to the raw field: blurring first would smear a third of every edge's height
  // into the first background pixel and fatten each boundary by about a pixel.
  // The Otsu paths keep the blur — it steadies the split, and their thresholds
  // sit mid-ramp, where the smear does not move the boundary.
  const field = bgSamples ? raw : blur3(raw, w, h)
  const t = bgSamples ? bgThreshold(bgSamples, o.detail) : fieldThreshold(field, o.detail)
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

/* ------------------------------------------------------------------ */
/* Colour layers (layered trace mode)                                  */
/* ------------------------------------------------------------------ */

export interface DesignLayer {
  /** 1 = this colour's pixels. */
  mask: Uint8Array
  /** The layer's colour, as #rrggbb. */
  color: string
  /** Pixel count, for stacking order. */
  size: number
}

/** k-means centres closer than this in RGB are one colour. */
const MERGE_DIST = 40

/** An enclosed hole of a layer is filled (the layer stays solid under the
 * piece drawn on top) when at least this share of its pixels belong to
 * another design colour; holes on the background stay holes and become
 * pieces of their own. */
const FILL_MAJORITY = 0.5

const hex2 = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')

/**
 * Split an image into its design colours, one mask per colour, for the layered
 * trace: every colour comes out as its own shapes and the background becomes
 * pieces wherever the design encloses it (eyes in a face). A semi-transparent
 * image takes transparency as the only background; an opaque one counts the
 * colours that own the border as background, like designField does. Each
 * layer stays solid wherever another colour covers it, so the piece below can
 * be cut without the piece above leaving holes in it.
 *
 * `detail` trims specks per layer: higher keeps smaller marks.
 */
export function designLayers(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number, detail: number): DesignLayer[] {
  const n = w * h
  const opaque = new Uint8Array(n)
  let nOpaque = 0
  let clear = 0
  for (let i = 0, j = 3; i < n; i++, j += 4) {
    if (rgba[j] >= 128) {
      opaque[i] = 1
      nOpaque++
    } else clear++
  }
  if (!nOpaque) return []
  const seeThrough = clear > n * TRANSPARENT_FRAC && clear < n

  // Palette over the opaque pixels.
  const samples: number[] = []
  for (let i = 0; i < n; i += SAMPLE_STRIDE) if (opaque[i]) samples.push(i)
  let centres = kmeans(rgba, samples)

  // Near-duplicate centres (an antialiasing ramp splitting one colour) merge.
  const merged: Float64Array[] = []
  for (const c of centres) {
    const near = merged.find((m) => Math.sqrt((m[0] - c[0]) ** 2 + (m[1] - c[1]) ** 2 + (m[2] - c[2]) ** 2) < MERGE_DIST)
    if (!near) merged.push(c)
  }
  centres = merged
  const k = centres.length

  // Assign every opaque pixel to its nearest centre (-1 for the see-through).
  const assign = new Int32Array(n).fill(-1)
  const owned = new Uint32Array(k)
  for (let i = 0; i < n; i++) {
    if (!opaque[i]) continue
    const j = i * 4
    let best = 0
    let bd = Infinity
    for (let c = 0; c < k; c++) {
      const d = colourDist2(rgba, j, centres[c][0], centres[c][1], centres[c][2])
      if (d < bd) {
        bd = d
        best = c
      }
    }
    assign[i] = best
    owned[best]++
  }

  // Background centres: those owning the border (opaque images); with real
  // transparency, transparency is the background and every colour is design.
  const isBg = new Uint8Array(k)
  if (!seeThrough) {
    const ring = borderIndexes(w, h)
    const ringOwned = new Uint32Array(k)
    for (const i of ring) if (assign[i] >= 0) ringOwned[assign[i]]++
    for (let c = 0; c < k; c++) if (ringOwned[c] >= ring.length * BG_SHARE) isBg[c] = 1
    if (isBg.every((v) => v)) isBg.fill(0) // degenerate: everything claims the border
  }

  const minPx = Math.max(6, Math.round(n * SPECK_FRAC)) * 2 ** ((50 - detail) / 25)
  const layers: DesignLayer[] = []
  for (let c = 0; c < k; c++) {
    if (isBg[c] || !owned[c]) continue
    const mask = new Uint8Array(n)
    for (let i = 0; i < n; i++) if (assign[i] === c) mask[i] = 1
    removeSpecks(mask, w, h, minPx)
    // Pinholes of background (or of another colour) inside this colour.
    for (let i = 0; i < n; i++) mask[i] ^= 1
    removeSpecks(mask, w, h, minPx)
    for (let i = 0; i < n; i++) mask[i] ^= 1
    // Wherever another design colour sits inside an enclosed hole of this
    // layer, fill the hole: the layer below stays solid under the one above.
    fillCoveredHoles(mask, assign, isBg, w, h)
    let size = 0
    for (let i = 0; i < n; i++) size += mask[i]
    if (!size) continue
    const cc = centres[c]
    layers.push({ mask, color: `#${hex2(cc[0])}${hex2(cc[1])}${hex2(cc[2])}`, size })
  }
  // Bottom (largest) first, so pieces stack in the order they were drawn.
  layers.sort((a, b) => b.size - a.size)
  return layers
}

/**
 * Fill the enclosed holes of `mask` whose pixels mostly belong to another
 * design colour (per the per-pixel palette assignment), and leave the ones
 * exposing the background: those become pieces of their own in the trace.
 */
function fillCoveredHoles(mask: Uint8Array, assign: Int32Array, isBg: Uint8Array, w: number, h: number): void {
  const inside = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) inside[i] = mask[i] ? 0 : 1
  const { labels } = labelComponents(inside, w, h, true)
  // Components touching the border are the surrounding background, not holes.
  const open = new Uint8Array(labels.length)
  for (let x = 0; x < w; x++) {
    open[labels[x]] = 1
    open[labels[(h - 1) * w + x]] = 1
  }
  for (let y = 0; y < h; y++) {
    open[labels[y * w]] = 1
    open[labels[y * w + w - 1]] = 1
  }
  open[0] = 1
  // Per-hole totals and design-pixel counts, then one filling pass.
  const total = new Uint32Array(labels.length)
  const design = new Uint32Array(labels.length)
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i]
    if (!l) continue
    total[l]++
    if (assign[i] >= 0 && !isBg[assign[i]]) design[l]++
  }
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i]
    if (l && !open[l] && design[l] > total[l] * FILL_MAJORITY) mask[i] = 1
  }
}
