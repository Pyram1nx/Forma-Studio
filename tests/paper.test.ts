import { describe, expect, it } from 'vitest'
import { vectorise } from '../src/features/paper/trace'
import { computeHomography, applyHomography } from '../src/features/paper/homography'
import { buildInkMask } from '../src/features/paper/ink'
import { findPaperQuad } from '../src/features/paper/detect'
import { signedArea } from '../src/geometry/offset'

function ringMask(w: number, h: number, cx: number, cy: number, r: number, thick: number) {
  const m = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (Math.abs(Math.hypot(x - cx, y - cy) - r) <= thick / 2) m[y * w + x] = 1
  return m
}

describe('paper trace', () => {
  it('centerline of a drawn circle is one closed loop at real size', async () => {
    const ppm = 6
    const W = 120 * ppm, H = 120 * ppm
    const m = ringMask(W, H, 60 * ppm, 60 * ppm, 40 * ppm, 1 * ppm)
    const r = await vectorise(m, W, H, ppm, 'centerline')
    expect(r.groups.length).toBe(1)
    const c = r.groups[0][0]
    expect(c.closed).toBe(true)
    const rs = c.pts.map((p) => Math.hypot(p.x - 60, p.y - 60))
    expect(Math.min(...rs)).toBeGreaterThan(39.3)
    expect(Math.max(...rs)).toBeLessThan(40.7)
    expect(r.strokeWidthMm).toBeGreaterThan(0.7)
    expect(r.strokeWidthMm).toBeLessThan(1.4)
  })
  it('outline of a ring gives an outer loop with a hole', async () => {
    const ppm = 4
    const m = ringMask(200, 200, 100, 100, 60, 12)
    const r = await vectorise(m, 200, 200, ppm, 'outline')
    expect(r.groups.length).toBe(1)
    expect(r.groups[0].length).toBe(2)
  })
})

describe('homography', () => {
  it('maps the four corners exactly', () => {
    const src = [{ x: 10, y: 20 }, { x: 300, y: 40 }, { x: 320, y: 400 }, { x: 0, y: 380 }]
    const dst = [{ x: 0, y: 0 }, { x: 210, y: 0 }, { x: 210, y: 297 }, { x: 0, y: 297 }]
    const H = computeHomography(src, dst)
    src.forEach((p, i) => {
      const q = applyHomography(H, p.x, p.y)
      expect(q.x).toBeCloseTo(dst[i].x, 6)
      expect(q.y).toBeCloseTo(dst[i].y, 6)
    })
  })
})

describe('paper outline', () => {
  it('a 10 mm square outline keeps its four corners within 0.15 mm', async () => {
    const ppm = 6
    const W = 50 * ppm, H = 50 * ppm
    const m = new Uint8Array(W * H)
    for (let y = 20 * ppm; y < 30 * ppm; y++) for (let x = 20 * ppm; x < 30 * ppm; x++) m[y * W + x] = 1
    const r = await vectorise(m, W, H, ppm, 'outline')
    expect(r.groups.length).toBe(1)
    const outer = r.groups[0][0].pts
    for (const [cx, cy] of [[20, 20], [30, 20], [30, 30], [20, 30]]) {
      const d = Math.min(...outer.map((p) => Math.hypot(p.x - cx, p.y - cy)))
      expect(d).toBeLessThan(0.15)
    }
  })

  it('a 30 mm filled black square inks as one loop with no hole and the right area', async () => {
    const ppm = 6
    const W = 50 * ppm, H = 50 * ppm
    const gray = new Uint8Array(W * H).fill(255)
    for (let y = 10 * ppm; y < 40 * ppm; y++) for (let x = 10 * ppm; x < 40 * ppm; x++) gray[y * W + x] = 0
    const mask = buildInkMask(gray, W, H, { ppm, sensitivity: 50, cOffset: 0, marginMm: 2, minBlobMm2: 2, closeGaps: false })
    const r = await vectorise(mask, W, H, ppm, 'outline')
    expect(r.groups.length).toBe(1)
    expect(r.groups[0].length).toBe(1)
    const area = Math.abs(signedArea(r.groups[0][0].pts))
    expect(Math.abs(area - 900) / 900).toBeLessThan(0.02)
  })
})

describe('paper detection', () => {
  const W = 300, H = 240
  it('finds a sheet even when a pen stroke crosses it', () => {
    const g = new Uint8Array(W * H).fill(60) // dark table
    for (let y = 30; y < 210; y++) for (let x = 50; x < 250; x++) g[y * W + x] = 235 // sheet
    for (let x = 60; x < 240; x++) for (let t = 0; t < 3; t++) g[(120 + t) * W + x] = 20 // pen stroke
    const r = findPaperQuad(g, W, H)
    expect(r.quad).not.toBeNull()
    const q = r.quad!
    const corners = [{ x: 50, y: 30 }, { x: 250, y: 30 }, { x: 250, y: 210 }, { x: 50, y: 210 }]
    for (const c of corners) {
      const d = Math.min(...q.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))
      expect(d).toBeLessThan(4)
    }
  })
  it('rejects a bright table that fills the whole photo', () => {
    const g = new Uint8Array(W * H).fill(240)
    const r = findPaperQuad(g, W, H)
    expect(r.quad).toBeNull()
    expect(r.reason.length).toBeGreaterThan(0)
  })
})

describe('endpoint stitching', () => {
  it('joins a 0.3 mm gap and closes a loop whose ends meet', async () => {
    const { joinEndpoints } = await import('../src/features/paper/trace')
    const a = { pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }], closed: false }
    const b = { pts: [{ x: 5.3, y: 0 }, { x: 10, y: 0 }], closed: false }
    const joined = joinEndpoints([a, b], 0.5)
    expect(joined.length).toBe(1)
    expect(joined[0].pts.length).toBe(4)
    const loop = { pts: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }, { x: 0.2, y: 0.1 }], closed: false }
    const closed = joinEndpoints([loop], 0.5)
    expect(closed.length).toBe(1)
    expect(closed[0].closed).toBe(true)
  })
})

describe('branch stubs', () => {
  it('drops a twig off a stroke but keeps a lone dash and a real branch', async () => {
    const { dropBranchStubs } = await import('../src/features/paper/trace')
    const line = { pts: [{ x: 0, y: 0 }, { x: 50, y: 0 }], closed: false }
    const twig = { pts: [{ x: 20, y: 0.2 }, { x: 20.8, y: 1.6 }], closed: false }
    const branch = { pts: [{ x: 35, y: 0.2 }, { x: 35, y: 6 }], closed: false }
    const dash = { pts: [{ x: 10, y: 20 }, { x: 12, y: 20 }], closed: false }
    const kept = dropBranchStubs([line, twig, branch, dash], 0.5)
    expect(kept).toEqual([line, branch, dash])
  })
  it('before joining: drops a twig at a junction, keeps the fragments of a stroke', async () => {
    const { dropBranchStubs } = await import('../src/features/paper/trace')
    const arc1 = { pts: [{ x: 0, y: 0 }, { x: 10, y: 0 }], closed: false }
    const arc2 = { pts: [{ x: 10, y: 0 }, { x: 30, y: 0 }], closed: false }
    const twig = { pts: [{ x: 10, y: 0.1 }, { x: 10.5, y: 1.5 }], closed: false }
    const tip = { pts: [{ x: 30.1, y: 0 }, { x: 30.6, y: 0 }], closed: false }
    const kept = dropBranchStubs([arc1, arc2, twig, tip], 0.5, 'junction')
    expect(kept).toEqual([arc1, arc2, tip])
  })
})

describe('ink mask (full pipeline incl. lighting correction)', () => {
  it('inks the whole interior of a 30 mm solid fill', async () => {
    const { buildInkMask } = await import('../src/features/paper/ink')
    const ppm = 6
    const W = 120 * ppm, H = 120 * ppm
    const gray = new Uint8Array(W * H).fill(235)
    // gentle lighting gradient across the sheet
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) gray[y * W + x] = Math.round(235 - (x / W) * 40)
    const x0 = 45 * ppm, x1 = 75 * ppm
    for (let y = x0; y < x1; y++) for (let x = x0; x < x1; x++) gray[y * W + x] = 20
    const m = buildInkMask(gray, W, H, { ppm, sensitivity: 50, cOffset: 0, marginMm: 2, minBlobMm2: 2, closeGaps: false })
    let inside = 0, total = 0, outside = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const inSq = x >= x0 && x < x1 && y >= x0 && y < x1
        if (inSq) { total++; inside += m[y * W + x] } else outside += m[y * W + x]
      }
    expect(inside / total).toBeGreaterThan(0.99)
    expect(outside).toBe(0)
  })
})

describe('hard shadows and noise (regression)', () => {
  it('detects the sheet when a broad shadow crosses desk and paper', () => {
    const W = 300, H = 400
    const rgba = new Uint8ClampedArray(W * H * 4)
    const shade = (x: number, y: number) => 1 - 0.35 * Math.max(0, 1 - Math.hypot(x - 220, y - 320) / 220)
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const l = shade(x, y)
        const onPaper = x >= 50 && x < 250 && y >= 40 && y < 360
        const v = (onPaper ? 200 : 120) * l
        const i = (y * W + x) * 4
        rgba[i] = rgba[i + 1] = v
        rgba[i + 2] = v * 0.95
        rgba[i + 3] = 255
      }
    const truth = [{ x: 50, y: 40 }, { x: 250, y: 40 }, { x: 250, y: 360 }, { x: 50, y: 360 }]
    const r = findPaperQuad(rgbaToScore(rgba, W, H), W, H)
    expect(r.quad).not.toBeNull()
    for (const c of truth) {
      const d = Math.min(...r.quad!.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))
      expect(d).toBeLessThan(6)
    }
  })

  it('inks a pen circle but not the shadow or sensor noise', () => {
    const ppm = 6
    const W = 120 * ppm, H = 160 * ppm
    const gray = new Uint8Array(W * H)
    // paper with a broad soft shadow across one corner
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const s = 1 - 0.4 * Math.max(0, 1 - Math.hypot(x - W, y - H) / (1.2 * H))
        gray[y * W + x] = Math.round(200 * s)
      }
    // pen circle
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++)
        if (Math.abs(Math.hypot(x - 60 * ppm, y - 60 * ppm) - 30 * ppm) <= 1.5 * ppm) gray[y * W + x] = 40
    // sensor noise specks
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    for (let n = 0; n < 400; n++) {
      const x = Math.floor(rnd() * W)
      const y = Math.floor(rnd() * H)
      gray[y * W + x] = Math.max(0, gray[y * W + x] - 60)
    }
    const m = buildInkMask(gray, W, H, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
    let circle = 0
    let shadowCore = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const onCircle = Math.abs(Math.hypot(x - 60 * ppm, y - 60 * ppm) - 30 * ppm) <= 2.5 * ppm
        const inShadowCore = x > 95 * ppm && y > 130 * ppm
        if (onCircle) circle += m[y * W + x]
        if (inShadowCore) shadowCore += m[y * W + x]
      }
    expect(circle).toBeGreaterThan(2 * Math.PI * 30 * ppm * 1.2 * ppm)
    expect(shadowCore).toBeLessThan(0.02 * 25 * ppm * ppm)
  })
})

describe('hard shadows on the flattened page (regression)', () => {
  it('does not ink the sharp edges of a shadow band, but keeps the drawing', () => {
    const ppm = 6
    const W = 150 * ppm, H = 200 * ppm
    const gray = new Uint8Array(W * H)
    // A phone's shadow: a diagonal band at 48% brightness with a sharp edge
    // (one-pixel anti-aliased ramp), plus mild vignetting.
    const band = (x: number, y: number) => {
      const d = (x + 0.7 * y) / ppm
      const t1 = Math.min(1, Math.max(0, d - 90 + 0.5))
      const t2 = Math.min(1, Math.max(0, 150 - d + 0.5))
      return 1 - 0.52 * Math.min(t1, t2)
    }
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const vig = 1 - 0.12 * ((x - W / 2) ** 2 + (y - H / 2) ** 2) / (W * W)
        gray[y * W + x] = Math.round(225 * vig * band(x, y))
      }
    // Pen circle of radius 40 mm at (75, 100) mm, 0.8 mm wide, crossing the band.
    const onCircle = (x: number, y: number, tol: number) => Math.abs(Math.hypot(x - 75 * ppm, y - 100 * ppm) - 40 * ppm) <= tol * ppm
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (onCircle(x, y, 0.4)) gray[y * W + x] = Math.round(gray[y * W + x] * 0.18)
    const m = buildInkMask(gray, W, H, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
    let circle = 0
    let stray = 0
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        if (!m[y * W + x]) continue
        if (onCircle(x, y, 1.5)) circle++
        else stray++
      }
    // The circle is inked all the way round, in and out of the shadow...
    expect(circle).toBeGreaterThan(2 * Math.PI * 40 * ppm * 0.7 * ppm)
    // ...and nothing else: no lines along the shadow's edges.
    expect(stray).toBeLessThan(0.5 * ppm * ppm)
  })
})

function rgbaToScore(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h)
  for (let i = 0, j = 0; i < out.length; i++, j += 4) {
    const r = rgba[j], g = rgba[j + 1], b = rgba[j + 2]
    out[i] = Math.max(0, Math.min(255, ((r * 77 + g * 150 + b * 29) >> 8) - Math.max(0, Math.max(r, g, b) - Math.min(r, g, b) - 20)))
  }
  return out
}
