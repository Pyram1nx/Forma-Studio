import { describe, expect, it } from 'vitest'
import { LensCalibrator, bowPoint, straightenPoint, straightenRgba, trustedLens } from '../src/features/paper/lens'
import { slotPoints, homographyLS, project } from '../src/features/paper/traceDots'

function rng(seed: number) {
  let s = seed >>> 0
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0
    return s / 2 ** 32
  }
}

/** One frame's dots as a bowed camera W x H sees them: track at `quad`, noise `px`. */
function frame(W: number, H: number, quad: { x: number; y: number }[], k1: number, px: number, rand: () => number, k2 = 0) {
  const slots = slotPoints(true)
  const tw = Math.max(...slots.map((s) => s.x))
  const th = Math.max(...slots.map((s) => s.y))
  const Hm = homographyLS(
    [
      { x: 0, y: 0 },
      { x: tw, y: 0 },
      { x: tw, y: th },
      { x: 0, y: th },
    ],
    quad,
  )!
  return slots.map((s) => {
    const p = bowPoint(project(Hm, s), W, H, { k1, k2 })
    return { u: s.x, v: s.y, x: p.x + (rand() - 0.5) * 2 * px, y: p.y + (rand() - 0.5) * 2 * px }
  })
}

const centred = (W: number, H: number, f: number, dx = 0, dy = 0) => {
  const hw = W * f * 0.5
  const hh = hw / Math.SQRT2
  return [
    { x: W / 2 - hw + dx, y: H / 2 - hh + dy },
    { x: W / 2 + hw + dx, y: H / 2 - hh + dy },
    { x: W / 2 + hw + dx, y: H / 2 + hh + dy },
    { x: W / 2 - hw + dx, y: H / 2 + hh + dy },
  ]
}

describe('lens', () => {
  it('bowPoint undoes straightenPoint', () => {
    const lens = { k1: 0.05, k2: -0.01 }
    for (const p of [
      { x: 10, y: 20 },
      { x: 799, y: 449 },
      { x: 400, y: 225 },
    ]) {
      const q = bowPoint(straightenPoint(p, 800, 450, lens), 800, 450, lens)
      expect(q.x).toBeCloseTo(p.x, 6)
      expect(q.y).toBeCloseTo(p.y, 6)
    }
  })

  it('recovers the bow from many noisy live frames', () => {
    const rand = rng(11)
    for (const k1 of [-0.04, 0, 0.03]) {
      const cal = new LensCalibrator()
      for (let i = 0; i < 24; i++) {
        const q = centred(800, 450, 0.75 + rand() * 0.1, (rand() - 0.5) * 60, (rand() - 0.5) * 30)
        cal.add(frame(800, 450, q, k1, 0.4, rand), 800, 450)
      }
      const e = cal.solve()!
      expect(e).not.toBeNull()
      expect(Math.abs(e.k1 - k1)).toBeLessThan(Math.max(0.004, 3 * e.sigma))
      expect(trustedLens(e)).toBe(true)
    }
  })

  it('needs enough frames, and gives no lens from a few', () => {
    const rand = rng(5)
    const cal = new LensCalibrator()
    for (let i = 0; i < 4; i++) cal.add(frame(800, 450, centred(800, 450, 0.8), 0.03, 0.4, rand), 800, 450)
    expect(cal.solve()).toBeNull()
  })

  it('a view held still is trusted less than a moving one', () => {
    const still = new LensCalibrator()
    const moving = new LensCalibrator()
    const rand = rng(9)
    for (let i = 0; i < 24; i++) {
      still.add(frame(800, 450, centred(800, 450, 0.8), 0.03, 0.4, rand), 800, 450)
      moving.add(frame(800, 450, centred(800, 450, 0.7 + rand() * 0.15, (rand() - 0.5) * 80, (rand() - 0.5) * 40), 0.03, 0.4, rand), 800, 450)
    }
    expect(still.variety()).toBeLessThan(0.1)
    expect(moving.variety()).toBeGreaterThan(0.5)
    expect(still.solve()!.sigma).toBeGreaterThan(moving.solve()!.sigma)
  })

  it('straightening keeps the middle and pushes a barrel bow outward', () => {
    const W = 64
    const H = 48
    const src = new Uint8ClampedArray(W * H * 4)
    // A bright pixel column at x = 56 in the bowed picture.
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) src.set(x === 56 ? [255, 255, 255, 255] : [0, 0, 0, 255], (y * W + x) * 4)
    const out = straightenRgba(src, W, H, { k1: 0.1, k2: 0 })
    const row = (H / 2) | 0
    let best = 0
    let at = 0
    for (let x = 0; x < W; x++) {
      const v = out[(row * W + x) * 4]
      if (v > best) {
        best = v
        at = x
      }
    }
    const expected = straightenPoint({ x: 56, y: row }, W, H, { k1: 0.1, k2: 0 }).x
    expect(Math.abs(at - expected)).toBeLessThanOrEqual(1)
    expect(at).toBeGreaterThan(56)
  })

  it('recovers a lens with a fourth-order term, and its scale across the picture', () => {
    const rand = rng(21)
    const cal = new LensCalibrator()
    for (let i = 0; i < 30; i++) {
      const f = i % 3 === 2 ? 0.5 + rand() * 0.2 : 0.75 + rand() * 0.1
      cal.add(frame(800, 450, centred(800, 450, f, (rand() - 0.5) * 80, (rand() - 0.5) * 40), 0.03, 0.3, rand, -0.04), 800, 450)
    }
    const e = cal.solve()!
    for (const r of [0.3, 0.6, 0.9]) {
      const got = e.k1 * r * r + e.k2 * r ** 4
      const want = 0.03 * r * r - 0.04 * r ** 4
      expect(Math.abs(got - want)).toBeLessThan(0.001)
    }
    expect(trustedLens(e)).toBe(true)
  })

  it('stored frames come back, and are dropped when today\'s lens clearly differs', () => {
    const rand = rng(31)
    const a = new LensCalibrator()
    for (let i = 0; i < 20; i++) a.add(frame(800, 450, centred(800, 450, 0.7 + rand() * 0.15, (rand() - 0.5) * 80, (rand() - 0.5) * 40), 0.03, 0.3, rand), 800, 450)
    const stored = JSON.parse(JSON.stringify(a.toJSON()))

    // Same lens next time: the old frames join today's.
    const b = new LensCalibrator()
    b.add(frame(800, 450, centred(800, 450, 0.8), 0.03, 0.3, rand), 800, 450)
    b.restore(stored)
    expect(b.count).toBe(21)
    expect(b.fresh).toBe(1)
    expect(Math.abs(b.solve()!.k1 - 0.03)).toBeLessThan(0.004)

    // Another lens behind the same name: once today's frames disagree, the old go.
    const c = new LensCalibrator()
    c.add(frame(800, 450, centred(800, 450, 0.8), -0.04, 0.3, rand), 800, 450)
    c.restore(stored)
    for (let i = 0; i < 20; i++) c.add(frame(800, 450, centred(800, 450, 0.7 + rand() * 0.15, (rand() - 0.5) * 80, (rand() - 0.5) * 40), -0.04, 0.3, rand), 800, 450)
    const e = c.solve()!
    expect(c.count).toBe(c.fresh)
    expect(Math.abs(e.k1 + 0.04)).toBeLessThan(0.004)
  })
})
