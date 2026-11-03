import { describe, expect, it } from 'vitest'
import { BITS } from '../src/features/carve3d/bits'
import {
  allBits,
  createBitLibrary,
  customBitFromInput,
  ownedBits,
  suggestBits,
  suggestOwned,
  type BitLibraryState,
} from '../src/features/bitlibrary/library'

/** In-memory stand-in for localStorage (tests run in node). */
function fakeStorage() {
  const map = new Map<string, string>()
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
  }
}

const stateOf = (s: { getState: () => BitLibraryState }) => s.getState()

describe('custom bits', () => {
  it('fill the derived fields like catalogue bits', () => {
    const b = customBitFromInput({ name: 'Test 4mm downcut', type: 'flat', diameter: 4, fluteLength: 12 }, 'custom-test')
    expect(b.id).toBe('custom-test')
    expect(b.shankDiameter).toBe(4)
    expect(b.group).toBe('flat')
    expect(b.carvable).toBe(true)
    // Nothing is marked "inferred" on a user bit: the user is the source.
    expect(b.inferred).toEqual([])
    expect(b.maxDepth).toBeNull()
  })

  it('undercutters are not carvable; ball tips default to hemispheres', () => {
    const t = customBitFromInput({ name: 'Dovetail 10mm', type: 'undercut', diameter: 10, fluteLength: 8 }, 'custom-dovetail')
    expect(t.carvable).toBe(false)
    expect(t.group).toBe('specialty')
    const ball = customBitFromInput({ name: 'Ball 6mm', type: 'ball', diameter: 6, fluteLength: 10 }, 'custom-ball')
    expect(ball.tipRadius).toBeCloseTo(3)
  })

  it('keep the given id even when finish() would slug it differently', () => {
    const b = customBitFromInput({ name: 'Odd / Name!!', type: 'vbit', diameter: 6, fluteLength: 5, angle: 30 }, 'custom-fixed')
    expect(b.id).toBe('custom-fixed')
    expect(b.tipDiameter).toBe(0)
  })
})

describe('the library store', () => {
  it('ownership round-trips through storage', () => {
    const storage = fakeStorage()
    const a = createBitLibrary(storage)
    a.getState().setOwned('SE1-2500-1000C', true)
    a.getState().setQty('SE1-2500-1000C', 3)
    a.getState().setNotes('SE1-2500-1000C', 'getting dull')
    const b = createBitLibrary(storage)
    expect(b.getState().owned['SE1-2500-1000C']).toMatchObject({ qty: 3, notes: 'getting dull' })
  })

  it('ids repeat safely and removing a custom bit clears its ownership', () => {
    const s = createBitLibrary()
    const one = s.getState().addCustomBit({ name: 'My bit', type: 'flat', diameter: 5, fluteLength: 10 })
    const two = s.getState().addCustomBit({ name: 'My bit', type: 'flat', diameter: 5, fluteLength: 10 })
    expect(one.id).toBe('custom-my-bit')
    expect(two.id).toBe('custom-my-bit-2')
    s.getState().setOwned(one.id, true)
    s.getState().removeCustomBit(one.id)
    expect(s.getState().custom).toHaveLength(1)
    expect(s.getState().owned[one.id]).toBeUndefined()
  })

  it('clamps quantity and ignores updates for unowned bits', () => {
    const s = createBitLibrary()
    s.getState().setOwned('SF1-8-3U', true)
    s.getState().setQty('SF1-8-3U', 500)
    expect(s.getState().owned['SF1-8-3U']?.qty).toBe(99)
    s.getState().setQty('SF1-8-3U', 0)
    expect(s.getState().owned['SF1-8-3U']?.qty).toBe(1)
    s.getState().setQty('SE1-2500-1000C', 2)
    expect(s.getState().owned['SE1-2500-1000C']).toBeUndefined()
    s.getState().setNotes('SF1-8-3U', 'note')
    expect(s.getState().owned['SF1-8-3U']?.notes).toBe('note')
  })

  it('lists owned bits from both catalogue and custom', () => {
    const s = createBitLibrary()
    const mine = s.getState().addCustomBit({ name: 'Mine', type: 'flat', diameter: 2, fluteLength: 5 })
    s.getState().setOwned(mine.id, true)
    s.getState().setOwned('SF1-8-3U', true)
    expect(ownedBits(stateOf(s)).map((b) => b.id).sort()).toEqual([mine.id, 'SF1-8-3U'].sort())
    expect(allBits(stateOf(s))).toHaveLength(BITS.length + 1)
  })
})

describe('suggestBits', () => {
  it('ranks owned bits first, saying why', () => {
    const s = createBitLibrary()
    s.getState().setOwned('SF1-8-3U', true)
    const top = suggestBits(stateOf(s), { use: 'inside' })[0]
    expect(top.bit.id).toBe('SF1-8-3U')
    expect(top.reasons[0]).toContain('kit')
  })

  it('flags bits that cannot reach the depth', () => {
    const s = createBitLibrary()
    const for40 = suggestBits(stateOf(s), { depthMm: 40, use: 'pocket' })
    const fits = for40.filter((x) => x.fits)
    expect(fits.length).toBeGreaterThan(0)
    expect(fits[0].bit.type).toBe('flat')
    // The in-box 1/4" upcut only reaches 19.05 mm.
    const inBox = for40.find((x) => x.bit.inBox && x.bit.type === 'flat')
    expect(inBox?.fits).toBe(false)
    expect(inBox?.reasons.join(' ')).toContain('19.1')
  })

  it('respects the slot the bit must enter', () => {
    const s = createBitLibrary()
    const for4 = suggestBits(stateOf(s), { slotWidthMm: 4, depthMm: 8, use: 'inside' })
    expect(for4.find((x) => x.fits)?.bit.diameter).toBeLessThanOrEqual(4)
    expect(for4.find((x) => x.bit.id === 'SE1-2500-1000C')?.fits).toBe(false)
  })

  it('prefers V-bits for engraving and the widest flat for pockets', () => {
    const s = createBitLibrary()
    expect(suggestBits(stateOf(s), { use: 'engrave', depthMm: 1 })[0].bit.type).toBe('vbit')
    expect(suggestBits(stateOf(s), { use: 'pocket', depthMm: 6 })[0].bit.type).toBe('flat')
  })

  it('suggests from custom bits too, and suggestOwned stays inside the gallery', () => {
    const s = createBitLibrary()
    s.getState().addCustomBit({ name: 'Ultra fine 1mm', type: 'flat', diameter: 1, fluteLength: 4 })
    const inSlot = suggestBits(stateOf(s), { slotWidthMm: 1.2, depthMm: 2, use: 'inside' })[0]
    expect(inSlot.bit.name).toBe('Ultra fine 1mm')
    expect(inSlot.fits).toBe(true)

    // Nothing owned: fall back to the whole catalogue...
    expect(suggestOwned(stateOf(s), { use: 'inside' }).length).toBeGreaterThan(0)
    // ...but once something is owned, only owned bits are suggested.
    s.getState().setOwned('SF1-8-3U', true)
    expect(suggestOwned(stateOf(s), {}).every((x) => s.getState().owned[x.bit.id])).toBe(true)
  })
})
