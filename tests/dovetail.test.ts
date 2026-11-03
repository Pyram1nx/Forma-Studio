import { describe, expect, it } from 'vitest'
import { autoTails, DEFAULT_PRESET, dovetailCuts, dovetailLayout, dovetailShapes, maxTails, type DovetailParams } from '../src/features/dovetail/dovetail'

const base: DovetailParams = {
  bit: DEFAULT_PRESET.bit,
  width: 150,
  tailThick: 12,
  pinThick: 12,
  tails: 4,
  pinWidth: DEFAULT_PRESET.bit.diameter,
  straightBit: 6.35,
  glueGap: 0.1,
}

const area = (pts: { x: number; y: number }[]) => Math.abs(pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + p.x * q.y - q.x * p.y }, 0)) / 2

describe('dovetail layout', () => {
  it('defaults to the Shaper / Festool 15° bit', () => {
    expect(DEFAULT_PRESET.bit).toEqual({ angle: 15, diameter: 13.8, fluteLength: 13.5 })
    expect(DEFAULT_PRESET.bitId).toBe('SF1-8-DC15')
  })

  it('tails and pins fill the joint exactly', () => {
    const L = dovetailLayout(base)
    const filled = [...L.pins, ...L.tails].reduce((a, p) => a + area(p), 0)
    expect(filled).toBeCloseTo(base.width * base.pinThick, 6)
    expect(L.warnings).toEqual([])
  })

  it('takes its flank angle from the bit', () => {
    const L = dovetailLayout(base)
    const t = L.tails[0]
    const slope = (t[0].x - t[3].x) / (t[3].y - t[0].y)
    expect(Math.atan(-slope) * (180 / Math.PI)).toBeCloseTo(15, 6)
    expect(L.tailWide - L.tailNarrow).toBeCloseTo(2 * 12 * Math.tan((15 * Math.PI) / 180), 6)
  })

  it('pins are the bit diameter at the baseline and get half pins at the edges', () => {
    const L = dovetailLayout(base)
    const [first] = L.pins
    expect(first[3].x).toBe(0)
    expect(first[2].x).toBeCloseTo(base.bit.diameter / 2, 9)
    expect(L.pins).toHaveLength(base.tails + 1)
  })

  it('warns when the pin board is thicker than the bit can cut', () => {
    expect(dovetailLayout({ ...base, pinThick: 19 }).warnings.join(' ')).toMatch(/thicker than the bit/)
  })

  it('caps the tail count so the straight bit fits at the tail base', () => {
    const n = maxTails(base)
    expect(dovetailLayout({ ...base, tails: n }).tailNarrow).toBeGreaterThanOrEqual(base.straightBit + 2 * base.glueGap)
    expect(dovetailLayout({ ...base, tails: n + 2 }).warnings.length).toBeGreaterThan(0)
    expect(autoTails(150, 13.8)).toBe(4)
  })
})

describe('dovetail cuts', () => {
  it('runs every tail socket out past both faces of the tail board', () => {
    const c = dovetailCuts(base)
    expect(c.tail.online).toBe(true)
    for (const s of c.tail.sockets) {
      const ys = s.pts.map((p) => p.y)
      expect(Math.min(...ys)).toBeLessThan(-base.bit.diameter / 2)
      expect(Math.max(...ys)).toBeGreaterThan(base.tailThick + base.bit.diameter / 2)
    }
  })

  it('pocket walls on the pin board match the tails at both faces', () => {
    const c = dovetailCuts(base)
    const L = dovetailLayout(base)
    c.pin.pockets.forEach((k, i) => {
      const outer = k.pts.filter((p) => Math.abs(p.y - c.pinTop) < 1e-9).map((p) => p.x)
      const inner = k.pts.filter((p) => Math.abs(p.y - (c.pinTop + base.pinThick)) < 1e-9).map((p) => p.x)
      expect(Math.min(...outer)).toBeCloseTo(L.tails[i][0].x, 9)
      expect(Math.max(...outer)).toBeCloseTo(L.tails[i][1].x, 9)
      expect(Math.min(...inner)).toBeCloseTo(L.tails[i][3].x, 9)
      expect(Math.max(...inner)).toBeCloseTo(L.tails[i][2].x, 9)
    })
  })

  it('wider pins become pockets on the tail board', () => {
    expect(dovetailCuts({ ...base, pinWidth: 20 }).tail.online).toBe(false)
  })

  it('shapes carry the depths, bits and glue gap', () => {
    const shapes = dovetailShapes(base, 'SF1-8-DC15')
    const sockets = shapes.filter((s) => s.name.startsWith('Tail board · socket'))
    const pockets = shapes.filter((s) => s.name.startsWith('Pin board · tail socket'))
    expect(sockets).toHaveLength(5)
    expect(pockets).toHaveLength(4)
    expect(sockets[0].cut).toMatchObject({ type: 'online', depth: 12, bitDia: 13.8 })
    expect(sockets[0].meta?.bitId).toBe('SF1-8-DC15')
    expect(pockets[0].cut).toMatchObject({ type: 'pocket', depth: 12, bitDia: 6.35, offset: 0.1 })
    expect(shapes.filter((s) => s.cut.type === 'guide')).toHaveLength(2)
  })
})
