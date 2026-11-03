import { afterEach, describe, expect, it } from 'vitest'
import { DEFAULT_PREFS, newShapeCut, parsePrefs, usePrefs } from '../src/state/prefs'
import { DEFAULT_CUT } from '../src/model/types'
import { createBasic, createTemplate } from '../src/editor/shapeFactory'

afterEach(() => usePrefs.getState().reset())

describe('parsePrefs', () => {
  it('falls back to the defaults for missing or malformed storage', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('')).toEqual(DEFAULT_PREFS)
    expect(parsePrefs('{not json')).toEqual(DEFAULT_PREFS)
  })

  it('replaces bad fields one by one and keeps the good ones', () => {
    const p = parsePrefs(JSON.stringify({ cutType: 'sideways', bitDia: -2, depth: 'deep', units: 'mm', gridSize: 0 }))
    expect(p.cutType).toBe(DEFAULT_CUT.type)
    expect(p.bitDia).toBe(DEFAULT_CUT.bitDia)
    expect(p.depth).toBeNull()
    expect(p.units).toBe('mm')
    expect(p.gridSize).toBeUndefined()
    const q = parsePrefs(JSON.stringify({ cutType: 'inside', bitDia: 6.35, depth: 12 }))
    expect([q.cutType, q.bitDia, q.depth]).toEqual(['inside', 6.35, 12])
  })
})

describe('newShapeCut', () => {
  const preset = parsePrefs(JSON.stringify({ cutType: 'pocket', bitDia: 6.35, depth: 9 }))

  it('is the factory default with default prefs', () => {
    expect(newShapeCut(undefined, DEFAULT_PREFS)).toEqual(DEFAULT_CUT)
  })

  it('uses the preset type, bit and depth for closed shapes', () => {
    expect(newShapeCut(undefined, preset)).toEqual({ type: 'pocket', depth: 9, offset: 0, bitDia: 6.35 })
  })

  it('keeps a forced type (open paths stay On Line) with the preset bit and depth', () => {
    expect(newShapeCut('online', preset)).toEqual({ type: 'online', depth: 9, offset: 0, bitDia: 6.35 })
    expect(newShapeCut('guide', preset).type).toBe('guide')
  })

  it('reads the live store by default', () => {
    usePrefs.getState().set({ cutType: 'inside', bitDia: 12.7 })
    expect(newShapeCut()).toMatchObject({ type: 'inside', bitDia: 12.7 })
  })
})

describe('new shapes take the presets', () => {
  it('basic shapes and templates', () => {
    usePrefs.getState().set({ cutType: 'inside', bitDia: 6.35, depth: 5 })
    expect(createBasic('rect', 0, 0).cut).toEqual({ type: 'inside', depth: 5, offset: 0, bitDia: 6.35 })
    expect(createTemplate('bowtie', 0, 0, 'mm')!.cut).toEqual({ type: 'inside', depth: 5, offset: 0, bitDia: 6.35 })
  })

  it('box joints stay Inside with their 1/4 in tool whatever the preset bit', () => {
    usePrefs.getState().set({ cutType: 'pocket', bitDia: 3, depth: 7 })
    const s = createTemplate('boxJointBasic', 0, 0, 'mm')!
    expect(s.cut).toEqual({ type: 'inside', depth: 7, offset: 0, bitDia: 6.35 })
  })
})
