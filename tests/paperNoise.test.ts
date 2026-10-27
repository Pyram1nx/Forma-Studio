// Noise rejection in ink extraction: a dim, noisy flattened page with a hard
// shadow band, dust, faint smudges and a light pencil line next to real pen
// strokes and a small drawn circle. The drawing must survive; nothing else may
// (dust that physically touches a stroke is the only ink allowed off it).
import { describe, expect, it } from 'vitest'
import { buildInkMask, labelComponents } from '../src/features/paper/ink'

const PPM = 6

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 4294967296
  }
}

interface Page {
  gray: Uint8Array
  w: number
  h: number
  /** Distance (mm) to the nearest intended stroke, per pixel. */
  isDrawing: (x: number, y: number, tolMm: number) => boolean
  isPencil: (x: number, y: number, tolMm: number) => boolean
  isRing: (x: number, y: number, tolMm: number) => boolean
}

/** A4 page at PPM px/mm; `paper` is the lit paper level, `noise` the sensor sigma. */
function noisyPage(seed: number, paper: number, noise: number, opts: { shadow?: boolean } = {}): Page {
  const w = 210 * PPM
  const h = 297 * PPM
  const rand = rng(seed)
  const gauss = () => (rand() + rand() + rand() + rand() - 2) * Math.sqrt(3)
  const circle = (x: number, y: number, tol: number) => Math.abs(Math.hypot(x / PPM - 105, y / PPM - 120) - 55) <= tol
  const trap = (x: number, y: number, tol: number) => {
    const X = x / PPM
    const Y = y / PPM
    const seg = (ax: number, ay: number, bx: number, by: number) => {
      const dx = bx - ax
      const dy = by - ay
      const t = Math.max(0, Math.min(1, ((X - ax) * dx + (Y - ay) * dy) / (dx * dx + dy * dy)))
      return Math.hypot(X - ax - t * dx, Y - ay - t * dy)
    }
    return Math.min(seg(40, 220, 170, 220), seg(170, 220, 140, 255), seg(140, 255, 70, 255), seg(70, 255, 40, 220)) <= tol
  }
  const pencil = (x: number, y: number, tol: number) => Math.abs(y / PPM - 195) <= tol && x / PPM > 30 && x / PPM < 180
  // A small drawn hole: a 3.5 mm circle.
  const ring = (x: number, y: number, tol: number) => Math.abs(Math.hypot(x / PPM - 180, y / PPM - 40) - 1.75) <= tol
  // Shadow: a diagonal band 55% dark with sharp edges, plus a soft corner shade.
  const light = (x: number, y: number) => {
    let l = 1 - 0.25 * Math.max(0, 1 - Math.hypot(x - w, y) / (0.9 * w))
    if (opts.shadow) {
      const d = (x + 0.6 * y) / PPM
      if (d > 120 && d < 200) l *= 0.45
    }
    return l
  }
  const ink = new Float32Array(w * h).fill(1)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (circle(x, y, 0.4) || trap(x, y, 0.4) || ring(x, y, 0.3)) ink[i] = 0.16
      else if (pencil(x, y, 0.22)) ink[i] = 0.58
    }
  // Faint smudges (12% darker blobs) and dust: dark dots up to 2.2 mm across.
  const blobs: [number, number, number, number, number][] = []
  for (let k = 0; k < 14; k++) blobs.push([rand() * w, rand() * h, (2 + rand() * 4) * PPM, (1.5 + rand() * 2) * PPM, 0.88])
  for (let k = 0; k < 70; k++) {
    const r = (0.15 + rand() * 0.95) * PPM
    blobs.push([rand() * w, rand() * h, r, r, 0.35 + rand() * 0.5])
  }
  for (const [bx, by, rx, ry, f] of blobs)
    for (let y = Math.max(0, Math.floor(by - ry)); y < Math.min(h, by + ry); y++)
      for (let x = Math.max(0, Math.floor(bx - rx)); x < Math.min(w, bx + rx); x++)
        if (((x - bx) / rx) ** 2 + ((y - by) / ry) ** 2 <= 1) ink[y * w + x] *= f
  const gray = new Uint8Array(w * h)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const v = paper * light(x, y) * ink[i] + gauss() * noise
      gray[i] = Math.max(0, Math.min(255, Math.round(v)))
    }
  return {
    gray,
    w,
    h,
    isDrawing: (x, y, tol) => circle(x, y, tol) || trap(x, y, tol) || pencil(x, y, tol) || ring(x, y, tol),
    isPencil: pencil,
    isRing: ring,
  }
}

function score(p: Page, mask: Uint8Array) {
  const { labels, sizes } = labelComponents(mask, p.w, p.h, true)
  const onDrawing = new Uint8Array(sizes.length)
  let ringHit = 0
  let pencilHit = 0
  let pencilTotal = 0
  for (let y = 0; y < p.h; y++)
    for (let x = 0; x < p.w; x++) {
      const i = y * p.w + x
      if (p.isPencil(x, y, 0.15) && x > 35 * PPM && x < 175 * PPM) {
        pencilTotal++
        if (mask[i]) pencilHit++
      }
      if (labels[i] && p.isDrawing(x, y, 1.5)) onDrawing[labels[i]] = 1
      if (mask[i] && p.isRing(x, y, 0.3)) ringHit++
    }
  let stray = 0
  for (let l = 1; l < sizes.length; l++) if (!onDrawing[l]) stray++
  // Pixels inked away from every stroke (noise glued onto strokes counts too).
  let strayPx = 0
  for (let y = 0; y < p.h; y++) for (let x = 0; x < p.w; x++) if (mask[y * p.w + x] && !p.isDrawing(x, y, 1.5)) strayPx++
  return { stray, strayMm2: strayPx / PPM / PPM, pencil: pencilHit / Math.max(1, pencilTotal), ring: ringHit > 0 }
}

const opts = { ppm: PPM, sensitivity: 50, cOffset: 0, marginMm: 3, minBlobMm2: 3, closeGaps: false }

describe('ink noise rejection', () => {
  it('a clean, well-lit page stays clean', () => {
    const p = noisyPage(1, 235, 2)
    const s = score(p, buildInkMask(p.gray, p.w, p.h, opts))
    expect(s.stray).toBe(0)
    expect(s.strayMm2).toBeLessThan(5)
    expect(s.pencil).toBeGreaterThan(0.9)
    expect(s.ring).toBe(true)
  })
  it('a dim, noisy photo keeps the drawing and drops the noise', () => {
    const p = noisyPage(2, 120, 9)
    const s = score(p, buildInkMask(p.gray, p.w, p.h, opts))
    expect(s.stray).toBe(0)
    expect(s.strayMm2).toBeLessThan(5)
    expect(s.pencil).toBeGreaterThan(0.85)
    expect(s.ring).toBe(true)
  })
  it('noise inside a hard shadow band does not come through', () => {
    const p = noisyPage(3, 120, 9, { shadow: true })
    const s = score(p, buildInkMask(p.gray, p.w, p.h, opts))
    expect(s.stray).toBe(0)
    expect(s.strayMm2).toBeLessThan(15)
    expect(s.pencil).toBeGreaterThan(0.8)
  })
})
