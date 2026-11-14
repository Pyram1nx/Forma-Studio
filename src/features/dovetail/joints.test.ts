import { describe, expect, it } from 'vitest'
import * as R from './region'
import { CUSTOM_BIT, DEFAULT_FIT, finePinJoint, jointParts, knappJoint, pickBit, resolveFinePin, resolveKnapp, type FinePinDraft, type KnappDraft } from './joints'

const fmt = (mm: number) => `${+mm.toFixed(2)} mm`
const custom = (diameter: number, cutLength: number) => ({ id: CUSTOM_BIT, custom: { diameter, cutLength } })

const fine = (patch: Partial<FinePinDraft> = {}): FinePinDraft => ({
  width: 150,
  tailThick: 12,
  pinThick: 12,
  pins: null,
  pinWidth: null,
  slope: 6,
  edgePin: null,
  tailBit: custom(2, 15),
  pinBit: pickBit(6.35, 13),
  fit: { ...DEFAULT_FIT.mm },
  ...patch,
})

const knapp = (patch: Partial<KnappDraft> = {}): KnappDraft => ({
  width: 100,
  sideThick: 12,
  frontThick: 19,
  pins: null,
  dowel: null,
  dowelLength: 0,
  cove: null,
  style: 'cove',
  margin: null,
  dowelPos: null,
  hidden: false,
  skin: 2,
  sideBit: pickBit(3.175, 12),
  frontBit: pickBit(3.175, 12),
  fit: { ...DEFAULT_FIT.mm },
  ...patch,
})

/** Overlap of the two boards inside the joint, mm². */
function clash(m: ReturnType<typeof finePinJoint>): number {
  const tail = m.tail.layers[m.tail.layers.length - 1].region
  const pin = m.pin.layers[0].region
  return R.area(R.offset(R.inter(tail, pin), -0.025))
}

describe('region', () => {
  it('opening rounds a square corner by the bit radius', () => {
    const sq = R.rect(0, 0, 10, 10)
    const cut = R.opening(sq, 1)
    // A square loses (4 − π) r² to its rounded corners.
    expect(R.area(cut)).toBeCloseTo(100 - (4 - Math.PI), 1)
  })

  it('opening drops a slot narrower than the bit', () => {
    expect(R.area(R.opening(R.rect(0, 0, 1.5, 20), 1))).toBe(0)
  })

  it('pieces keeps holes with their outer ring', () => {
    const ring = R.diff(R.rect(0, 0, 10, 10), R.rect(3, 3, 7, 7))
    const ps = R.pieces(ring)
    expect(ps.length).toBe(1)
    expect(ps[0].holes.length).toBe(1)
    expect(R.contains(ring, { x: 5, y: 5 })).toBe(false)
    expect(R.contains(ring, { x: 1, y: 5 })).toBe(true)
  })
})

describe('fine-pin dovetails', () => {
  it('auto layout: finest pins for the bit, five pins on 150 mm', () => {
    const r = resolveFinePin(fine())
    expect(r.pins).toBe(5)
    // 2 mm bit + slot clearance + taper over the 0.5 mm proud.
    expect(r.pinWidth).toBeGreaterThanOrEqual(2.15)
    expect(r.pinWidth).toBeLessThan(2.5)
    expect(r.angle).toBeCloseTo(9.46, 1)
  })

  it('cuts cleanly: the boards only touch, and every socket has a pocket', () => {
    const m = finePinJoint(fine(), fmt)
    expect(m.ok).toBe(true)
    expect(m.warnings).toEqual([])
    expect(clash(m)).toBeLessThan(0.05)
    expect(m.layouts.tail.cuts.length).toBe(7)
    expect(m.layouts.pin.cuts.length).toBe(6)
  })

  it('round corners: the pins lose their sharp inside corners; chisel keeps them', () => {
    const round = finePinJoint(fine(), fmt)
    const sharp = finePinJoint(fine({ fit: { ...DEFAULT_FIT.mm, corners: 'chisel' } }), fmt)
    expect(R.area(round.pin.layers[0].region)).toBeLessThan(R.area(sharp.pin.layers[0].region))
    expect(clash(sharp)).toBeLessThan(0.05)
  })

  it('refuses pins finer than the tail bit', () => {
    const m = finePinJoint(fine({ pinWidth: 1 }), fmt)
    expect(resolveFinePin(fine({ pinWidth: 1 })).pinWidth).toBeGreaterThan(2)
    expect(m.warnings.some((w) => w.includes('no finer'))).toBe(true)
  })

  it('caps the pin count where the pin-board bit still fits between them', () => {
    const r = resolveFinePin(fine({ pins: 999 }))
    expect(r.pins).toBe(r.maxPins)
    const m = finePinJoint(fine({ pins: 999 }), fmt)
    expect(m.ok).toBe(true)
    expect(clash(m)).toBeLessThan(0.05)
  })

  it('imports two anchored groups', () => {
    const parts = jointParts(finePinJoint(fine(), fmt))
    expect(parts.length).toBe(2)
    expect(parts[0].shapes[0].cut.type).toBe('guide')
    expect(parts[1].shapes.slice(1).every((s) => s.cut.type === 'pocket' && s.cut.depth === 12.5)).toBe(true)
  })
})

describe('Knapp joints', () => {
  it('auto layout fits the front and leaves a lap', () => {
    const r = resolveKnapp(knapp())
    expect(r.pins).toBe(5)
    expect(r.cp + r.dowel / 2).toBeLessThanOrEqual(19 + 1e-9)
    expect(r.lap).toBeGreaterThan(1)
    expect(r.cove).toBeGreaterThanOrEqual(r.minCove)
  })

  it('cuts cleanly, with a hole per dowel and dowels standing on the front', () => {
    const m = knappJoint(knapp(), fmt)
    expect(m.warnings).toEqual([])
    expect(m.ok).toBe(true)
    expect(clash(m)).toBeLessThan(0.05)
    const holes = m.layouts.tail.cuts.filter((c) => c.name.includes('dowel hole'))
    expect(holes.length).toBe(5)
    // One pocket on the front, with the five dowels as islands.
    expect(m.layouts.pin.cuts.length).toBe(1)
    expect(m.layouts.pin.cuts[0].contours.length).toBe(6)
    // The dowels are part of the front.
    const r = resolveKnapp(knapp())
    expect(R.contains(m.pin.layers[0].region, { x: r.margin, y: r.cp })).toBe(true)
  })

  it('hidden: a skin on the side, the front stops behind it', () => {
    const m = knappJoint(knapp({ hidden: true, skin: 3 }), fmt)
    expect(m.ok).toBe(true)
    expect(m.tail.layers.length).toBe(2)
    expect(m.pin.layers[0].b0).toBe(3)
    expect(m.layouts.pin.cuts[0].depth).toBe(9)
  })

  it('straight style and slot dowels', () => {
    const m = knappJoint(knapp({ style: 'straight', dowelLength: 6 }), fmt)
    expect(resolveKnapp(knapp({ dowelLength: 6 })).pins).toBe(4)
    expect(m.warnings).toEqual([])
    expect(m.ok).toBe(true)
    expect(clash(m)).toBeLessThan(0.05)
    expect(m.layouts.tail.cuts.every((c) => c.name.includes('dowel hole'))).toBe(true)
  })

  it('warns when the front bit cannot get around the dowels', () => {
    const m = knappJoint(knapp({ cove: 5, frontBit: pickBit(6.35) }), fmt)
    expect(m.warnings.length).toBeGreaterThan(0)
  })
})
