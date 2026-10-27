// Lens lab: a synthetic phone camera with a bowed lens films the glove photo
// (t5) — live frames while "aiming", then the capture. The lens is calibrated
// from the live frames' dots, the capture straightened, and the glove
// measured: it should match the same capture through a perfect lens.
//   TRACE_LAB=1 npx vitest run tools/trace-lab/lens.test.ts
import { it as vitestIt } from 'vitest'
import { detectTraceFrame, slotPoints, TRACK_LONG, TRACK_SHORT } from '../../src/features/paper/traceDots'
import { LensCalibrator, straightenPoint, straightenRgba, type Lens } from '../../src/features/paper/lens'
import { computeHomography, applyHomography, warpPerspective } from '../../src/features/paper/homography'
import { buildInkMask, grayFromImageData } from '../../src/features/paper/ink'
import { vectorise } from '../../src/features/paper/trace'
import { decodeBmp, type RgbaImage } from './bmp'
import { encodePng } from './png'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const loadSample = (name: string): RgbaImage =>
  decodeBmp(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'samples', 'trace', name)).buffer as ArrayBuffer)

/** Box-downsample to long side <= max (as the live view does). */
function work(img: RgbaImage, max: number) {
  const k = Math.min(1, max / Math.max(img.width, img.height))
  const w = Math.round(img.width * k)
  const h = Math.round(img.height * k)
  const rgba = new Uint8ClampedArray(w * h * 4)
  const step = 1 / k
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const s = [0, 0, 0]
      let n = 0
      for (let sy = Math.floor(y * step); sy < Math.min(img.height, Math.floor((y + 1) * step)); sy++)
        for (let sx = Math.floor(x * step); sx < Math.min(img.width, Math.floor((x + 1) * step)); sx++) {
          const j = (sy * img.width + sx) * 4
          for (let c = 0; c < 3; c++) s[c] += img.data[j + c]
          n++
        }
      const i = (y * w + x) * 4
      for (let c = 0; c < 3; c++) rgba[i + c] = s[c] / Math.max(1, n)
      rgba[i + 3] = 255
    }
  return { rgba, w, h }
}

const it = vitestIt.runIf(!!process.env.TRACE_LAB)

class ImageDataPoly {
  data: Uint8ClampedArray
  width: number
  height: number
  constructor(w: number, h: number) {
    this.data = new Uint8ClampedArray(w * h * 4)
    this.width = w
    this.height = h
  }
}
;(globalThis as Record<string, unknown>).ImageData = ImageDataPoly

/** Seeded random. */
function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/**
 * Film the texture with a camera W x H whose lens bows by `lens`: the texture
 * sits at `quad` (its corners, in the straight picture), and each picture
 * pixel samples where its straight point lands on the texture.
 */
function film(tex: RgbaImage, W: number, H: number, quad: { x: number; y: number }[], lens: Lens): RgbaImage {
  const Hinv = computeHomography(quad, [
    { x: 0, y: 0 },
    { x: tex.width, y: 0 },
    { x: tex.width, y: tex.height },
    { x: 0, y: tex.height },
  ])
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const s = straightenPoint({ x, y }, W, H, lens)
      const t = applyHomography(Hinv, s.x, s.y)
      const j = (y * W + x) * 4
      data[j + 3] = 255
      if (t.x < 0 || t.y < 0 || t.x >= tex.width - 1 || t.y >= tex.height - 1) {
        data[j] = 90
        data[j + 1] = 80
        data[j + 2] = 70
        continue
      }
      const x0 = t.x | 0
      const y0 = t.y | 0
      const u = t.x - x0
      const v = t.y - y0
      const a = (y0 * tex.width + x0) * 4
      const b = a + tex.width * 4
      for (let c = 0; c < 3; c++)
        data[j + c] = (tex.data[a + c] * (1 - u) + tex.data[a + 4 + c] * u) * (1 - v) + (tex.data[b + c] * (1 - u) + tex.data[b + 4 + c] * u) * v
    }
  return { data, width: W, height: H }
}

/** The texture's corners placed in a W x H picture: scale (of the fitting size), shift, tilt. */
function pose(tex: RgbaImage, W: number, H: number, scale: number, dx: number, dy: number, jit: number[], rot: number) {
  const k = Math.min(W / tex.width, H / tex.height) * scale
  const hw = (tex.width * k) / 2
  const hh = (tex.height * k) / 2
  const c = Math.cos(rot)
  const s = Math.sin(rot)
  return [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y], i) => ({
    x: W / 2 + dx * W + x * c - y * s + jit[i * 2] * W,
    y: H / 2 + dy * H + x * s + y * c + jit[i * 2 + 1] * H,
  }))
}

async function measureGlove(img: RgbaImage) {
  const t = detectTraceFrame(img.data, img.width, img.height)
  if (!t) return null
  const ww = t.landscape ? 263 : 173
  const hh = t.landscape ? 173 : 263
  const ppm = 8
  const ow = ww * ppm
  const oh = hh * ppm
  const Hinv = computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], t.window)
  const flat = warpPerspective({ data: img.data, width: img.width, height: img.height } as unknown as ImageData, Hinv, ow, oh)
  const m = buildInkMask(grayFromImageData(flat as unknown as ImageData), ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
  const v = await vectorise(m, ow, oh, ppm, 'centerline')
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
  for (const g of v.groups) for (const c of g) for (const p of c.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
  return { w: x1 - x0, h: y1 - y0 }
}

const f2 = (v: number) => v.toFixed(2)

it('lens: calibrate from live frames, straighten the capture, measure the glove', async () => {
  const tex = loadSample('t5.bmp')!
  const W = 1920
  const H = 1080
  const out: string[] = []
  // Capture pose: frame centred, filling the view (as aimed).
  const capQuad = pose(tex, W, H, 0.98, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0], 0.01)
  const perfect = await measureGlove(film(tex, W, H, capQuad, { k1: 0, k2: 0 }))
  out.push(`perfect lens: glove ${f2(perfect!.w)} x ${f2(perfect!.h)}`)
  for (const k1 of [0.03, -0.03, 0.06]) {
    const lens = { k1, k2: 0 }
    const cap = film(tex, W, H, capQuad, lens)
    const bowed = await measureGlove(cap)
    for (const [label, wobble] of [['held still', 0.004], ['hand moving', 0.05]] as const) {
      const cal = new LensCalibrator()
      const rand = rng(7)
      for (let i = 0; i < 24; i++) {
        const r = () => (rand() - 0.5) * 2
        const q = pose(tex, W, H, 0.98 - Math.abs(r()) * wobble * 3, r() * wobble, r() * wobble, Array.from({ length: 8 }, () => r() * wobble * 0.3), r() * wobble)
        const live = work(film(tex, W, H, q, lens), 800)
        const t = detectTraceFrame(live.rgba, live.w, live.h, 800)
        if (t) cal.add(t.pairs, live.w, live.h)
      }
      const est = cal.solve()
      let fixed = null
      if (est) fixed = await measureGlove({ data: straightenRgba(cap.data, W, H, est), width: W, height: H })
      out.push(
        `k1 ${k1} ${label}: bowed glove ${f2(bowed!.w)} x ${f2(bowed!.h)} | est k1 ${est ? est.k1.toFixed(4) + ' ±' + est.sigma.toFixed(4) : '-'} frames ${cal.count} variety ${cal.variety().toFixed(2)} rms ${est ? f2(est.rms0) + '->' + f2(est.rms1) : '-'} | straightened glove ${fixed ? f2(fixed.w) + ' x ' + f2(fixed.h) : '-'}`,
      )
    }
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'out', 'lens.txt'), out.join('\n') + '\n')
}, 900000)

/**
 * A perfect Trace frame, drawn: black band 338 x 248 mm, white opening, white
 * dots of two sizes on the slots (about two in three filled), and a drawn
 * rectangle 150 x 100 mm (1.5 mm line) in the middle. 5 px/mm.
 */
function idealFrame(): RgbaImage {
  const ppm = 5
  const desk = 25
  const W = Math.round((338 + 2 * desk) * ppm)
  const H = Math.round((248 + 2 * desk) * ppm)
  const data = new Uint8ClampedArray(W * H * 4)
  const cx = W / 2
  const cy = H / 2
  const rand = rng(3)
  const dots = slotPoints(true).filter(() => rand() < 0.68).map((p) => ({
    x: cx + (p.x - TRACK_LONG / 2) * ppm,
    y: cy + (p.y - TRACK_SHORT / 2) * ppm,
    r: (rand() < 0.4 ? 1.8 : 1.15) * ppm,
  }))
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const mx = (x - cx) / ppm
      const my = (y - cy) / ppm
      let v = 120 // desk
      if (Math.abs(mx) <= 169 && Math.abs(my) <= 124) v = 22 // band
      if (Math.abs(mx) <= 135.6 && Math.abs(my) <= 91.1) {
        v = 235 // paper
        const ex = Math.abs(Math.abs(mx) - 75)
        const ey = Math.abs(Math.abs(my) - 50)
        if ((ex <= 0.75 && Math.abs(my) <= 50.75) || (ey <= 0.75 && Math.abs(mx) <= 75.75)) v = 30
      }
      const j = (y * W + x) * 4
      data[j] = data[j + 1] = data[j + 2] = v
      data[j + 3] = 255
    }
  for (const d of dots)
    for (let y = Math.floor(d.y - d.r - 1); y <= d.y + d.r + 1; y++)
      for (let x = Math.floor(d.x - d.r - 1); x <= d.x + d.r + 1; x++) {
        // Anti-aliased edge.
        const a = Math.max(0, Math.min(1, d.r + 0.5 - Math.hypot(x - d.x, y - d.y)))
        const j = (y * W + x) * 4
        const v = data[j] * (1 - a) + 240 * a
        data[j] = data[j + 1] = data[j + 2] = v
      }
  return { data, width: W, height: H }
}

it('lens: ideal frame — calibration unbiased, rectangle 150 x 100 mm', async () => {
  const tex = idealFrame()
  const W = 1920
  const H = 1080
  const out: string[] = []
  const capQuad = pose(tex, W, H, 1.05, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0], 0.01)
  const perfect = await measureGlove(film(tex, W, H, capQuad, { k1: 0, k2: 0 }))
  out.push(`perfect lens: rectangle ${f2(perfect!.w)} x ${f2(perfect!.h)}`)
  for (const k1 of [0, 0.03, -0.03, 0.06]) {
    const lens = { k1, k2: 0 }
    const cap = film(tex, W, H, capQuad, lens)
    const bowed = await measureGlove(cap)
    for (const [label, wobble] of [['held still', 0.004], ['hand moving', 0.05]] as const) {
      const cal = new LensCalibrator()
      const rand = rng(7)
      for (let i = 0; i < 24; i++) {
        const r = () => (rand() - 0.5) * 2
        const q = pose(tex, W, H, 1.05 - Math.abs(r()) * wobble * 3, r() * wobble, r() * wobble, Array.from({ length: 8 }, () => r() * wobble * 0.3), r() * wobble)
        const live = work(film(tex, W, H, q, lens), 800)
        const t = detectTraceFrame(live.rgba, live.w, live.h, 800)
        if (t) cal.add(t.pairs, live.w, live.h)
      }
      const est = cal.solve()
      let fixed = null
      if (est) fixed = await measureGlove({ data: straightenRgba(cap.data, W, H, est), width: W, height: H })
      out.push(
        `k1 ${k1} ${label}: bowed ${bowed ? f2(bowed.w) + ' x ' + f2(bowed.h) : '-'} | est k1 ${est ? est.k1.toFixed(4) + ' ±' + est.sigma.toFixed(4) : '-'} frames ${cal.count} variety ${cal.variety().toFixed(2)} rms ${est ? f2(est.rms0) + '->' + f2(est.rms1) : '-'} | straightened ${fixed ? f2(fixed.w) + ' x ' + f2(fixed.h) : '-'}`,
      )
    }
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'out', 'lens-ideal.txt'), out.join('\n') + '\n')
}, 900000)

it('lens: single-photo bow of each real sample', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    const t = detectTraceFrame(img.data, img.width, img.height)
    if (!t) {
      out.push(`t${i}: no frame`)
      continue
    }
    // Track size relative to the half-diagonal, and where its centre is.
    const s = Math.hypot(img.width, img.height) / 2
    const cx = t.track.reduce((a, p) => a + p.x, 0) / 4 / s - (img.width - 1) / 2 / s
    const cy = t.track.reduce((a, p) => a + p.y, 0) / 4 / s - (img.height - 1) / 2 / s
    const span = Math.max(...t.track.map((p) => Math.hypot(p.x - (img.width - 1) / 2, p.y - (img.height - 1) / 2))) / s
    const cal = new LensCalibrator()
    for (let k = 0; k < 8; k++) cal.add(t.pairs, img.width, img.height)
    const e = cal.solve()
    out.push(`t${i} ${img.width}x${img.height} dots ${t.pairs.length} corner r ${span.toFixed(2)} centre ${cx.toFixed(2)},${cy.toFixed(2)} | k1 ${e ? e.k1.toFixed(4) + ' ±' + (e.sigma * Math.sqrt(8)).toFixed(4) : '-'} rms ${e ? f2(e.rms0) + '->' + f2(e.rms1) : '-'}`)
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'out', 'lens-real.txt'), out.join('\n') + '\n')
}, 900000)

it('lens: glove photo straightened by its own bow', async () => {
  const img = loadSample('t5.bmp')
  const out: string[] = []
  for (const k1 of [0, 0.01, 0.0173, 0.025]) {
    const g = await measureGlove(k1 ? { data: straightenRgba(img.data, img.width, img.height, { k1, k2: 0 }), width: img.width, height: img.height } : img)
    out.push(`k1 ${k1}: glove ${g ? f2(g.w) + ' x ' + f2(g.h) : '-'} (truth 88.17 x 146.16)`)
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'out', 'lens-glove.txt'), out.join('\n') + '\n')
}, 900000)

it('lens: write the ideal frame (for the in-app camera check)', () => {
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'out', 'ideal-frame.png'), encodePng(idealFrame()))
})

it('lens: a lens with a 4th-order term — what a k1-only fit leaves', async () => {
  const tex = idealFrame()
  const W = 1920
  const H = 1080
  const out: string[] = []
  const capQuad = pose(tex, W, H, 1.05, 0, 0, [0, 0, 0, 0, 0, 0, 0, 0], 0.01)
  for (const lens of [{ k1: 0.03, k2: -0.04 }, { k1: -0.02, k2: 0.04 }, { k1: 0, k2: 0.05 }, { k1: 0.05, k2: 0 }]) {
    const cap = film(tex, W, H, capQuad, lens)
    const bowed = await measureGlove(cap)
    for (const [label, wobble, far] of [['held still', 0.004, 0], ['moving', 0.05, 0], ['moving + further away', 0.05, 0.45]] as const) {
      const cal = new LensCalibrator()
      const rand = rng(7)
      for (let i = 0; i < 30; i++) {
        const r = () => (rand() - 0.5) * 2
        const sc = 1.05 - Math.abs(r()) * wobble * 3 - (i % 3 === 2 ? far * rand() : 0)
        const q = pose(tex, W, H, sc, r() * wobble * (1 + far * 4), r() * wobble * (1 + far * 4), Array.from({ length: 8 }, () => r() * wobble * 0.3), r() * wobble)
        const live = work(film(tex, W, H, q, lens), 800)
        const t = detectTraceFrame(live.rgba, live.w, live.h, 800)
        if (t) cal.add(t.pairs, live.w, live.h)
      }
      const est = cal.solve()
      const fixed = est ? await measureGlove({ data: straightenRgba(cap.data, W, H, est), width: W, height: H }) : null
      out.push(`true ${lens.k1}/${lens.k2} ${label}: bowed ${f2(bowed!.w)} x ${f2(bowed!.h)} | est ${est ? est.k1.toFixed(4) + '/' + est.k2.toFixed(4) + ' ±' + est.sigma.toFixed(4) : '-'} frames ${cal.count} | fixed ${fixed ? f2(fixed.w) + ' x ' + f2(fixed.h) : '-'}`)
    }
  }
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'out', 'lens-k2.txt'), out.join('\n') + '\n')
}, 1800000)
