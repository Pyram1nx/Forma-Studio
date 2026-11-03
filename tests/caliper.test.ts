import { describe, expect, it } from 'vitest'
import { caliperUnit, convertCaliper } from '../src/ui/caliperInput'

describe('caliper input', () => {
  it('reads the unit from the decimals', () => {
    expect(caliperUnit('6.83')).toBe('mm')
    expect(caliperUnit('9.00')).toBe('mm')
    expect(caliperUnit('0.2995')).toBe('in')
    expect(caliperUnit('0.354')).toBeNull()
    expect(caliperUnit('12')).toBeNull()
  })
  it('converts to the document units', () => {
    expect(convertCaliper('0.2995', 'mm')).toEqual({ text: '7.607', from: 'in' })
    expect(convertCaliper('6.83', 'in')).toEqual({ text: '0.2689', from: 'mm' })
    expect(convertCaliper('6.83', 'mm').text).toBe('6.83')
    expect(convertCaliper('0.2995', 'in').text).toBe('0.2995')
    expect(convertCaliper('0.354', 'mm').text).toBe('0.354')
  })
})
