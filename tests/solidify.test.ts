import { describe, expect, it } from 'vitest'
import { isWatertight, outerShell } from '../src/features/carve3d/solidify'
import { sliceDetailed } from '../src/features/carve3d/slicer'
import { signedArea } from '../src/geometry/offset'

/** Axis-aligned box as 12 triangles with outward winding; `flip` reverses the listed faces. */
function box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, flip: number[] = [], skip: number[] = []): number[] {
  const P = (i: number) => [i & 1 ? x1 : x0, i & 2 ? y1 : y0, i & 4 ? z1 : z0]
  // Faces as CCW quads seen from outside: -z, +z, -y, +y, -x, +x.
  const faces = [
    [0, 2, 3, 1],
    [4, 5, 7, 6],
    [0, 1, 5, 4],
    [2, 6, 7, 3],
    [0, 4, 6, 2],
    [1, 3, 7, 5],
  ]
  const t: number[] = []
  faces.forEach((f, n) => {
    if (skip.includes(n)) return
    const q = flip.includes(n) ? [...f].reverse() : f
    t.push(...P(q[0]), ...P(q[1]), ...P(q[2]), ...P(q[0]), ...P(q[2]), ...P(q[3]))
  })
  return t
}


describe('outer shell of open meshes', () => {
  it('leaves a watertight mesh untouched', async () => {
    const cube = new Float32Array(box(0, 0, 0, 40, 30, 20))
    expect(isWatertight(cube)).toBe(true)
    const r = await outerShell(cube)
    expect(r.solidified).toBe(false)
    expect(r.positions).toBe(cube)
  })

  it('fills a shell of loose, inconsistently wound panels with an interior inside', async () => {
    // Body: flipped panels (single-sided game geometry) plus a "seat" box floating inside.
    const pos = new Float32Array([...box(0, 0, 0, 40, 30, 20, [1, 3, 4]), ...box(10, 10, 5, 20, 20, 10)])
    expect(isWatertight(pos)).toBe(false)
    const r = await outerShell(pos, { resolution: 160 })
    expect(r.solidified).toBe(true)
    expect(isWatertight(r.positions)).toBe(true)
    // One solid section of the whole body, counter-clockwise like the slicer expects.
    for (const z of [3, 7, 12, 17]) {
      const s = sliceDetailed(r.positions, z)
      expect(s.openChains).toBe(0)
      expect(s.contours.length).toBe(1)
      expect(Math.abs(Math.abs(signedArea(s.contours[0].pts)) - 1200)).toBeLessThan(1200 * 0.04)
    }
  })

  it('keeps an opening the air can reach: an open-top tray stays hollow', async () => {
    // Outer walls and floor without a top; the cavity is open to the outside.
    const pos = new Float32Array(box(0, 0, 0, 40, 40, 20, [], [1]))
    const r = await outerShell(pos, { resolution: 160, gap: 1 })
    expect(r.solidified).toBe(true)
    const s = sliceDetailed(r.positions, 10)
    // Outer loop and hole: thin walls only, far less than the full 1600 mm² footprint.
    expect(s.contours.length).toBe(2)
    const a = Math.abs(s.contours.reduce((t, c) => t + signedArea(c.pts), 0))
    expect(a).toBeGreaterThan(0)
    expect(a).toBeLessThan(400)
  })
})
