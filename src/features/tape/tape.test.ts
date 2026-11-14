import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TAPE_OPTIONS,
  DOMINO_COUNT,
  DOMINO_H,
  DOMINO_W,
  allCodes,
  canonicalCode,
  codeDots,
  isValidCode,
  layoutTape,
  pickCodes,
  rotateCode,
  sequenceFor,
} from './tapeGeometry'
import { tapePdf } from './tapePdf'
import { tapeSvg } from './tapeSvg'

/** The 16 dots turned half a turn. */
const turn = (dots: boolean[]) => dots.slice().reverse()

describe('domino codes', () => {
  it('has 452 distinct dominoes, each valid', () => {
    const all = allCodes()
    expect(all.length).toBe(DOMINO_COUNT)
    expect(new Set(all).size).toBe(all.length)
    for (const c of all) {
      expect(isValidCode(c)).toBe(true)
      expect(canonicalCode(c)).toBe(c)
    }
  })

  it('every domino shows 10 dots with both end columns lit', () => {
    for (const c of allCodes()) {
      const d = codeDots(c)
      expect(d.length).toBe(16)
      expect(d.filter(Boolean).length).toBe(10)
      expect([d[0], d[1], d[14], d[15]]).toEqual([true, true, true, true])
    }
  })

  it('no domino looks the same turned around, and no two are the same domino turned around', () => {
    const seen = new Set<string>()
    for (const c of allCodes()) {
      const d = codeDots(c)
      expect(turn(d)).not.toEqual(d)
      expect(codeDots(rotateCode(c))).toEqual(turn(d))
      const a = d.map(Number).join('')
      const b = turn(d).map(Number).join('')
      expect(seen.has(a) || seen.has(b)).toBe(false)
      seen.add(a)
      seen.add(b)
    }
  })

  it('rejects symmetric and wrong-count codes', () => {
    expect(isValidCode(0b000000111111)).toBe(true)
    expect(isValidCode(0b100001100001)).toBe(false) // reads the same reversed
    expect(isValidCode(0b000001111111)).toBe(false) // 7 bits
    expect(isValidCode(1 << 12)).toBe(false)
  })
})

describe('seeded sequence', () => {
  it('is a repeatable permutation of all dominoes', () => {
    const a = sequenceFor('workshop')
    expect(sequenceFor('workshop')).toEqual(a)
    expect([...a].sort((x, y) => x - y)).toEqual([...allCodes()])
    expect(sequenceFor('other')).not.toEqual(a)
  })

  it('consecutive sheets from one seed never share a domino until the set runs out', () => {
    const one = pickCodes('s', 0, 200)
    const two = pickCodes('s', 200, 200)
    const both = new Set([...one.codes, ...two.codes])
    expect(both.size).toBe(400)
    expect(two.wrapped).toBe(false)
    const three = pickCodes('s', 400, 100)
    expect(three.wrapped).toBe(true)
    expect(new Set(three.codes).size).toBe(100)
  })

  it('caps a sheet at the number of distinct dominoes', () => {
    const p = pickCodes('s', 10, 1000)
    expect(p.codes.length).toBe(DOMINO_COUNT)
    expect(p.capped).toBe(true)
    expect(new Set(p.codes).size).toBe(DOMINO_COUNT)
  })
})

describe('layout', () => {
  it('keeps every domino inside the margins and off each other, with no repeats', () => {
    for (const mode of ['strips', 'sheet'] as const) {
      for (const page of ['letter', 'a4'] as const) {
        for (const orientation of ['portrait', 'landscape'] as const) {
          const o = { ...DEFAULT_TAPE_OPTIONS, mode, page, orientation, rowGap: mode === 'sheet' ? 2 : 0 }
          const l = layoutTape(o)
          expect(l.problem).toBeNull()
          expect(l.dominoes.length).toBeGreaterThan(10)
          expect(new Set(l.dominoes.map((d) => d.code)).size).toBe(l.dominoes.length)
          for (const d of l.dominoes) {
            expect(d.x).toBeGreaterThanOrEqual(o.margin - 1e-9)
            expect(d.y).toBeGreaterThanOrEqual(o.margin - 1e-9)
            expect(d.x + DOMINO_W).toBeLessThanOrEqual(l.w - o.margin + 1e-9)
            expect(d.y + DOMINO_H).toBeLessThanOrEqual(l.h - o.margin + 1e-9)
          }
          for (let i = 0; i < l.dominoes.length; i++)
            for (let j = i + 1; j < l.dominoes.length; j++) {
              const a = l.dominoes[i]
              const b = l.dominoes[j]
              const apart = a.x + DOMINO_W <= b.x + 1e-9 || b.x + DOMINO_W <= a.x + 1e-9 || a.y + DOMINO_H <= b.y + 1e-9 || b.y + DOMINO_H <= a.y + 1e-9
              expect(apart).toBe(true)
            }
          if (l.footer) for (const d of l.dominoes) expect(d.y + DOMINO_H).toBeLessThanOrEqual(l.footer.y + 1e-9)
        }
      }
    }
  })

  it('honours strip count and strip length', () => {
    const l = layoutTape({ ...DEFAULT_TAPE_OPTIONS, stripCount: 3, stripLength: 150, dominoGap: 4 })
    expect(l.strips.length).toBe(3)
    expect(l.perRow).toBe(3) // 3 x 43 + 2 x 4 + 2 x 2 = 141 <= 150
    expect(l.dominoes.length).toBe(9)
    expect(l.nextStart).toBe(9)
  })

  it('writes SVG at physical size and a PDF', () => {
    const l = layoutTape(DEFAULT_TAPE_OPTIONS)
    const svg = tapeSvg(l)
    expect(svg).toContain('width="215.9mm"')
    expect(svg).toContain('height="279.4mm"')
    expect(svg.match(/<circle /g)?.length).toBe(l.dominoes.length * 10)
    const pdf = tapePdf(l)
    const head = String.fromCharCode(...pdf.slice(0, 8))
    expect(head).toBe('%PDF-1.4')
    const text = Array.from(pdf, (b) => String.fromCharCode(b)).join('')
    expect(text).toContain('/MediaBox [0 0 612 792]')
    expect(text.trimEnd().endsWith('%%EOF')).toBe(true)
  })
})
