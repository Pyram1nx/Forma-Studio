// Synthetic photos of a sheet seen in perspective, rendered with 2x2
// supersampling so edges are realistically anti-aliased: hard shadows, low
// light with sensor noise, drawings running off the sheet, and a Shaper Trace
// frame. Checks corner accuracy on the full-size photo and the paper-size guess.
import { describe, expect, it } from 'vitest'
import { detectPaperRgba } from '../src/features/paper/detect'
import { estimateAspect, guessPaper } from '../src/features/paper/paperSize'
import type { Pt } from '../src/model/types'

type Mat3 = number[]

/** Homography plane (mm) -> image for a camera tilted `tilt` rad about x and turned `yaw` about z. */
function camera(W: number, H: number, f: number, tilt: number, yaw: number, dist: number, cx: number, cy: number): Mat3 {
  const ct = Math.cos(tilt), st = Math.sin(tilt)
  const cyw = Math.cos(yaw), syw = Math.sin(yaw)
  // R = Rx(tilt) * Rz(yaw)
  const r = [
    [cyw, -syw, 0],
    [ct * syw, ct * cyw, -st],
    [st * syw, st * cyw, ct],
  ]
  // Camera looks at plane point (cx, cy) from `dist` mm away.
  const t = [-(r[0][0] * cx + r[0][1] * cy), -(r[1][0] * cx + r[1][1] * cy), dist - (r[2][0] * cx + r[2][1] * cy)]
  const K = [f, 0, W / 2, 0, f, H / 2, 0, 0, 1]
  const M = [r[0][0], r[0][1], t[0], r[1][0], r[1][1], t[1], r[2][0], r[2][1], t[2]]
  const out = new Array(9).fill(0)
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) for (let k = 0; k < 3; k++) out[i * 3 + j] += K[i * 3 + k] * M[k * 3 + j]
  return out
}

const apply = (Hm: Mat3, x: number, y: number): Pt => {
  const w = Hm[6] * x + Hm[7] * y + Hm[8]
  return { x: (Hm[0] * x + Hm[1] * y + Hm[2]) / w, y: (Hm[3] * x + Hm[4] * y + Hm[5]) / w }
}

function invert(m: Mat3): Mat3 {
  const [a, b, c, d, e, f, g, h, i] = m
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g
  const det = a * A + b * B + c * C
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((v) => v / det)
}

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Scene {
  W: number
  H: number
  /** Plane (mm) -> image. */
  Hm: Mat3
  /** Colour (0..255 grey) at plane point (x, y) mm; the sheet is [0, pw] x [0, ph]. */
  plane: (x: number, y: number) => number
  /** Lighting multiplier at image pixel. */
  light?: (u: number, v: number) => number
  noise?: number
  seed?: number
}

function render(s: Scene): Uint8ClampedArray {
  const inv = invert(s.Hm)
  const out = new Uint8ClampedArray(s.W * s.H * 4)
  const rand = rng(s.seed ?? 1)
  for (let v = 0; v < s.H; v++)
    for (let u = 0; u < s.W; u++) {
      let acc = 0
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const p = apply(inv, u + ox, v + oy)
        acc += s.plane(p.x, p.y) * (s.light ? s.light(u + ox, v + oy) : 1)
      }
      let g = acc / 4
      if (s.noise) g += (rand() + rand() + rand() - 1.5) * s.noise * 2
      const j = (v * s.W + u) * 4
      out[j] = g * 1.02
      out[j + 1] = g
      out[j + 2] = g * 0.95
      out[j + 3] = 255
    }
  return out
}

/** Paper sheet [0, pw] x [0, ph] on a wood-ish textured desk, with optional ink. */
function sheetPlane(pw: number, ph: number, paper: number, desk: number, ink?: (x: number, y: number) => boolean) {
  return (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < pw && y < ph) return ink && ink(x, y) ? 35 : paper
    // Desk grain: stripes plus fine texture.
    return desk + 10 * Math.sin(y * 0.35 + Math.sin(x * 0.05) * 3) + 6 * Math.sin(x * 1.7 + y * 0.3)
  }
}

function cornerError(found: Pt[], truth: Pt[]): number {
  return Math.max(...truth.map((c) => Math.min(...found.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))))
}

const A4 = { w: 210, h: 297 }

function a4Scene(extra: Partial<Scene> & { ink?: (x: number, y: number) => boolean; paper?: number; desk?: number } = {}) {
  const W = 1600, H = 1200
  // Phone held ~45 cm away, tilted 25° and turned 12°: a clearly trapezoidal sheet.
  const Hm = camera(W, H, 1250, 0.44, 0.21, 520, A4.w / 2, A4.h / 2)
  const truth = [apply(Hm, 0, 0), apply(Hm, A4.w, 0), apply(Hm, A4.w, A4.h), apply(Hm, 0, A4.h)]
  const scene: Scene = { W, H, Hm, plane: sheetPlane(A4.w, A4.h, extra.paper ?? 225, extra.desk ?? 110, extra.ink), ...extra }
  return { scene, truth, W, H }
}

describe('paper size from perspective', () => {
  it('recovers the true A4 ratio of a strongly tilted sheet', () => {
    const { truth, W, H } = a4Scene()
    const naive = (Math.hypot(truth[1].x - truth[0].x, truth[1].y - truth[0].y) + Math.hypot(truth[2].x - truth[3].x, truth[2].y - truth[3].y)) /
      (Math.hypot(truth[3].x - truth[0].x, truth[3].y - truth[0].y) + Math.hypot(truth[2].x - truth[1].x, truth[2].y - truth[1].y))
    const est = estimateAspect(truth, W, H)
    expect(Math.abs(est.ratio - A4.w / A4.h)).toBeLessThan(0.01)
    // The raw edge lengths would have been badly off.
    expect(Math.abs(naive - A4.w / A4.h)).toBeGreaterThan(0.03)
    expect(guessPaper(est.ratio, 'letter').presetId).toBe('a4')
    expect(guessPaper(est.ratio, 'a3').presetId).toBe('a3')
    expect(guessPaper(est.ratio, 'a4').landscape).toBe(false)
  })
  it('tells Letter from A4 and falls back to custom', () => {
    expect(guessPaper(215.9 / 279.4, 'a4').presetId).toBe('letter')
    expect(guessPaper(355.6 / 215.9, 'a4')).toMatchObject({ presetId: 'legal', landscape: true })
    expect(guessPaper(1, 'a4').presetId).toBe('custom')
  })
})

describe('paper detection on synthetic photos', () => {
  it('lands on the corners of a tilted sheet within 2 px', () => {
    const { scene, truth, W, H } = a4Scene({ ink: (x, y) => Math.abs(Math.hypot(x - 105, y - 150) - 60) < 0.6 })
    const r = detectPaperRgba(render(scene), W, H)
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, truth)).toBeLessThan(2)
    expect(guessPaper(r.ratio, 'a4').presetId).toBe('a4')
  })

  it('survives a hard shadow cutting across the sheet', () => {
    const { scene, truth, W, H } = a4Scene({
      // A hand / phone shadow: 45% darker over a diagonal band with a sharp edge.
      light: (u, v) => (u + 0.6 * v > 900 && u + 0.6 * v < 1500 ? 0.55 : 1),
    })
    const r = detectPaperRgba(render(scene), W, H)
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, truth)).toBeLessThan(3)
  })

  it('survives low light with sensor noise and a dark vignette', () => {
    const { scene, truth, W, H } = a4Scene({
      light: (u, v) => 0.28 * (1 - 0.45 * (Math.hypot(u - 800, v - 600) / 1000) ** 2),
      noise: 6,
      seed: 3,
    })
    const r = detectPaperRgba(render(scene), W, H)
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, truth)).toBeLessThan(3)
    expect(guessPaper(r.ratio, 'a4').presetId).toBe('a4')
  })

  it('ignores pen strokes that run off the sheet edge', () => {
    const { scene, truth, W, H } = a4Scene({
      ink: (x, y) => Math.abs(y - 0.9 * x - 20) < 0.8 || Math.abs(x - 150) < 0.7 || Math.abs(y - 60) < 1,
    })
    const r = detectPaperRgba(render(scene), W, H)
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, truth)).toBeLessThan(2)
  })

  it('runs a live-preview detection on a small frame quickly', () => {
    const { scene, truth, W, H } = a4Scene()
    const rgba = render(scene)
    const t0 = performance.now()
    const r = detectPaperRgba(rgba, W, H, { workMax: 400, refine: false })
    const ms = performance.now() - t0
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, truth)).toBeLessThan(8)
    expect(ms).toBeLessThan(400)
  })
})
