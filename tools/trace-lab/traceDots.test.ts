// Trace-frame lab: dot finding and frame fitting on real photos of a Shaper
// Trace frame (tools/trace-lab/samples/trace/*.bmp, local only). Writes
// overlays to tools/trace-lab/out/trace-*.png. Heavy, so it only runs on request:
//   TRACE_LAB=1 npx vitest run tools/trace-lab/traceDots.test.ts
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { it as vitestIt } from 'vitest'

const it = vitestIt.runIf(!!process.env.TRACE_LAB)
import { detectTraceFrame, traceFrameFromTrack, findDots, findRows, fitTrack, homographyLS, invert3, project } from '../../src/features/paper/traceDots'
import { warpPerspective } from '../../src/features/paper/homography'
import { estimateAspect } from '../../src/features/paper/paperSize'
import { decodeBmp, type RgbaImage } from './bmp'
import { encodePng } from './png'

const here = dirname(fileURLToPath(import.meta.url))
const samples = join(here, 'samples', 'trace')

/** Box-downsample RGBA to long side <= max; returns gray + rgba. */
export function work(img: RgbaImage, max: number) {
  const k = Math.min(1, max / Math.max(img.width, img.height))
  const w = Math.max(1, Math.round(img.width * k))
  const h = Math.max(1, Math.round(img.height * k))
  const gray = new Uint8Array(w * h)
  const rgba = new Uint8ClampedArray(w * h * 4)
  const step = 1 / k
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0
      let g = 0
      let b = 0
      let n = 0
      for (let sy = Math.floor(y * step); sy < Math.min(img.height, Math.floor((y + 1) * step) || 1); sy++)
        for (let sx = Math.floor(x * step); sx < Math.min(img.width, Math.floor((x + 1) * step) || 1); sx++) {
          const j = (sy * img.width + sx) * 4
          r += img.data[j]
          g += img.data[j + 1]
          b += img.data[j + 2]
          n++
        }
      if (!n) continue
      const i = y * w + x
      rgba[i * 4] = r / n
      rgba[i * 4 + 1] = g / n
      rgba[i * 4 + 2] = b / n
      rgba[i * 4 + 3] = 255
      gray[i] = (r / n * 77 + g / n * 150 + b / n * 29) >> 8
    }
  return { gray, rgba, w, h, k }
}

export function plot(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number, c: [number, number, number]) {
  const X = Math.round(x)
  const Y = Math.round(y)
  if (X < 0 || Y < 0 || X >= w || Y >= h) return
  const j = (Y * w + X) * 4
  rgba[j] = c[0]
  rgba[j + 1] = c[1]
  rgba[j + 2] = c[2]
}

export function ring(rgba: Uint8ClampedArray, w: number, h: number, x: number, y: number, r: number, c: [number, number, number]) {
  for (let k = 0; k < 64; k++) {
    const a = (k / 64) * Math.PI * 2
    plot(rgba, w, h, x + Math.cos(a) * r, y + Math.sin(a) * r, c)
  }
}

export function line(rgba: Uint8ClampedArray, w: number, h: number, a: { x: number; y: number }, b: { x: number; y: number }, c: [number, number, number]) {
  const n = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y))
  for (let i = 0; i <= n; i++) {
    const t = i / Math.max(1, n)
    for (const o of [-1, 0, 1]) plot(rgba, w, h, a.x + (b.x - a.x) * t + o, a.y + (b.y - a.y) * t, c)
  }
}

export function loadSample(name: string): RgbaImage | null {
  const p = join(samples, name)
  if (!existsSync(p)) return null
  return decodeBmp(readFileSync(p).buffer as ArrayBuffer)
}

it('trace dots: find the dots', () => {
  const lines: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const { gray, rgba, w, h } = work(img, 1600)
    const maxR = Math.max(5, Math.round(0.012 * Math.max(w, h)))
    const t0 = performance.now()
    const dots = findDots(gray, w, h, maxR)
    const ms = performance.now() - t0
    const rows = findRows(dots, gray, w, h)
    const fit = fitTrack(rows, w, h)
    for (const d of dots) ring(rgba, w, h, d.x, d.y, d.r + 3, [255, 0, 0])
    const cols: [number, number, number][] = [[0, 200, 255], [0, 255, 0], [255, 0, 255], [255, 200, 0], [120, 120, 255], [255, 120, 120], [120, 255, 200], [200, 200, 200]]
    rows.forEach((r, k) => r.dots.forEach((d) => ring(rgba, w, h, d.x, d.y, d.r + 6, cols[k % 8])))
    if (fit) for (let e = 0; e < 4; e++) line(rgba, w, h, fit.quad[e], fit.quad[(e + 1) % 4], [0, 255, 0])
    writeFileSync(join(here, 'out', `trace-t${i}-dots.png`), encodePng({ data: rgba, width: w, height: h }))
    lines.push(`t${i} ${w}x${h} maxR=${maxR} dots=${dots.length} rows=${rows.map((r) => r.dots.length).join('/')} fit=${fit ? fit.support + ' sides=' + fit.sides.map((r) => r.dots.length).join('/') + ' aspect=' + (() => { const e = estimateAspect(fit.quad, w, h); return e.ratio.toFixed(3) + (e.measured ? ' f' : ' prior') })() : 'none'} ${ms.toFixed(0)}ms`)
  }
  writeFileSync(join(here, 'out', 'trace-dots.txt'), lines.join('\n'))
  console.log(lines.join('\n'))
}, 120000)

import { computeHomography, applyHomography } from '../../src/features/paper/homography'

/** Assumed track size (mm), long x short, for the calibration pass. */
const TRACK_LONG = 302.9
const TRACK_SHORT = 212.9

for (const OUT of [false, true])
it(`trace dots: measure the ${OUT ? 'outer' : 'window'} edge from the dot track`, () => {
  const out: string[] = [OUT ? 'OUTER' : 'WINDOW']
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const { gray, w, h } = work(img, 1600)
    const maxR = Math.max(5, Math.round(0.012 * Math.max(w, h)))
    const fit = fitTrack(findRows(findDots(gray, w, h, maxR), gray, w, h), w, h)
    if (!fit) continue
    const q = fit.quad
    const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y)
    const landscape = d(q[0], q[1]) + d(q[3], q[2]) > d(q[0], q[3]) + d(q[1], q[2])
    const W = landscape ? TRACK_LONG : TRACK_SHORT
    const H = landscape ? TRACK_SHORT : TRACK_LONG
    const Hm = computeHomography([{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }], q)
    const at = (x: number, y: number) => {
      const p = applyHomography(Hm, x, y)
      const X = Math.round(p.x)
      const Y = Math.round(p.y)
      return X >= 0 && Y >= 0 && X < w && Y < h ? gray[Y * w + X] : -1
    }
    // For each side: march inward from the track, find the strongest rise (dark -> bright).
    const sides = [
      { name: 'top', p: (t: number, s: number) => [t * W, s] },
      { name: 'right', p: (t: number, s: number) => [W - s, t * H] },
      { name: 'bottom', p: (t: number, s: number) => [t * W, H - s] },
      { name: 'left', p: (t: number, s: number) => [s, t * H] },
    ]
    const res: string[] = []
    for (const side of sides) {
      const found: number[] = []
      for (let k = 0; k < 15; k++) {
        const t = 0.25 + (0.5 * k) / 14
        let best = 0
        let bestS = -1
        for (let s = 8; s <= 34; s += 0.25) {
          const ss = OUT ? -s : s
          const [x0, y0] = side.p(t, ss - (OUT ? -1 : 1))
          const [x1, y1] = side.p(t, ss + (OUT ? -1 : 1))
          const a = at(x0, y0)
          const b = at(x1, y1)
          if (a < 0 || b < 0) continue
          if (b - a > best) {
            best = b - a
            bestS = s
          }
        }
        if (best > 25) found.push(bestS)
      }
      found.sort((a, b) => a - b)
      res.push(`${side.name}=${found.length ? found[found.length >> 1].toFixed(2) : '-'}(${found.length})`)
    }
    out.push(`t${i} ${landscape ? 'L' : 'P'} ${res.join(' ')}`)
  }
  console.log(out.join('\n'))
}, 120000)

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

it('trace dots: full detection -> window, flattened', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const t0 = performance.now()
    const r = detectTraceFrame(img.data, img.width, img.height)
    const ms = performance.now() - t0
    if (!r) {
      out.push(`t${i} none`)
      continue
    }
    // Overlay: track (green) and window (blue) on a 1200 px copy.
    const v = work(img, 1200)
    const kk = v.w / img.width
    for (let e = 0; e < 4; e++) {
      line(v.rgba, v.w, v.h, { x: r.track[e].x * kk, y: r.track[e].y * kk }, { x: r.track[(e + 1) % 4].x * kk, y: r.track[(e + 1) % 4].y * kk }, [0, 255, 0])
      line(v.rgba, v.w, v.h, { x: r.window[e].x * kk, y: r.window[e].y * kk }, { x: r.window[(e + 1) % 4].x * kk, y: r.window[(e + 1) % 4].y * kk }, [0, 120, 255])
    }
    writeFileSync(join(here, 'out', `trace-t${i}-window.png`), encodePng({ data: v.rgba, width: v.w, height: v.h }))
    // Flatten the window at 3 px/mm.
    const ppm = 3
    const ow = Math.round((r.landscape ? 263 : 173) * ppm)
    const oh = Math.round((r.landscape ? 173 : 263) * ppm)
    const Hinv = computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], r.window)
    const src = new ImageDataPoly(img.width, img.height)
    src.data.set(img.data)
    const flat = warpPerspective(src as unknown as ImageData, Hinv, ow, oh)
    writeFileSync(join(here, 'out', `trace-t${i}-flat.png`), encodePng({ data: flat.data, width: ow, height: oh }))
    out.push(`t${i} ${r.landscape ? 'landscape' : 'portrait'} support=${r.support} ${ms.toFixed(0)}ms`)
  }
  console.log(out.join('\n'))
}, 120000)

it('trace dots: small sizes for the live preview', () => {
  const out: string[] = []
  for (const side of [1200, 800, 640, 480]) {
    const row: string[] = []
    for (let i = 1; i <= 7; i++) {
      const img = loadSample(`t${i}.bmp`)
      if (!img) continue
      const full = detectTraceFrame(img.data, img.width, img.height)
      const t0 = performance.now()
      const r = detectTraceFrame(img.data, img.width, img.height, side)
      const ms = performance.now() - t0
      if (!r || !full) {
        row.push(`t${i}:none`)
        continue
      }
      const diag = Math.hypot(img.width, img.height)
      const err = Math.max(...r.window.map((p, k) => Math.hypot(p.x - full.window[k].x, p.y - full.window[k].y))) / diag
      row.push(`t${i}:${(err * 100).toFixed(2)}%/${ms.toFixed(0)}ms`)
    }
    out.push(`${side}px ${row.join(' ')}`)
  }
  console.log(out.join('\n'))
}, 120000)

it('trace dots: dot layout along each side (track mm)', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const { gray, w, h } = work(img, 1600)
    const maxR = Math.max(5, Math.round(0.012 * Math.max(w, h)))
    const dots = findDots(gray, w, h, maxR)
    const black = dots.filter((d) => d.contrast / Math.max(1, d.v) >= 0.7)
    const fit = fitTrack(findRows(black.length >= 20 ? black : dots, gray, w, h), w, h)
    if (!fit) continue
    const q = fit.quad
    const tb = fit.sides[0].dots.length + fit.sides[2].dots.length
    const lr = fit.sides[1].dots.length + fit.sides[3].dots.length
    const landscape = tb > lr
    const W = landscape ? 302.9 : 212.9
    const H = landscape ? 212.9 : 302.9
    const Hinv = computeHomography(q, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }])
    // All dots near the track, in track mm, with size in mm.
    const pts = dots.map((d) => {
      const p = applyHomography(Hinv, d.x, d.y)
      const p2 = applyHomography(Hinv, d.x + d.r, d.y)
      return { x: p.x, y: p.y, r: Math.hypot(p2.x - p.x, p2.y - p.y) }
    }).filter((p) => Math.min(Math.abs(p.x), Math.abs(p.x - W), Math.abs(p.y), Math.abs(p.y - H)) < 4 && p.x > -8 && p.y > -8 && p.x < W + 8 && p.y < H + 8)
    const side = (name: string, sel: (p: { x: number; y: number }) => boolean, key: (p: { x: number; y: number }) => number) =>
      `${name}: ` + pts.filter(sel).sort((a, b) => key(a) - key(b)).map((p) => `${key(p).toFixed(1)}${p.r > 1.9 ? 'B' : 's'}`).join(' ')
    out.push(`t${i} ${landscape ? 'L' : 'P'} r=${pts.map((p) => p.r.toFixed(1)).slice(0, 12).join(',')}`)
    out.push('  ' + side('top', (p) => Math.abs(p.y) < 4, (p) => p.x))
    out.push('  ' + side('bottom', (p) => Math.abs(p.y - H) < 4, (p) => p.x))
    out.push('  ' + side('left', (p) => Math.abs(p.x) < 4, (p) => p.y))
    out.push('  ' + side('right', (p) => Math.abs(p.x - W) < 4, (p) => p.y))
  }
  writeFileSync(join(here, 'out', 'trace-layout.txt'), out.join('\n'))
  console.log(out.join('\n'))
}, 120000)

it('trace dots: slot grid (pitch, margins) per photo', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const { gray, w, h } = work(img, 1600)
    const maxR = Math.max(5, Math.round(0.012 * Math.max(w, h)))
    const dots = findDots(gray, w, h, maxR)
    const black = dots.filter((d) => d.contrast / Math.max(1, d.v) >= 0.7)
    const fit = fitTrack(findRows(black, gray, w, h), w, h) ?? fitTrack(findRows(dots, gray, w, h), w, h)
    if (!fit) { out.push(`t${i} none`); continue }
    const q = fit.quad
    const tb = fit.sides[0].dots.length + fit.sides[2].dots.length
    const lr = fit.sides[1].dots.length + fit.sides[3].dots.length
    const landscape = tb > lr
    const W = landscape ? 302.9 : 212.9
    const H = landscape ? 212.9 : 302.9
    const Hinv = computeHomography(q, [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }])
    const res: string[] = []
    fit.sides.forEach((s, k) => {
      const horizontal = k === 0 || k === 2
      const ts = s.dots.map((d) => { const p = applyHomography(Hinv, d.x, d.y); return horizontal ? p.x : p.y }).sort((a, b) => a - b)
      const len = horizontal ? W : H
      const long = Math.abs(len - 302.9) < 1
      // integer slots from approx pitch 9.03, then least squares t = a + b*k
      const k0 = ts.map((t) => Math.round((t - ts[0]) / 9.03))
      const n = ts.length
      const mk = k0.reduce((s2, v) => s2 + v, 0) / n
      const mt = ts.reduce((s2, v) => s2 + v, 0) / n
      let sxy = 0, sxx = 0
      for (let j = 0; j < n; j++) { sxy += (k0[j] - mk) * (ts[j] - mt); sxx += (k0[j] - mk) ** 2 }
      const b = sxy / sxx
      const a = mt - b * mk
      const resid = Math.max(...ts.map((t, j) => Math.abs(t - (a + b * k0[j]))))
      const first = a
      const last = a + b * Math.max(...k0)
      res.push(`${['T', 'R', 'B', 'L'][k]}${long ? 'long' : 'short'} p=${b.toFixed(3)} first=${(first / b).toFixed(2)}p lastgap=${((len - last) / b).toFixed(2)}p slots=${Math.max(...k0)} span=${(len / b).toFixed(2)}p res=${resid.toFixed(2)}`)
    })
    out.push(`t${i} ${landscape ? 'L' : 'P'}\n  ` + res.join('\n  '))
  }
  console.log(out.join('\n'))
}, 120000)

import { buildInkMask, grayFromImageData } from '../../src/features/paper/ink'
import { vectorise } from '../../src/features/paper/trace'

/** Bounding box (mm) of the glove traced from t5, for the ground truth 88.17 x 146.16 mm. */
export async function gloveBox(detect: (img: RgbaImage) => { quad: { x: number; y: number }[]; w: number; h: number } | null) {
  const img = loadSample('t5.bmp')!
  const r = detect(img)
  if (!r) return null
  const ppm = 10
  const ow = Math.round(r.w * ppm)
  const oh = Math.round(r.h * ppm)
  const Hinv = computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], r.quad)
  const src = new ImageDataPoly(img.width, img.height)
  src.data.set(img.data)
  const flat = warpPerspective(src as unknown as ImageData, Hinv, ow, oh)
  const gray = grayFromImageData(flat as unknown as ImageData)
  const m = buildInkMask(gray, ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
  const box = async (mode: 'outline' | 'centerline') => {
    const v = await vectorise(m, ow, oh, ppm, mode)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const g of v.groups) for (const c of g) for (const p of c.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
    return { w: x1 - x0, h: y1 - y0, sw: v.strokeWidthMm }
  }
  return { outline: await box('outline'), centerline: await box('centerline') }
}

it('trace dots: glove ground truth (88.17 x 146.16 mm)', async () => {
  const res = await gloveBox((img) => {
    const t = detectTraceFrame(img.data, img.width, img.height)
    return t ? { quad: t.window, w: t.landscape ? 263 : 173, h: t.landscape ? 173 : 263 } : null
  })
  console.log('GLOVE', JSON.stringify(res, (_, v) => (typeof v === 'number' ? +v.toFixed(2) : v)))
}, 120000)

it('trace dots: glove vs pitch / frame height', async () => {
  const rows: string[] = []
  for (const [pitch, heightMm] of [[9, 0], [9, 3], [9, 6], [9.03, 0], [9.03, 3], [8.95, 0]]) {
    const res = await gloveBox((img) => {
      const t = detectTraceFrame(img.data, img.width, img.height, 1600, { pitch, heightMm })
      return t ? { quad: t.window, w: t.landscape ? 263 : 173, h: t.landscape ? 173 : 263 } : null
    })
    rows.push(`pitch ${pitch} height ${heightMm}: centerline ${res!.centerline.w.toFixed(2)} x ${res!.centerline.h.toFixed(2)}  (target 88.17 x 146.16)`)
  }
  console.log(rows.join('\n'))
}, 300000)

/**
 * Self-calibration: dots at (m_s + k p, 0), (m_s + k p, D_l), (0, m_l + k p),
 * (D_s, m_l + k p) for a portrait-agnostic "short across x" layout; solve the
 * homography and (m_s, m_l, D_s, D_l) alternately, pitch p fixed at 1.
 */
it('trace dots: self-calibrate row spacing in pitches', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const { gray, w, h } = work(img, 1600)
    const maxR = Math.max(5, Math.round(0.012 * Math.max(w, h)))
    const dots = findDots(gray, w, h, maxR)
    const black = dots.filter((d) => d.contrast / Math.max(1, d.v) >= 0.7)
    const fit = fitTrack(findRows(black, gray, w, h), w, h) ?? fitTrack(findRows(dots, gray, w, h), w, h)
    if (!fit) continue
    const tb = fit.sides[0].dots.length + fit.sides[2].dots.length
    const lr = fit.sides[1].dots.length + fit.sides[3].dots.length
    const landscape = tb > lr
    // Geometry in pitch units: X across = horizontal axis of the oriented frame.
    let Dx = landscape ? 33.56 : 23.73
    let Dy = landscape ? 23.73 : 33.56
    let mx = landscape ? 1.78 : 1.37
    let my = landscape ? 1.37 : 1.78
    const nx = landscape ? 30 : 21
    const ny = landscape ? 21 : 30
    let Hm = computeHomography([{ x: 0, y: 0 }, { x: Dx, y: 0 }, { x: Dx, y: Dy }, { x: 0, y: Dy }], fit.quad)
    let rms = 0
    let count = 0
    for (let it2 = 0; it2 < 8; it2++) {
      const slots: { x: number; y: number; side: number; k: number }[] = []
      for (let k = 0; k <= nx; k++) { slots.push({ x: mx + k, y: 0, side: 0, k }); slots.push({ x: mx + k, y: Dy, side: 2, k }) }
      for (let k = 0; k <= ny; k++) { slots.push({ x: 0, y: my + k, side: 3, k }); slots.push({ x: Dx, y: my + k, side: 1, k }) }
      const inv = invert3(Hm)!
      const pairs: { s: typeof slots[0]; d: { x: number; y: number } }[] = []
      const used = new Set<number>()
      for (const d of dots) {
        const p = project(inv, d)
        let bi = -1, bd = Infinity
        slots.forEach((sl, j) => { const dd = (sl.x - p.x) ** 2 + (sl.y - p.y) ** 2; if (dd < bd) { bd = dd; bi = j } })
        if (bi < 0 || bd > 0.33 ** 2 || used.has(bi)) continue
        used.add(bi)
        pairs.push({ s: slots[bi], d })
      }
      Hm = homographyLS(pairs.map((q) => q.s), pairs.map((q) => q.d))!
      // Re-estimate geometry from where the dots land in frame coords.
      const inv2 = invert3(Hm)!
      const P = pairs.map((q) => ({ s: q.s, p: project(inv2, q.d) }))
      const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)
      const top = P.filter((q) => q.s.side === 0), bot = P.filter((q) => q.s.side === 2), lef = P.filter((q) => q.s.side === 3), rig = P.filter((q) => q.s.side === 1)
      // Shift origin so the left/top rows sit at 0; distances between rows; slot offsets.
      const yTop = avg(top.map((q) => q.p.y)), yBot = avg(bot.map((q) => q.p.y)), xL = avg(lef.map((q) => q.p.x)), xR = avg(rig.map((q) => q.p.x))
      Dx = xR - xL
      Dy = yBot - yTop
      mx = avg([...top, ...bot].map((q) => q.p.x - xL - q.s.k))
      my = avg([...lef, ...rig].map((q) => q.p.y - yTop - q.s.k))
      count = pairs.length
      rms = Math.sqrt(avg(P.map((q) => (q.p.x - q.s.x) ** 2 + (q.p.y - q.s.y) ** 2)))
    }
    const L = landscape ? Dx : Dy, S = landscape ? Dy : Dx, mL = landscape ? mx : my, mS = landscape ? my : mx
    out.push(`t${i} ${landscape ? 'L' : 'P'} long=${L.toFixed(3)}p short=${S.toFixed(3)}p longMargin=${mL.toFixed(3)} shortMargin=${mS.toFixed(3)} n=${count} rms=${rms.toFixed(3)}p`)
  }
  console.log(out.join('\n'))
}, 300000)

/** Radial model: undistorted = c + (d - c) * (1 + k1 * (|d - c| / R)^2), R = half-diagonal. */
function undistort(p: { x: number; y: number }, k1: number, W: number, H: number) {
  const cx = W / 2, cy = H / 2, R = Math.hypot(W, H) / 2
  const r2 = ((p.x - cx) ** 2 + (p.y - cy) ** 2) / (R * R)
  const f = 1 + k1 * r2
  return { x: cx + (p.x - cx) * f, y: cy + (p.y - cy) * f }
}
function distort(u: { x: number; y: number }, k1: number, W: number, H: number) {
  let p = { ...u }
  for (let i = 0; i < 6; i++) {
    const q = undistort(p, k1, W, H)
    p = { x: p.x + (u.x - q.x), y: p.y + (u.y - q.y) }
  }
  return p
}

it('trace dots: lens distortion from the dots, and the glove', async () => {
  const out: string[] = []
  const L = 33.57, S = 23.70, mL = 1.785, mS = 1.35
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const { gray, w, h, k } = work(img, 1600)
    const maxR = Math.max(5, Math.round(0.012 * Math.max(w, h)))
    const dots = findDots(gray, w, h, maxR).map((d) => ({ x: (d.x + 0.5) / k - 0.5, y: (d.y + 0.5) / k - 0.5 }))
    const t = detectTraceFrame(img.data, img.width, img.height, 1600, { heightMm: 0 })
    if (!t) continue
    const land = t.landscape
    const tw = (land ? L : S) * 9, th = (land ? S : L) * 9
    const slots: { x: number; y: number }[] = []
    const mx = (land ? mL : mS) * 9, my = (land ? mS : mL) * 9
    for (let kk = 0; kk <= (land ? 30 : 21); kk++) { slots.push({ x: mx + kk * 9, y: 0 }, { x: mx + kk * 9, y: th }) }
    for (let kk = 0; kk <= (land ? 21 : 30); kk++) { slots.push({ x: 0, y: my + kk * 9 }, { x: tw, y: my + kk * 9 }) }
    const fitK = (k1: number) => {
      let Hm = computeHomography([{ x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th }], t.track.map((p) => undistort(p, k1, img.width, img.height)))
      let rms = Infinity, n = 0
      for (let it2 = 0; it2 < 4; it2++) {
        const inv = invert3(Hm)!
        const src: { x: number; y: number }[] = [], dst: { x: number; y: number }[] = []
        const used = new Set<number>()
        for (const d of dots) {
          const u = undistort(d, k1, img.width, img.height)
          const p = project(inv, u)
          let bi = -1, bd = Infinity
          slots.forEach((s, j) => { const dd = (s.x - p.x) ** 2 + (s.y - p.y) ** 2; if (dd < bd) { bd = dd; bi = j } })
          if (bi < 0 || bd > 9 || used.has(bi)) continue
          used.add(bi); src.push(slots[bi]); dst.push(u)
        }
        Hm = homographyLS(src, dst)!
        const e = src.map((s, j) => { const q = project(Hm, s); return (q.x - dst[j].x) ** 2 + (q.y - dst[j].y) ** 2 })
        rms = Math.sqrt(e.reduce((a, b) => a + b, 0) / e.length); n = src.length
      }
      return { Hm, rms, n }
    }
    let best = { k1: 0, ...fitK(0) }
    const base = best.rms
    for (let k1 = -0.2; k1 <= 0.2001; k1 += 0.005) { const r = fitK(k1); if (r.rms < best.rms) best = { k1, ...r } }
    out.push(`t${i}: k1=${best.k1.toFixed(3)} rms ${base.toFixed(2)}px -> ${best.rms.toFixed(2)}px (n=${best.n})`)
    if (i === 5) {
      for (const k1 of [0, best.k1]) {
        const fk = fitK(k1)
        const ex = (tw - (land ? 263 : 173)) / 2, ey = (th - (land ? 173 : 263)) / 2
        const ww = land ? 263 : 173, hh = land ? 173 : 263
        // Flatten with distortion: output px -> plane mm -> undistorted px -> photo px.
        const ppm = 10, ow = ww * ppm, oh = hh * ppm
        const flat = new ImageDataPoly(ow, oh)
        for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
          const pu = project(fk.Hm, { x: ex + (x + 0.5) / ppm, y: ey + (y + 0.5) / ppm })
          const pd = distort(pu, k1, img.width, img.height)
          const X = Math.max(0, Math.min(img.width - 1, Math.round(pd.x))), Y = Math.max(0, Math.min(img.height - 1, Math.round(pd.y)))
          const s = (Y * img.width + X) * 4, d = (y * ow + x) * 4
          flat.data[d] = img.data[s]; flat.data[d + 1] = img.data[s + 1]; flat.data[d + 2] = img.data[s + 2]; flat.data[d + 3] = 255
        }
        const gray2 = grayFromImageData(flat as unknown as ImageData)
        const m = buildInkMask(gray2, ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
        const v = await vectorise(m, ow, oh, ppm, 'centerline')
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const g of v.groups) for (const c of g) for (const p of c.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
        out.push(`  glove k1=${k1.toFixed(3)} (no height): ${(x1 - x0).toFixed(2)} x ${(y1 - y0).toFixed(2)}  target 88.17 x 146.16`)
      }
    }
  }
  console.log(out.join('\n'))
}, 600000)

/** Bounding box (mm) of the biggest traced group (by height) for a sample. */
async function biggestBox(name: string, geo: { pitch?: number; heightMm?: number }, mode: 'outline' | 'centerline') {
  const img = loadSample(name)!
  const t = detectTraceFrame(img.data, img.width, img.height, 1600, geo)!
  const ww = t.landscape ? 263 : 173, hh = t.landscape ? 173 : 263
  const ppm = 8, ow = ww * ppm, oh = hh * ppm
  const Hinv = computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], t.window)
  const src = new ImageDataPoly(img.width, img.height)
  src.data.set(img.data)
  const flat = warpPerspective(src as unknown as ImageData, Hinv, ow, oh)
  const m = buildInkMask(grayFromImageData(flat as unknown as ImageData), ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
  const v = await vectorise(m, ow, oh, ppm, mode)
  let best = { w: 0, h: 0 }
  for (const g of v.groups) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const c of g) for (const p of c.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
    if (y1 - y0 > best.h) best = { w: x1 - x0, h: y1 - y0 }
  }
  return best
}

it('trace dots: two ground truths vs pitch / height', async () => {
  const rows: string[] = []
  for (const heightMm of [0, 1.5, 3]) {
    const g = await biggestBox('t5.bmp', { heightMm }, 'centerline')
    const go = await biggestBox('t5.bmp', { heightMm }, 'outline')
    const c = await biggestBox('t2.bmp', { heightMm }, 'outline')
    const cc = await biggestBox('t2.bmp', { heightMm }, 'centerline')
    rows.push(`h=${heightMm}: glove centerline ${g.w.toFixed(2)} x ${g.h.toFixed(2)} | glove outline ${go.w.toFixed(2)} x ${go.h.toFixed(2)} (target 88.17 x 146.16) || chisel outline ${c.w.toFixed(2)} x ${c.h.toFixed(2)} centerline ${cc.w.toFixed(2)} x ${cc.h.toFixed(2)} (target 47.50 x 245.87)`)
  }
  console.log(rows.join('\n'))
}, 600000)

it('trace dots: glove with the old four-corner sizing', async () => {
  const res = await gloveBox((img) => {
    const t = detectTraceFrame(img.data, img.width, img.height, 1600, { heightMm: 0 })
    if (!t) return null
    // Old method: the four virtual track corners as a 302.9 x 212.9 mm rectangle, window 19.95 mm inside.
    const land = t.landscape
    const tw = land ? 302.9 : 212.9, th = land ? 212.9 : 302.9, e = 19.95
    const q = (() => {
      const { gray, w, h, k } = work(img, 1600)
      const dots = findDots(gray, w, h, Math.max(5, Math.round(0.012 * Math.max(w, h))))
      const black = dots.filter((d) => d.contrast / Math.max(1, d.v) >= 0.7)
      const fit = fitTrack(findRows(black, gray, w, h), w, h)!
      return fit.quad.map((p) => ({ x: (p.x + 0.5) / k - 0.5, y: (p.y + 0.5) / k - 0.5 }))
    })()
    const Hm = computeHomography([{ x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th }], q)
    const win = [{ x: e, y: e }, { x: tw - e, y: e }, { x: tw - e, y: th - e }, { x: e, y: th - e }].map((p) => applyHomography(Hm, p.x, p.y))
    return { quad: win, w: land ? 263 : 173, h: land ? 173 : 263 }
  })
  console.log('OLD', JSON.stringify(res, (_, v) => (typeof v === 'number' ? +v.toFixed(2) : v)))
}, 120000)

it('trace dots: from rough corners (dragged / live) to the same frame', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const full = detectTraceFrame(img.data, img.width, img.height)!
    const diag = Math.hypot(img.width, img.height)
    const err = (r: { window: { x: number; y: number }[] }) => (Math.max(...r.window.map((p, k) => Math.hypot(p.x - full.window[k].x, p.y - full.window[k].y))) / diag) * 100
    let s = 7 * i
    const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 - 0.5 }
    const jitter = full.track.map((p) => ({ x: p.x + rnd() * 24, y: p.y + rnd() * 24 }))
    const a = traceFrameFromTrack(img.data, img.width, img.height, full.track)
    const b = traceFrameFromTrack(img.data, img.width, img.height, jitter)
    const c = traceFrameFromTrack(img.data, img.width, img.height, full.window)
    out.push(`t${i}: exact ${err(a).toFixed(3)}%  jitter ${err(b).toFixed(3)}%  on-window ${err(c).toFixed(3)}% (slotted ${c.slotted})`)
  }
  console.log(out.join('\n'))
}, 300000)

/** t5 turned 90° into a portrait 1080 x 1920 "phone" frame at scale s (like the in-app camera test). */
function portraitT5(s: number): RgbaImage {
  const img = loadSample('t5.bmp')!
  const W = 1080, H = 1920
  const data = new Uint8ClampedArray(W * H * 4)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      // inverse of: translate(540,960) rotate(90°) draw image centred at scale s
      const dx = x - 540, dy = y - 960
      const u = dy / s + 960, v = -dx / s + 638
      const j = (y * W + x) * 4
      const X = Math.round(u), Y = Math.round(v)
      if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) { data[j] = 200; data[j + 1] = 160; data[j + 2] = 96; data[j + 3] = 255; continue }
      const k = (Y * img.width + X) * 4
      data[j] = img.data[k]; data[j + 1] = img.data[k + 1]; data[j + 2] = img.data[k + 2]; data[j + 3] = 255
    }
  return { data, width: W, height: H }
}

it('trace dots: portrait phone view of t5 (live 800 px and full)', () => {
  const img = portraitT5(0.84)
  const out: string[] = []
  for (const side of [800, 1600]) {
    const { gray, w, h } = work(img, side)
    const maxR = Math.max(4, Math.round(0.012 * Math.max(w, h)))
    const dots = findDots(gray, w, h, maxR)
    const black = dots.filter((d) => d.contrast / Math.max(1, d.v) >= 0.7)
    const rows = findRows(black, gray, w, h)
    const fit = fitTrack(rows, w, h)
    out.push(`${side}: dots ${dots.length} black ${black.length} rows ${rows.map((r) => `${r.dots.length}@${(Math.atan2(r.dy, r.dx) * 57.3).toFixed(0)}`).join(' ')} fit ${fit ? JSON.stringify(fit.quad.map((p) => [p.x | 0, p.y | 0])) + ' sides ' + fit.sides.map((s2) => s2.dots.length).join('/') : 'none'}`)
    const t = detectTraceFrame(img.data, img.width, img.height, side)
    out.push(`   detect: ${t ? (t.landscape ? 'L' : 'P') + ' slotted ' + t.slotted + ' track ' + JSON.stringify(t.track.map((p) => [p.x | 0, p.y | 0])) : 'none'}`)
    if (side === 800) {
      const v = work(img, 800)
      for (const d of dots) ring(v.rgba, v.w, v.h, d.x, d.y, d.r + 2, [255, 0, 0])
      rows.forEach((r, kk) => r.dots.forEach((d) => ring(v.rgba, v.w, v.h, d.x, d.y, d.r + 5, [[0, 200, 255], [0, 255, 0], [255, 0, 255], [255, 200, 0], [120, 120, 255], [255, 120, 120]][kk % 6] as [number, number, number])))
      if (fit) for (let e = 0; e < 4; e++) line(v.rgba, v.w, v.h, fit.quad[e], fit.quad[(e + 1) % 4], [0, 255, 0])
      writeFileSync(join(here, 'out', 'trace-portrait-800.png'), encodePng({ data: v.rgba, width: v.w, height: v.h }))
    }
  }
  console.log(out.join('\n'))
}, 300000)

/** Box-downscaled copy of an image (keeps RGBA). */
function scaled(img: RgbaImage, s: number): RgbaImage {
  const w = Math.round(img.width * s), h = Math.round(img.height * s)
  const v = work(img, Math.max(w, h))
  return { data: v.rgba, width: v.w, height: v.h }
}

it('trace dots: glove size vs photo resolution', async () => {
  const out: string[] = []
  const full = loadSample('t5.bmp')!
  for (const s of [1, 0.9, 0.8, 0.75, 0.7, 0.62, 0.56, 0.42, 0.32]) {
    const img = s === 1 ? full : scaled(full, s)
    const t = detectTraceFrame(img.data, img.width, img.height)!
    const ww = t.landscape ? 263 : 173, hh = t.landscape ? 173 : 263, ppm = 8, ow = ww * ppm, oh = hh * ppm
    const flat = warpPerspective({ data: img.data, width: img.width, height: img.height } as unknown as ImageData, computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], t.window), ow, oh)
    const m = buildInkMask(grayFromImageData(flat as unknown as ImageData), ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
    const v = await vectorise(m, ow, oh, ppm, 'centerline')
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const g of v.groups) for (const c of g) for (const p of c.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y) }
    // Window size in photo px (how big the frame is in the picture).
    const wpx = Math.hypot(t.window[1].x - t.window[0].x, t.window[1].y - t.window[0].y)
    out.push(`scale ${s} (${img.width}x${img.height}, window ${wpx.toFixed(0)} px wide): glove ${(x1 - x0).toFixed(2)} x ${(y1 - y0).toFixed(2)}  stroke ${v.strokeWidthMm.toFixed(2)}  slotted ${t.slotted} good ${t.good} rms ${t.rms.toFixed(2)} lens ${t.lens ? t.lens.k.toFixed(4) : '-'}`)
  }
  console.log(out.join('\n'))
}, 300000)

import { TRACK_LONG as TL_C, TRACK_SHORT as TS_C } from '../../src/features/paper/traceDots'

/**
 * Edge-to-edge sizes of the frame (outer) and of its opening (inner), in the
 * dot-based mm, measured along the straight middle of each edge (25..75% of
 * the side, clear of the rounded corners). Edges: strongest brightness step
 * along each scanline, in the right direction and the right zone.
 */
it('trace dots: frame outer and opening, edge to edge (mm)', () => {
  const out: string[] = []
  for (let i = 1; i <= 7; i++) {
    const img = loadSample(`t${i}.bmp`)
    if (!img) continue
    const t = detectTraceFrame(img.data, img.width, img.height)!
    const tw = t.landscape ? TL_C : TS_C
    const th = t.landscape ? TS_C : TL_C
    const Hm = computeHomography([{ x: 0, y: 0 }, { x: tw, y: 0 }, { x: tw, y: th }, { x: 0, y: th }], t.track)
    const lum = (x: number, y: number) => {
      const p = applyHomography(Hm, x, y)
      const X = Math.round(p.x), Y = Math.round(p.y)
      if (X < 1 || Y < 1 || X >= img.width - 1 || Y >= img.height - 1) return -1
      let s = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const j = ((Y + dy) * img.width + X + dx) * 4; s += img.data[j] * 0.3 + img.data[j + 1] * 0.59 + img.data[j + 2] * 0.11 }
      return s / 9
    }
    // Along a ray from `from` in direction (ux,uy), over [s0, s1] mm: position of the
    // strongest step of the given sign (+1: dark->bright going outward).
    const edge = (fx: number, fy: number, ux: number, uy: number, s0: number, s1: number, sign: number) => {
      let best = 0, bs = NaN
      for (let s = s0; s <= s1; s += 0.2) {
        const a = lum(fx + ux * (s - 0.6), fy + uy * (s - 0.6))
        const b = lum(fx + ux * (s + 0.6), fy + uy * (s + 0.6))
        if (a < 0 || b < 0) continue
        const d = (b - a) * sign
        if (d > best) { best = d; bs = s }
      }
      return best > 20 ? bs : NaN
    }
    const med = (v: number[]) => { const f = v.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return f.length >= 4 ? f[f.length >> 1] : NaN }
    // For each side: distance from the dot line to the opening edge (inward, bright inside -> going inward is dark->bright)
    // and to the outer edge (outward: frame dark -> background, any sign, strongest |step|).
    const sides = [
      { o: (t2: number) => [t2 * tw, 0], n: [0, -1] }, // top: outward = -y
      { o: (t2: number) => [tw, t2 * th], n: [1, 0] },
      { o: (t2: number) => [t2 * tw, th], n: [0, 1] },
      { o: (t2: number) => [0, t2 * th], n: [-1, 0] },
    ]
    const inner: number[] = []
    const outer: number[] = []
    for (const sd of sides) {
      const ins: number[] = [], outs: number[] = []
      for (let k = 0; k <= 20; k++) {
        const [x, y] = sd.o(0.25 + (0.5 * k) / 20)
        // inward ray: -n; opening edge is where it turns bright (dark->bright along inward ray)
        ins.push(edge(x, y, -sd.n[0], -sd.n[1], 6, 30, +1))
        // outward ray: frame edge; strongest step either way
        const a = edge(x, y, sd.n[0], sd.n[1], 8, 30, +1)
        const b = edge(x, y, sd.n[0], sd.n[1], 8, 30, -1)
        outs.push(Number.isFinite(a) ? a : b)
      }
      inner.push(med(ins))
      outer.push(med(outs))
    }
    const [it, ir, ib, il] = inner
    const [ot, or, ob, ol] = outer
    const openW = tw - il - ir, openH = th - it - ib
    const outW = tw + ol + or, outH = th + ot + ob
    const L = (a: number, b: number) => (t.landscape ? a : b)
    out.push(`t${i} ${t.landscape ? 'L' : 'P'}: opening ${L(openW, openH).toFixed(1)} x ${L(openH, openW).toFixed(1)}  outer ${L(outW, outH).toFixed(1)} x ${L(outH, outW).toFixed(1)}   [inner insets t${it?.toFixed(1)} r${ir?.toFixed(1)} b${ib?.toFixed(1)} l${il?.toFixed(1)} | outer t${ot?.toFixed(1)} r${or?.toFixed(1)} b${ob?.toFixed(1)} l${ol?.toFixed(1)}]`)
  }
  console.log(out.join('\n'))
}, 300000)
