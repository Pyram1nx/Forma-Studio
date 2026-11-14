import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_PRESET, dovetailLayout, type DovetailParams } from '../src/features/dovetail/dovetail'
import { dovetailJoint, finePinJoint, DEFAULT_FIT, pickBit, CUSTOM_BIT } from '../src/features/dovetail/joints'
import { boardGeometry } from '../src/features/dovetail/boardGeometry'

const p: DovetailParams = { bit: DEFAULT_PRESET.bit, width: 150, tailThick: 12, pinThick: 12, tails: 4, pinWidth: 13.8, straightBit: 6.35, glueGap: 0.1 }
const fmt = (mm: number) => `${mm} mm`

/** Edges of a triangle soup that are not shared by exactly two triangles. */
function openEdges(geo: THREE.BufferGeometry): number {
  const key = (v: THREE.Vector3) => `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
  const count = new Map<string, number>()
  const pos = geo.getAttribute('position')
  for (let t = 0; t < pos.count; t += 3) {
    const v = [0, 1, 2].map((k) => key(new THREE.Vector3().fromBufferAttribute(pos, t + k)))
    for (let k = 0; k < 3; k++) {
      const e = [v[k], v[(k + 1) % 3]].sort().join('|')
      count.set(e, (count.get(e) ?? 0) + 1)
    }
  }
  return [...count.values()].filter((n) => n !== 2).length
}

describe('pin board mesh', () => {
  const L = dovetailLayout(p)
  const model = dovetailJoint(p, 'bit', undefined, fmt)
  const { edges } = boardGeometry(model.pin)
  const lines = edges.getAttribute('position')

  it('has no seam where the pins meet the board', () => {
    // World: x = along the board, y = through its thickness, z = across its width. The pins end
    // at x = tailThick; a crease there may only run across a socket floor, never across a pin.
    for (let i = 0; i < lines.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(lines, i)
      const b = new THREE.Vector3().fromBufferAttribute(lines, i + 1)
      if (Math.abs(a.x - p.tailThick) > 1e-6 || Math.abs(b.x - p.tailThick) > 1e-6) continue
      if (Math.abs(a.y - b.y) > 1e-6) continue // a socket floor's flank edge
      const mid = (a.z + b.z) / 2
      const y = a.y
      const inPin = L.pins.some((pin) => {
        const [l, r] = y < 1e-6 ? [pin[0].x, pin[1].x] : [pin[3].x, pin[2].x]
        return mid > l + 1e-6 && mid < r - 1e-6
      })
      expect(inPin).toBe(false)
    }
  })

  it('every layer is a closed solid (each edge shared by two faces)', () => {
    for (const layer of model.pin.layers) expect(openEdges(boardGeometry({ grain: 'b', layers: [layer] }).mesh)).toBe(0)
    for (const layer of model.tail.layers) expect(openEdges(boardGeometry({ grain: 'c', layers: [layer] }).mesh)).toBe(0)
  })

  it('fine-pin boards with round corners are closed solids too', () => {
    const m = finePinJoint(
      {
        width: 150,
        tailThick: 12,
        pinThick: 12,
        pins: null,
        pinWidth: null,
        slope: 6,
        edgePin: null,
        tailBit: { id: CUSTOM_BIT, custom: { diameter: 2, cutLength: 15 } },
        pinBit: pickBit(6.35, 13),
        fit: { ...DEFAULT_FIT.mm },
      },
      fmt,
    )
    for (const layer of [...m.pin.layers, ...m.tail.layers]) expect(openEdges(boardGeometry({ grain: 'b', layers: [layer] }).mesh)).toBe(0)
  })
})
