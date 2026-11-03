import { describe, expect, it } from 'vitest'
import { designField, imageInkMask } from '../src/features/paper/imageMask'
import { vectorise } from '../src/features/paper/trace'

type RGBA = [number, number, number, number]

/** W x H image: `bg` everywhere, `fg` inside a centred disc of radius r. */
function discImage(w: number, h: number, r: number, fg: RGBA, bg: RGBA): Uint8ClampedArray {
  const d = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const c = Math.hypot(x - w / 2, y - h / 2) <= r ? fg : bg
      d.set(c, (y * w + x) * 4)
    }
  return d
}

const count = (m: Uint8Array) => m.reduce((a, v) => a + v, 0)
const at = (m: Uint8Array, w: number, x: number, y: number) => m[y * w + x]

describe('any-image mask', () => {
  it('black logo on white: the disc is the design', () => {
    const img = discImage(200, 160, 50, [20, 20, 20, 255], [255, 255, 255, 255])
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: false })
    expect(at(m, 200, 100, 80)).toBe(1)
    expect(at(m, 200, 5, 5)).toBe(0)
    expect(Math.abs(count(m) - Math.PI * 50 * 50) / (Math.PI * 50 * 50)).toBeLessThan(0.05)
  })

  it('light logo on a dark background is found too', () => {
    const img = discImage(200, 160, 50, [250, 250, 250, 255], [10, 10, 30, 255])
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: false })
    expect(at(m, 200, 100, 80)).toBe(1)
    expect(at(m, 200, 5, 5)).toBe(0)
  })

  it('colours of equal brightness separate by colour distance', () => {
    // Red and a grey of about the same luma.
    const img = discImage(200, 160, 50, [230, 30, 30, 255], [100, 100, 100, 255])
    expect(designField(img, 200, 160).source).toBe('colour')
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: false })
    expect(at(m, 200, 100, 80)).toBe(1)
    expect(at(m, 200, 5, 5)).toBe(0)
  })

  it('a transparent PNG traces its silhouette, whatever its colour', () => {
    const img = discImage(200, 160, 50, [255, 255, 255, 255], [0, 0, 0, 0])
    expect(designField(img, 200, 160).source).toBe('alpha')
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: false })
    expect(at(m, 200, 100, 80)).toBe(1)
    expect(at(m, 200, 5, 5)).toBe(0)
  })

  it('invert swaps design and background', () => {
    const img = discImage(200, 160, 50, [20, 20, 20, 255], [255, 255, 255, 255])
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: true })
    expect(at(m, 200, 100, 80)).toBe(0)
    expect(at(m, 200, 5, 5)).toBe(1)
  })

  it('drops isolated specks', () => {
    const img = discImage(200, 160, 50, [20, 20, 20, 255], [255, 255, 255, 255])
    img.set([0, 0, 0, 255], (10 * 200 + 10) * 4) // one stray dark pixel
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: false })
    expect(at(m, 200, 10, 10)).toBe(0)
  })

  it('vectorises to one closed outline at the chosen scale', async () => {
    const w = 400
    const h = 300
    const img = discImage(w, h, 100, [20, 20, 20, 255], [255, 255, 255, 255])
    const m = imageInkMask(img, w, h, { detail: 50, invert: false })
    const ppm = 4 // 400 px across = 100 mm
    const r = await vectorise(m, w, h, ppm, 'outline')
    expect(r.groups.length).toBe(1)
    const rs = r.groups[0][0].pts.map((p) => Math.hypot(p.x - 50, p.y - 37.5))
    expect(Math.min(...rs)).toBeGreaterThan(24)
    expect(Math.max(...rs)).toBeLessThan(26)
  })
})
