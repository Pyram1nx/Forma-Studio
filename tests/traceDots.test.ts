// Shaper Trace frame detection by its dots, on synthetic photos of the frame:
// a black band with two sizes of white dots on the frame's 9 mm slot grid
// around the 263 x 173 mm capture window, photographed in perspective. The
// size of a traced drawing must come out right from the dots alone. Real
// photos live in tools/trace-lab (local only).
import { describe, expect, it } from 'vitest'
import { detectPaperRgba } from '../src/features/paper/detect'
import { TRACE_ASPECT } from '../src/features/paper/paperSize'
import { captureFromTrack, slotPoints, traceFrameFromTrack, TRACK_LONG, TRACK_SHORT } from '../src/features/paper/traceDots'
import { computeHomography, warpPerspective } from '../src/features/paper/homography'
import { buildInkMask, grayFromImageData } from '../src/features/paper/ink'
import { vectorise } from '../src/features/paper/trace'
import type { Pt } from '../src/model/types'

type Mat3 = number[]

/** Plane (mm) -> image homography for a camera tilted about x, turned about z and rolled. */
function camera(W: number, H: number, f: number, tilt: number, roll: number, dist: number, cx: number, cy: number): Mat3 {
  const ct = Math.cos(tilt), st = Math.sin(tilt)
  const cr = Math.cos(roll), sr = Math.sin(roll)
  const r = [
    [cr, -sr, 0],
    [ct * sr, ct * cr, -st],
    [st * sr, st * cr, ct],
  ]
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

/** Render a plane function (gray, frame mm) through a homography, 2x2 supersampled. */
function render(W: number, H: number, Hm: Mat3, plane: (x: number, y: number) => number): Uint8ClampedArray {
  const inv = invert(Hm)
  const out = new Uint8ClampedArray(W * H * 4)
  for (let v = 0; v < H; v++)
    for (let u = 0; u < W; u++) {
      let acc = 0
      for (const [ox, oy] of [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]]) {
        const p = apply(inv, u + ox, v + oy)
        acc += plane(p.x, p.y)
      }
      const g = acc / 4
      const j = (v * W + u) * 4
      out[j] = g
      out[j + 1] = g
      out[j + 2] = g * 0.96
      out[j + 3] = 255
    }
  return out
}

const WIN_L = 263
const WIN_S = 173
const BAND = 37.5

/** Track offset from the window (mm): the capture area sits centred in the track. */
const EX = (TRACK_LONG - 263) / 2
const EY = (TRACK_SHORT - 173) / 2

/**
 * The frame, landscape, window at [0, 263] x [0, 173] mm. Dots on the slot
 * grid, two sizes, about a third of the slots empty (the frame's code), plus
 * one dot on each corner arc.
 */
function frame(
  seed: number,
  opts: {
    desk?: (x: number, y: number) => number
    cover?: (x: number, y: number) => boolean
    ink?: (x: number, y: number) => boolean
    /** A sheen on the band: the black there reads grey, so its dots lose contrast. */
    sheen?: (x: number, y: number) => boolean
  } = {},
) {
  const rand = rng(seed)
  const dots: { x: number; y: number; r: number }[] = []
  // Like the real code: never more than two empty slots in a row (gaps of up to 3 pitches).
  let empty = 0
  for (const sl of slotPoints(true)) {
    const u = rand()
    if (u < 0.32 && empty < 2) {
      empty++
      continue
    }
    empty = 0
    dots.push({ x: sl.x - EX, y: sl.y - EY, r: u < 0.55 ? 2.4 : 1.5 })
  }
  const R = 9
  for (const [cx, cy, a] of [[-EX + R, -EY + R, 225], [263 + EX - R, -EY + R, 315], [263 + EX - R, 173 + EY - R, 45], [-EX + R, 173 + EY - R, 135]])
    dots.push({ x: cx + R * Math.cos((a * Math.PI) / 180), y: cy + R * Math.sin((a * Math.PI) / 180), r: 1.5 })
  const desk = opts.desk ?? ((x: number) => 205 + 8 * Math.sin(x * 0.2))
  const inRounded = (x: number, y: number, x0: number, y0: number, x1: number, y1: number, r: number) => {
    if (x < x0 || y < y0 || x > x1 || y > y1) return false
    const cx = Math.min(Math.max(x, x0 + r), x1 - r)
    const cy = Math.min(Math.max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r
  }
  return (x: number, y: number) => {
    if (opts.cover && opts.cover(x, y)) return 22
    if (x >= -5 && y >= -5 && x < WIN_L + 5 && y < WIN_S + 5) return opts.ink && opts.ink(x, y) ? 30 : 230 // the opening shows paper
    if (inRounded(x, y, -BAND, -BAND, WIN_L + BAND, WIN_S + BAND, 12)) {
      const sheen = opts.sheen?.(x, y)
      for (const d of dots) if ((x - d.x) ** 2 + (y - d.y) ** 2 <= d.r * d.r) return sheen ? 215 : 225
      return sheen ? 105 : 30
    }
    return desk(x, y)
  }
}

/** A dark grey cutting mat: printed white grid lines and dots of two sizes. */
const mat = (x: number, y: number) => {
  const gx = ((x % 10) + 10) % 10
  const gy = ((y % 10) + 10) % 10
  if ((gx - 5) ** 2 + (gy - 5) ** 2 <= (((Math.floor(x / 10) + Math.floor(y / 10)) & 1) ? 1.4 : 0.8) ** 2) return 220
  if (gx < 0.35 || gy < 0.35) return 170
  return 78
}

function windowTruth(Hm: Mat3, landscape = true) {
  return landscape
    ? [apply(Hm, 0, 0), apply(Hm, WIN_L, 0), apply(Hm, WIN_L, WIN_S), apply(Hm, 0, WIN_S)]
    : [apply(Hm, 0, 0), apply(Hm, WIN_L, 0), apply(Hm, WIN_L, WIN_S), apply(Hm, 0, WIN_S)]
}

const cornerError = (found: Pt[], truth: Pt[]) =>
  Math.max(...truth.map((c) => Math.min(...found.map((p) => Math.hypot(p.x - c.x, p.y - c.y)))))

describe('Shaper Trace frame, found by its dots', () => {
  it('finds the capture window of a tilted frame', () => {
    const W = 1600, H = 1200
    const Hm = camera(W, H, 1300, 0.38, 0.05, 620, WIN_L / 2, WIN_S / 2)
    const r = detectPaperRgba(render(W, H, Hm, frame(1)), W, H, { kind: 'trace' })
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, windowTruth(Hm))).toBeLessThan(3)
    expect(Math.abs(r.ratio / TRACE_ASPECT - 1)).toBeLessThan(1e-9)
  })

  it('ignores a cutting mat full of printed dots, and turns a rotated frame the right way', () => {
    const W = 1400, H = 1400
    const Hm = camera(W, H, 1250, 0.3, 0.6, 600, WIN_L / 2, WIN_S / 2)
    const r = detectPaperRgba(render(W, H, Hm, frame(2, { desk: mat })), W, H, { kind: 'trace' })
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, windowTruth(Hm))).toBeLessThan(3)
  })

  it('still finds the window when an object covers its edge', () => {
    const W = 1600, H = 1200
    const Hm = camera(W, H, 1300, 0.25, -0.08, 600, WIN_L / 2, WIN_S / 2)
    // A dark phone lying across the left window edge, short of the dots.
    const cover = (x: number, y: number) => x > -12 && x < 60 && y > 30 && y < 110
    const r = detectPaperRgba(render(W, H, Hm, frame(3, { cover })), W, H, { kind: 'trace' })
    expect(r.found).toBe(true)
    expect(cornerError(r.quad, windowTruth(Hm))).toBeLessThan(3)
  })

  it('sizes a drawing from the dots: a 100 x 60 mm rectangle traces to 100 x 60 mm', async () => {
    class ImageDataPoly {
      data: Uint8ClampedArray
      constructor(public width: number, public height: number) {
        this.data = new Uint8ClampedArray(width * height * 4)
      }
    }
    ;(globalThis as Record<string, unknown>).ImageData ??= ImageDataPoly
    const W = 1600, H = 1200
    const Hm = camera(W, H, 1300, 0.42, 0.12, 640, WIN_L / 2, WIN_S / 2)
    // Centreline of the pen: a 100 x 60 mm rectangle, 1 mm wide strokes.
    const ink = (x: number, y: number) => {
      const dx = Math.abs(x - 131.5)
      const dy = Math.abs(y - 86.5)
      return (Math.abs(dx - 50) <= 0.5 && dy <= 30.5) || (Math.abs(dy - 30) <= 0.5 && dx <= 50.5)
    }
    const rgba = render(W, H, Hm, frame(4, { ink }))
    const r = detectPaperRgba(rgba, W, H, { kind: 'trace' })
    expect(r.found).toBe(true)
    const ppm = 8, ow = 263 * ppm, oh = 173 * ppm
    const Hinv = computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], r.quad)
    const flat = warpPerspective({ data: rgba, width: W, height: H } as unknown as ImageData, Hinv, ow, oh)
    const m = buildInkMask(grayFromImageData(flat), ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
    const v = await vectorise(m, ow, oh, ppm, 'centerline')
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
    for (const g of v.groups) for (const c of g) for (const p of c.pts) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
    }
    expect(Math.abs(x1 - x0 - 100)).toBeLessThan(0.25)
    expect(Math.abs(y1 - y0 - 60)).toBeLessThan(0.25)
    // And where it is: centred in the window.
    expect(Math.abs((x0 + x1) / 2 - 131.5)).toBeLessThan(0.4)
    expect(Math.abs((y0 + y1) / 2 - 86.5)).toBeLessThan(0.4)
  }, 30000)

  // Phone shots: portrait images, the frame turned every way, steep tilts.
  // The traced rectangle must keep its 100 x 60 mm (either way round) —
  // a mixed-up orientation would squeeze it to about 66 x 91.
  for (const [name, W, H, tilt, roll, dist] of [
    ['portrait phone, frame across', 1200, 1600, 0.5, 0, 760],
    ['portrait phone, frame turned 90°', 1200, 1600, 0.45, Math.PI / 2, 640],
    ['frame at 45°', 1600, 1200, 0.45, Math.PI / 4, 700],
    ['steep 43° tilt', 1600, 1200, 0.75, 0.1, 620],
  ] as const)
    it(`keeps the drawing's proportions: ${name}`, async () => {
      class ImageDataPoly {
        data: Uint8ClampedArray
        constructor(public width: number, public height: number) {
          this.data = new Uint8ClampedArray(width * height * 4)
        }
      }
      ;(globalThis as Record<string, unknown>).ImageData ??= ImageDataPoly
      const Hm = camera(W, H, 1300, tilt, roll, dist, WIN_L / 2, WIN_S / 2)
      const ink = (x: number, y: number) => {
        const dx = Math.abs(x - 131.5)
        const dy = Math.abs(y - 86.5)
        return (Math.abs(dx - 50) <= 0.5 && dy <= 30.5) || (Math.abs(dy - 30) <= 0.5 && dx <= 50.5)
      }
      const rgba = render(W, H, Hm, frame(6, { ink }))
      const r = detectPaperRgba(rgba, W, H, { kind: 'trace' })
      expect(r.found).toBe(true)
      // Scan exactly as the app does: the detector's orientation sets width and height.
      const land = r.ratio >= 1
      const ppm = 6, ow = (land ? 263 : 173) * ppm, oh = (land ? 173 : 263) * ppm
      const Hinv = computeHomography([{ x: 0, y: 0 }, { x: ow, y: 0 }, { x: ow, y: oh }, { x: 0, y: oh }], r.quad)
      const flat = warpPerspective({ data: rgba, width: W, height: H } as unknown as ImageData, Hinv, ow, oh)
      const m = buildInkMask(grayFromImageData(flat), ow, oh, { ppm, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false })
      const v = await vectorise(m, ow, oh, ppm, 'centerline')
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
      for (const g of v.groups) for (const c of g) for (const p of c.pts) {
        x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y)
      }
      const dims = [x1 - x0, y1 - y0].sort((a, b) => a - b)
      expect(Math.abs(dims[0] - 60)).toBeLessThan(0.4)
      expect(Math.abs(dims[1] - 100)).toBeLessThan(0.4)
    }, 30000)

  it('a sheen over most of one row (phone held upright) does not tilt the frame', async () => {
    const W = 1080, H = 1920
    const Hm = camera(W, H, 1500, 0.4, Math.PI / 2 + 0.03, 700, WIN_L / 2, WIN_S / 2)
    // Grey the band along most of the bottom row: only a few dots near one corner stay crisp.
    const sheen = (x: number, y: number) => y > WIN_S && x < 200
    const rgba = render(W, H, Hm, frame(7, { sheen }))
    for (const workMax of [800, 1600]) {
      const r = detectPaperRgba(rgba, W, H, { kind: 'trace', workMax })
      expect(r.found).toBe(true)
      expect(cornerError(r.quad, windowTruth(Hm))).toBeLessThan(3)
    }
  }, 30000)

  it('corners dropped on the white window: the dots still decide the frame', () => {
    const W = 1600, H = 1200
    const Hm = camera(W, H, 1300, 0.38, 0.05, 620, WIN_L / 2, WIN_S / 2)
    const rgba = render(W, H, Hm, frame(5))
    const truth = windowTruth(Hm)
    // The white opening (5 mm outside the capture area), as a hand would place it, a bit off.
    const opening = [apply(Hm, -5, -5), apply(Hm, WIN_L + 5, -5), apply(Hm, WIN_L + 5, WIN_S + 5), apply(Hm, -5, WIN_S + 5)].map((p, i) => ({
      x: p.x + [6, -4, 3, -7][i],
      y: p.y + [-5, 6, -3, 4][i],
    }))
    const r = traceFrameFromTrack(rgba, W, H, opening)
    expect(r.slotted).toBeGreaterThan(40)
    expect(cornerError(r.window, truth)).toBeLessThan(3)
    // And the window shown while dragging always has the frame's shape.
    const shown = captureFromTrack(r.track, W, H)
    expect(cornerError(shown, truth)).toBeLessThan(3)
  })

  it('reports no frame for a plain sheet of paper', () => {
    const W = 1200, H = 900
    const Hm = camera(W, H, 1100, 0.3, 0, 520, 105, 148)
    const plane = (x: number, y: number) => (x >= 0 && y >= 0 && x < 210 && y < 297 ? 232 : 110)
    const r = detectPaperRgba(render(W, H, Hm, plane), W, H, { kind: 'trace' })
    expect(r.found).toBe(false)
  })
})
