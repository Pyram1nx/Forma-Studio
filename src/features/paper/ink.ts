// Ink extraction from a flattened (already perspective-corrected) paper image.
// Pipeline: grayscale -> remove uneven lighting (divide by the paper's own
// brightness, estimated with an edge-following grey-level closing) -> adaptive
// mean threshold with hysteresis -> clear margin -> remove specks -> optional
// 1px closing. Everything is plain TypeScript on typed arrays.
import { integralImage, boxMean } from './integral'
import { closeGray, morph } from './morph'

/** Reused integral-image buffer (avoids a multi-MB allocation per slider tick). */
let integralBuf: Uint32Array | null = null

export interface InkOptions {
  /** Pixels per mm of the flattened image. */
  ppm: number
  /** 0..100. Higher = more pixels count as ink. */
  sensitivity: number
  /** Fine offset added to the threshold constant C (gray levels, can be negative). */
  cOffset: number
  /** Ignore ink this close to the paper edge (mm). */
  marginMm: number
  /** Remove connected ink smaller than this (mm²). */
  minBlobMm2: number
  /** Apply a 3x3 closing to join tiny gaps. */
  closeGaps: boolean
}

/** Luma (BT.601-ish integer weights) of an RGBA image. */
export function grayFromImageData(img: ImageData): Uint8Array {
  const n = img.width * img.height
  const d = img.data
  const g = new Uint8Array(n)
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    g[i] = (d[j] * 77 + d[j + 1] * 150 + d[j + 2] * 29) >> 8
  }
  return g
}

/** Noise floor for the ink tests: a pixel must be `k` noise sigmas darker. */
export interface NoiseFloor {
  /** Noise sigma of the (denoised) grayscale, in gray levels. */
  sigma: number
  /** Paper background the image was normalised by: noise in `norm` scales with 255 / bg. */
  bg: Uint8Array
  k: number
}

/**
 * Ink test on the lighting-normalised image. A pixel is ink when it is darker than
 * its local window mean by more than C gray levels (adaptive term, keeps faint
 * pen lines), OR darker than 255 - G (global term, so solid fills whose interior
 * matches their own local mean are still inked). With a noise floor, both
 * demands rise to at least k sigma of the local noise: dividing by a dim
 * background (a shadow, a dark photo) amplifies the noise there too.
 */
export function adaptiveMask(norm: Uint8Array, w: number, h: number, radius: number, C: number, G: number, noise?: NoiseFloor): Uint8Array {
  integralBuf = integralImage(norm, w, h, integralBuf ?? undefined)
  const S = integralBuf
  const mask = new Uint8Array(w * h)
  const globalLimit = 255 - G
  const kn = noise ? noise.k * noise.sigma * 255 : 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = norm[i]
      const floor = noise ? kn / Math.max(noise.bg[i], 1) : 0
      if (v < globalLimit && 255 - v > floor) {
        mask[i] = 1
        continue
      }
      const mean = boxMean(S, w, h, x, y, radius)
      mask[i] = v < mean - Math.max(C, floor) ? 1 : 0
    }
  }
  return mask
}

/** Clear everything within `px` pixels of the image edge. */
export function clearBorder(mask: Uint8Array, w: number, h: number, px: number): void {
  if (px <= 0) return
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (x < px || y < px || x >= w - px || y >= h - px) mask[y * w + x] = 0
    }
  }
}

/**
 * Connected-component labelling (iterative flood fill, no recursion so large
 * images cannot overflow the stack). Label 0 = background, labels start at 1.
 * `sizes[label]` is the pixel count of that component.
 */
export function labelComponents(
  mask: Uint8Array,
  w: number,
  h: number,
  eight: boolean,
): { labels: Int32Array; sizes: number[] } {
  const N = w * h
  const labels = new Int32Array(N)
  const sizes: number[] = [0]
  const stack = new Int32Array(N)
  let next = 1
  for (let s = 0; s < N; s++) {
    if (!mask[s] || labels[s]) continue
    let sp = 0
    stack[sp++] = s
    labels[s] = next
    let count = 0
    while (sp > 0) {
      const p = stack[--sp]
      count++
      const x = p % w
      const y = (p - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          if (!eight && dx !== 0 && dy !== 0) continue
          const nx = x + dx
          if (nx < 0 || nx >= w) continue
          const q = ny * w + nx
          if (mask[q] && !labels[q]) {
            labels[q] = next
            stack[sp++] = q
          }
        }
      }
    }
    sizes.push(count)
    next++
  }
  return { labels, sizes }
}

/** Remove connected ink components with fewer than `minPx` pixels. */
export function removeSpecks(mask: Uint8Array, w: number, h: number, minPx: number): void {
  if (minPx <= 1) return
  const { labels, sizes } = labelComponents(mask, w, h, true)
  for (let i = 0; i < mask.length; i++) {
    const l = labels[i]
    if (l && sizes[l] < minPx) mask[i] = 0
  }
}

/** 3x3 dilation or erosion. Out-of-image pixels count as background. */
function morph3(src: Uint8Array, w: number, h: number, dilate: boolean): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          const ny = y + dy
          const s = nx < 0 || ny < 0 || nx >= w || ny >= h ? 0 : src[ny * w + nx]
          if (dilate) v |= s
          else v &= s
        }
      }
      out[y * w + x] = v
    }
  }
  return out
}

/** Morphological closing (dilate then erode) to bridge 1px gaps. */
export function closeGaps(mask: Uint8Array, w: number, h: number): Uint8Array {
  return morph3(morph3(mask, w, h, true), w, h, false)
}

/**
 * Robust paper level and noise estimate of a lighting-normalised image. The
 * paper level is the 80th percentile (the sheet fills most of the frame and is
 * the brightest thing in it); the noise sigma is a median-absolute-deviation
 * over the brighter half, which shadows and ink barely influence.
 */
export function paperLevelAndNoise(norm: Uint8Array): { paper: number; sigma: number } {
  const hist = new Uint32Array(256)
  for (let i = 0; i < norm.length; i++) hist[norm[i]]++
  let acc = 0
  let paper = 255
  const target = norm.length * 0.8
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= target) {
      paper = Math.max(v, 1)
      break
    }
  }
  // MAD of pixels within 60 levels of the paper level.
  const devs = new Uint8Array(norm.length)
  let cnt = 0
  for (let i = 0; i < norm.length; i++) {
    const d = paper - norm[i]
    if (d < 0 || d > 60) continue
    devs[cnt++] = d
  }
  const med = () => {
    if (!cnt) return 0
    const bucket = new Uint32Array(61)
    for (let i = 0; i < cnt; i++) bucket[devs[i]]++
    let a = 0
    for (let v = 0; v < 61; v++) {
      a += bucket[v]
      if (a >= cnt / 2) return v
    }
    return 0
  }
  const medDev = med()
  // Second pass around the median for a true MAD sigma.
  let a2 = 0
  let sigma = medDev
  if (cnt) {
    const bucket = new Uint32Array(122)
    for (let i = 0; i < cnt; i++) bucket[Math.min(121, Math.abs(devs[i] - medDev))]++
    for (let v = 0; v < 122; v++) {
      a2 += bucket[v]
      if (a2 >= cnt / 2) {
        sigma = v
        break
      }
    }
  }
  return { paper, sigma: Math.max(1.4826 * sigma, 1) }
}

/**
 * Hysteresis: strong pixels are certain ink; weak pixels only survive when they
 * connect to a strong region. Isolated weak blobs are camera noise and paper
 * texture — exactly what used to litter the result.
 */
function hysteresis(strong: Uint8Array, weak: Uint8Array, w: number, h: number): Uint8Array {
  const { labels, sizes } = labelComponents(weak, w, h, true)
  const keep = new Uint8Array(sizes.length)
  for (let i = 0; i < strong.length; i++) if (strong[i]) keep[labels[i]] = 1
  keep[0] = 0
  const out = new Uint8Array(strong.length)
  for (let i = 0; i < out.length; i++) out[i] = keep[labels[i]] ? 1 : 0
  return out
}

/** Pen strokes up to twice this wide (mm) are erased from the paper background. */
const INK_MAX_HALF_MM = 2.5

/**
 * A broad area darker than this fraction of the paper right around it is a
 * drawn fill, not a shadow: a shadow takes away at most about half the light,
 * while ink, marker and graphite sit far below that.
 */
const FILL_FRAC = 0.3

/** Fills narrower than twice this (mm) are judged against the paper around them. */
const FILL_REACH_MM = 20

/** Anything darker than this fraction of the page's paper level is a fill wherever it is. */
const FILL_ABS_FRAC = 0.2

/**
 * The paper's own brightness at every pixel, shadows included, ink excluded.
 * A grey-level closing erases every dark mark narrower than the kernel (pen
 * and pencil lines) yet follows a hard shadow edge exactly, step for step. A
 * blur cannot: it smears the bright side into the shadow, leaving a dark halo
 * along the edge that reads as a drawn line. Broad regions far darker than the
 * paper are fills, so there the background is the plain paper level and the
 * fill stays ink.
 */
export function paperBackground(gray: Uint8Array, w: number, h: number, ppm: number): Uint8Array {
  const env = closeGray(gray, w, h, Math.max(2, Math.round(INK_MAX_HALF_MM * ppm)))
  // The paper around each point: a much wider closing fills in anything dark
  // up to 2 * FILL_REACH_MM across. Judging fills against it (not against the
  // brightest paper on the page) keeps a deep shadow in a dim corner a shadow.
  const around = closeGray(env, w, h, Math.max(4, Math.round(FILL_REACH_MM * ppm)))
  const hist = new Uint32Array(256)
  for (let i = 0; i < env.length; i++) hist[env[i]]++
  let acc = 0
  let paper = 255
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc >= env.length * 0.85) {
      paper = Math.max(v, 1)
      break
    }
  }
  const absCut = paper * FILL_ABS_FRAC
  for (let i = 0; i < env.length; i++) {
    if (env[i] < around[i] * FILL_FRAC) env[i] = around[i]
    else if (env[i] < absCut) env[i] = paper
  }
  return env
}

/**
 * Noise sigma (gray levels) of an image: the robust spread (MAD) of each
 * pixel's difference from the mean of its (2r+1)² neighbourhood, sampled on a
 * grid. The neighbourhood is wider than the grain itself: in a flattened
 * photo the grain is a few pixels across (demosaicing, the camera's own
 * denoising, the perspective warp), and a 3x3 test would barely see it. Paper
 * dominates the samples, so strokes and edges are outliers and do not count.
 */
export function estimateNoise(gray: Uint8Array, w: number, h: number, r = 4): number {
  integralBuf = integralImage(gray, w, h, integralBuf ?? undefined)
  const S = integralBuf
  const hist = new Uint32Array(1024)
  let n = 0
  const k = (2 * r + 1) ** 2
  const corr = Math.sqrt(1 - 1 / k)
  for (let y = r; y < h - r; y += 3) {
    for (let x = r; x < w - r; x += 3) {
      const d = gray[y * w + x] - boxMean(S, w, h, x, y, r)
      hist[Math.min(1023, Math.round(Math.abs(d) * 4))]++
      n++
    }
  }
  let acc = 0
  for (let b = 0; b < 1024; b++) {
    acc += hist[b]
    if (acc >= n / 2) return (1.4826 * (b / 4)) / corr
  }
  return 0
}

/** Marks whose longest side is under this (mm) are dust or grit, not drawing. */
const SPECK_MM = 2.5

/** Solid dots (no hole in the middle) under this (mm) across are dust, not drawing. */
const DOT_MM = 4

/**
 * Trim pale ink that only rides along on real ink: hysteresis keeps any weak
 * pixel touching a strong one, so a smudge or a shadow fringe that touches a
 * line used to be traced as part of it. A pixel paler than `paleCut` (gray
 * levels below paper) is kept only within `reach` px of a properly dark one,
 * which still covers every stroke's own soft edge.
 */
function trimPaleHalo(mask: Uint8Array, norm: Uint8Array, w: number, h: number, paleCut: number, reach: number): void {
  if (paleCut <= 0) return
  const core = new Uint8Array(mask.length)
  for (let i = 0; i < mask.length; i++) if (mask[i] && 255 - norm[i] >= paleCut) core[i] = 1
  const near = morph(core, w, h, reach, true)
  for (let i = 0; i < mask.length; i++) if (!near[i]) mask[i] = 0
}

/** A kept ink blob is on average at least this many noise sigmas darker than the paper. */
const NOISE_SIGNIFICANCE = 6

/** Marks under SMALL_MM across must be this many sigmas dark (pen easily is; grain is not). */
const SMALL_MM = 5
const SMALL_SIGNIFICANCE = 10

/** 3x3 box mean (edges clamped), separable. */
function boxBlur3(src: Uint8Array, w: number, h: number): Uint8Array {
  const tmp = new Uint16Array(w * h)
  const out = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const r = y * w
    for (let x = 0; x < w; x++) tmp[r + x] = src[r + Math.max(0, x - 1)] + src[r + x] + src[r + Math.min(w - 1, x + 1)]
  }
  for (let y = 0; y < h; y++) {
    const a = Math.max(0, y - 1) * w
    const b = y * w
    const c = Math.min(h - 1, y + 1) * w
    for (let x = 0; x < w; x++) out[b + x] = Math.round((tmp[a + x] + tmp[b + x] + tmp[c + x]) / 9)
  }
  return out
}

/**
 * Drop ink components that are noise, not drawing:
 *   - specks smaller than `minPx`, marks under SPECK_MM across, and solid
 *     dots (dust, grit, a stray pen dab) under DOT_MM across. A small drawn
 *     circle is a ring with an empty middle, so it is not a dot;
 *   - grain: on average less than NOISE_SIGNIFICANCE noise sigmas darker than
 *     the paper (a clump of sensor noise only just clears the weak threshold,
 *     while even faint pencil is many sigmas dark), or less than
 *     SMALL_SIGNIFICANCE when the mark is under SMALL_MM across;
 *   - faint, compact blots (smudges, paper fibres, dirt): pale on average AND
 *     filling most of their bounding box, which a drawn line never does.
 */
function dropNoiseBlobs(
  mask: Uint8Array,
  norm: Uint8Array,
  gray: Uint8Array,
  bg: Uint8Array,
  sigma: number,
  w: number,
  h: number,
  minPx: number,
  ppm: number,
  grownPx: number,
): void {
  const { labels, sizes } = labelComponents(mask, w, h, true)
  const n = sizes.length
  const dark = new Float64Array(n)
  const sig = new Float64Array(n)
  const x0 = new Int32Array(n).fill(w)
  const y0 = new Int32Array(n).fill(h)
  const x1 = new Int32Array(n).fill(-1)
  const y1 = new Int32Array(n).fill(-1)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const l = labels[i]
      if (!l) continue
      dark[l] += 255 - norm[i]
      sig[l] += bg[i] - gray[i]
      if (x < x0[l]) x0[l] = x
      if (x > x1[l]) x1[l] = x
      if (y < y0[l]) y0[l] = y
      if (y > y1[l]) y1[l] = y
    }
  // Each denoising pass grew every mark by a pixel on each side.
  const speckPx = SPECK_MM * ppm + 2 * grownPx
  const dotPx = DOT_MM * ppm + 2 * grownPx
  const smallPx = SMALL_MM * ppm + 2 * grownPx
  // How full the middle third of each small mark's box is: solid dot vs ring.
  const mid = new Uint32Array(n)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const l = labels[y * w + x]
      if (!l) continue
      const bw = x1[l] - x0[l] + 1
      const bh = y1[l] - y0[l] + 1
      if (Math.max(bw, bh) >= dotPx) continue
      if (x >= x0[l] + bw / 3 && x < x1[l] + 1 - bw / 3 && y >= y0[l] + bh / 3 && y < y1[l] + 1 - bh / 3) mid[l]++
    }
  // Blots bigger than this are kept whatever they look like (a big pale fill
  // is drawn on purpose).
  const blotMaxPx = 120 * ppm * ppm
  const drop = new Uint8Array(n)
  for (let l = 1; l < n; l++) {
    const size = sizes[l]
    if (size < minPx) {
      drop[l] = 1
      continue
    }
    const bw = x1[l] - x0[l] + 1
    const bh = y1[l] - y0[l] + 1
    const midArea = Math.max(1, Math.round(bw / 3) * Math.round(bh / 3))
    if (Math.max(bw, bh) < speckPx || (Math.max(bw, bh) < dotPx && mid[l] > 0.6 * midArea)) {
      drop[l] = 1
      continue
    }
    if (size >= blotMaxPx) continue
    const meanDark = dark[l] / size / 255
    const meanSig = sig[l] / size / Math.max(sigma, 0.5)
    const fill = size / ((x1[l] - x0[l] + 1) * (y1[l] - y0[l] + 1))
    // Small marks must be clearly dark: a clump of grain can reach a few mm.
    const small = Math.max(bw, bh) < smallPx
    if (meanSig < (small ? SMALL_SIGNIFICANCE : NOISE_SIGNIFICANCE) || (meanDark < 0.24 && fill > 0.3)) drop[l] = 1
  }
  for (let i = 0; i < mask.length; i++) if (drop[labels[i]]) mask[i] = 0
}

/**
 * Lighting-normalised image: each pixel divided by the paper's own level there
 * (see paperBackground), so paper reads 255 in light and in shadow alike.
 */
export function normaliseLighting(gray: Uint8Array, w: number, h: number, ppm: number): Uint8Array {
  const bg = paperBackground(gray, w, h, ppm)
  const norm = new Uint8Array(gray.length)
  for (let i = 0; i < norm.length; i++) {
    const v = Math.round((gray[i] * 255) / Math.max(bg[i], 1))
    norm[i] = v > 255 ? 255 : v
  }
  return norm
}

/** Full ink mask (1 = ink) for a flattened grayscale image. */
export function buildInkMask(gray: Uint8Array, w: number, h: number, o: InkOptions): Uint8Array {
  const ppm = o.ppm
  // Denoise as much as the photo needs: nothing for a clean scan, one or two
  // 3x3 passes for a dim, grainy phone shot. Pen strokes are several pixels
  // wide, so they keep their darkness while per-pixel grain averages out.
  const sigma0 = estimateNoise(gray, w, h)
  const passes = sigma0 < 1.5 ? 0 : sigma0 < 4 ? 1 : 2
  let g = gray
  for (let k = 0; k < passes; k++) g = boxBlur3(g, w, h)
  // The noise that is left, measured, not assumed.
  const sEff = passes ? estimateNoise(g, w, h) : sigma0
  const bg = paperBackground(g, w, h, ppm)
  const norm = new Uint8Array(g.length)
  for (let i = 0; i < norm.length; i++) {
    const v = Math.round((g[i] * 255) / Math.max(bg[i], 1))
    norm[i] = v > 255 ? 255 : v
  }

  // Adaptive window about 15 mm wide.
  const winRadius = Math.max(2, Math.round(7.5 * ppm))
  // Sensitivity 100 -> C = 0 (very eager), 0 -> C = 36 (only very dark marks).
  // The offset can push C below zero; clamp so the adaptive term never inverts.
  const C = Math.max(0, 36 * (1 - o.sensitivity / 100) + o.cOffset)
  // Global term: anything darker than 255 - G is ink, so the interior of a
  // solid fill (whose local mean matches its own value) still counts.
  const G = 45 + 0.9 * o.sensitivity

  // Certain ink stands 5 noise sigmas clear of the paper; a weak pixel 2.5.
  const strong = adaptiveMask(norm, w, h, winRadius, C, G, { sigma: sEff, bg, k: 5 })
  // Weak test: half the adaptive demand, a softer global term. Noise pixels
  // pass this test one at a time; hysteresis then deletes any not anchored to
  // real ink. Shadow gradients are broad, so their local contrast stays below
  // even the weak adaptive term and they never enter the mask at all.
  const weak = C > 0 ? adaptiveMask(norm, w, h, winRadius, Math.max(2, C * 0.5), G * 0.6, { sigma: sEff, bg, k: 2.5 }) : strong
  let strongCount = 0
  for (let i = 0; i < strong.length; i++) strongCount += strong[i]
  // A pure-pencil photo has no strong anchors: fall back to the weak mask so
  // faint work is not thrown away wholesale.
  let mask = strongCount > gray.length * 0.001 ? hysteresis(strong, weak, w, h) : weak.slice()
  // (Solid fills need no special case: paperBackground keeps them dark in `norm`,
  // so the global term inks them.)

  clearBorder(mask, w, h, Math.round(o.marginMm * ppm))
  // "Pale" is relative to the detail setting: 16% below paper at the default,
  // nothing at full detail (then every faint mark counts).
  trimPaleHalo(mask, norm, w, h, Math.round(255 * 0.16 * Math.min(2, 2 * (1 - o.sensitivity / 100))), 2 + passes)
  dropNoiseBlobs(mask, norm, g, bg, sEff, w, h, o.minBlobMm2 * ppm * ppm, ppm, passes)
  if (o.closeGaps) mask = closeGaps(mask, w, h)
  return mask
}

/** Flattened paper with ink pixels tinted blue (for the preview). */
export function inkPreviewImage(flat: ImageData, mask: Uint8Array): ImageData {
  const out = new ImageData(flat.width, flat.height)
  out.data.set(flat.data)
  const d = out.data
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue
    const j = i * 4
    // Blend 85% toward the brand blue #2c65ff.
    d[j] = d[j] * 0.15 + 44 * 0.85
    d[j + 1] = d[j + 1] * 0.15 + 101 * 0.85
    d[j + 2] = d[j + 2] * 0.15 + 255 * 0.85
  }
  return out
}
