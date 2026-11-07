import { describe, expect, it } from 'vitest'
import { designField, designLayers, imageInkMask } from '../src/features/paper/imageMask'
import { mergeLayered, vectorise } from '../src/features/paper/trace'

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

  it('a faint colour beside a bold one survives the one threshold', () => {
    // Pale pink reads ~35% as far from white as red does; Otsu's split lands on
    // the loud pair and used to drop the pink disc whole.
    const w = 300
    const h = 160
    const d = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        if (Math.hypot(x - 90, y - 80) <= 40) d.set([220, 30, 30, 255], (y * w + x) * 4)
        else if (Math.hypot(x - 210, y - 80) <= 40) d.set([255, 190, 190, 255], (y * w + x) * 4)
      }
    const m = imageInkMask(d, w, h, { detail: 50, invert: false })
    expect(at(m, w, 90, 80)).toBe(1)
    expect(at(m, w, 210, 80)).toBe(1)
    expect(count(m)).toBeLessThan(Math.PI * 41 * 41 + Math.PI * 41 * 41 + 4000)
  })

  it('chroma reads even at paper brightness (highlighter yellow on white)', () => {
    const img = discImage(200, 160, 50, [250, 245, 130, 255], [255, 255, 255, 255])
    const m = imageInkMask(img, 200, 160, { detail: 50, invert: false })
    expect(at(m, 200, 100, 80)).toBe(1)
    expect(count(m)).toBeGreaterThan(Math.PI * 48 * 48)
    expect(at(m, 200, 5, 5)).toBe(0)
  })

  it('a two-tone background still isolates the design (border clusters)', () => {
    // Sky above, white below: no single border colour, so distances come from
    // the nearest dominant border colour.
    const w = 200
    const h = 160
    const d = new Uint8ClampedArray(w * h * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) d.set(y < h / 2 ? [150, 190, 240, 255] : [255, 255, 255, 255], (y * w + x) * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (Math.hypot(x - 100, y - 80) <= 35) d.set([210, 40, 40, 255], (y * w + x) * 4)
    expect(designField(d, w, h).source).toBe('cluster')
    const m = imageInkMask(d, w, h, { detail: 50, invert: false })
    expect(at(m, w, 100, 80)).toBe(1)
    // The balloon comes out whole: within a few percent of its area.
    const target = Math.PI * 35 * 35
    expect(Math.abs(count(m) - target) / target).toBeLessThan(0.05)
  })

  it('background noise stays background around a pale logo', () => {
    // Per-channel noise around the paper, stronger than a faint yellow fill's
    // distance from it in places.
    const w = 200
    const h = 160
    let seed = 7
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff
      return seed / 0x7fffffff
    }
    const d = new Uint8ClampedArray(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      const n = Math.round((rnd() - 0.5) * 18)
      d.set([255 + n, 255 + n, 255 + n, 255], i * 4)
    }
    for (let y = 60; y < 100; y++)
      for (let x = 60; x < 140; x++) d.set([250, 240, 120, 255], (y * w + x) * 4)
    const m = imageInkMask(d, w, h, { detail: 50, invert: false })
    const target = 40 * 80
    // The logo whole, noise not traced on top of it.
    expect(count(m)).toBeGreaterThan(target * 0.9)
    expect(count(m)).toBeLessThan(target * 1.5)
  })
})

describe('colour layers (layered trace)', () => {
  /** A filled blob with two transparent eye holes, like the face artwork. */
  function faceImage(w: number, h: number): Uint8ClampedArray {
    const d = new Uint8ClampedArray(w * h * 4) // transparent everywhere
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (Math.hypot(x - w / 2, y - h / 2) <= w / 3) d.set([10, 10, 10, 255], (y * w + x) * 4)
    for (const ex of [w / 2 - w / 6, w / 2 + w / 6])
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++)
          if (Math.hypot(x - ex, y - h / 2.5) <= w / 14) d.set([0, 0, 0, 0], (y * w + x) * 4)
    return d
  }

  it('a face with two transparent eyes is one layer; the eyes stay holes', () => {
    const w = 240
    const h = 200
    const layers = designLayers(faceImage(w, h), w, h, 50)
    expect(layers.length).toBe(1)
    const m = layers[0].mask
    // Face solid at its centre, eyes see-through (they become their own pieces
    // at vectorise time).
    expect(at(m, w, w / 2, h / 2 + 40)).toBe(1)
    expect(at(m, w, w / 2 - w / 6, h / 2.5)).toBe(0)
    expect(at(m, w, w / 2 + w / 6, h / 2.5)).toBe(0)
  })

  it('two colours on white come out as two layers; white is no layer', () => {
    const w = 240
    const h = 160
    const d = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 30; y < 130; y++)
      for (let x = 30; x < 110; x++) d.set([210, 40, 40, 255], (y * w + x) * 4)
    for (let y = 40; y < 120; y++)
      for (let x = 140; x < 210; x++) d.set([30, 60, 210, 255], (y * w + x) * 4)
    const layers = designLayers(d, w, h, 50)
    expect(layers.length).toBe(2)
    expect(layers[0].color).not.toBe(layers[1].color)
    const bigger = layers[0].mask
    const smaller = layers[1].mask
    expect(at(bigger, w, 70, 80)).toBe(1)
    expect(at(smaller, w, 70, 80)).toBe(0)
    expect(at(smaller, w, 175, 80)).toBe(1)
    expect(at(bigger, w, 175, 80)).toBe(0)
  })

  it('a colour sitting inside another leaves the lower layer solid there', () => {
    // Red square with a blue disc fully inside it: the disc must not punch a
    // hole in the square (that would cut it through), so red fills under the
    // disc and the disc comes out as its own piece.
    const w = 240
    const h = 160
    const d = new Uint8ClampedArray(w * h * 4).fill(255)
    for (let y = 30; y < 130; y++)
      for (let x = 30; x < 210; x++) d.set([210, 40, 40, 255], (y * w + x) * 4)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++)
        if (Math.hypot(x - 120, y - 80) <= 30) d.set([30, 60, 210, 255], (y * w + x) * 4)
    const layers = designLayers(d, w, h, 50)
    expect(layers.length).toBe(2)
    const red = layers.find((l) => l.color === '#d22828') ?? layers[0]
    const blue = layers.find((l) => l.color !== red.color) ?? layers[1]
    // Blue's own pixels are blue's; red is solid underneath them.
    expect(at(blue.mask, w, 120, 80)).toBe(1)
    expect(at(red.mask, w, 120, 80)).toBe(1)
    expect(at(red.mask, w, 120 - 32, 80)).toBe(1)
    expect(at(red.mask, w, 120 + 32, 80)).toBe(1)
    // No gap anywhere along the disc's rim: the square is whole.
    let gap = 0
    for (let a = 0; a < 360; a += 5) {
      const x = Math.round(120 + 30 * Math.cos((a * Math.PI) / 180))
      const y = Math.round(80 + 30 * Math.sin((a * Math.PI) / 180))
      if (!red.mask[y * w + x]) gap++
    }
    expect(gap).toBe(0)
  })

  it('layered vectorise turns every loop into its own shape', async () => {
    // A ring mask: outline gives one group (outer + hole), layered gives two.
    const w = 200
    const h = 200
    const m = new Uint8Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) if (Math.abs(Math.hypot(x - 100, y - 100) - 60) <= 12) m[y * w + x] = 1
    const outline = await vectorise(m, w, h, 4, 'outline')
    expect(outline.groups.length).toBe(1)
    expect(outline.groups[0].length).toBe(2)
    const layered = await vectorise(m, w, h, 4, 'layered')
    expect(layered.groups.length).toBe(2)
    for (const g of layered.groups) expect(g.length).toBe(1)
  })

  it('the traced face comes out as three pieces: face plus two eyes', async () => {
    const w = 240
    const h = 200
    const layers = designLayers(faceImage(w, h), w, h, 50)
    const parts = []
    for (const l of layers) parts.push(await vectorise(l.mask, w, h, 4, 'layered'))
    const merged = mergeLayered(parts, layers.map((l) => l.color))
    // Face piece + one piece per eye.
    expect(merged.groups.length).toBe(3)
    expect(merged.colors).toEqual([layers[0].color, layers[0].color, layers[0].color])
    // Areas: the face piece is the big one; the eyes are the two small ones.
    const areas = merged.groups.map((g) => Math.abs(g[0].pts.reduce((a, p, i, pts) => {
      const q = pts[(i + 1) % pts.length]
      return a + (p.x * q.y - q.x * p.y)
    }, 0)) / 2)
    areas.sort((a, b) => b - a)
    expect(areas[0]).toBeGreaterThan(areas[1] * 4)
    // Each eye is a circle of radius w/14 px at 4 px/mm.
    const eyeArea = Math.PI * (w / 14 / 4) ** 2
    expect(areas[1]).toBeGreaterThan(eyeArea * 0.7)
    expect(areas[1]).toBeLessThan(eyeArea * 1.3)
    expect(Math.abs(areas[1] - areas[2])).toBeLessThan(areas[1] * 0.2)
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
