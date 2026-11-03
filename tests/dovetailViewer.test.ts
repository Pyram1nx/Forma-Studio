import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { DEFAULT_PRESET, dovetailLayout, type DovetailParams } from '../src/features/dovetail/dovetail'
import { pinBoardGeometry } from '../src/features/dovetail/DovetailViewer'

const p: DovetailParams = { bit: DEFAULT_PRESET.bit, width: 150, tailThick: 12, pinThick: 12, tails: 4, pinWidth: 13.8, straightBit: 6.35, glueGap: 0.1 }

describe('pin board mesh', () => {
  const L = dovetailLayout(p)
  const geo = pinBoardGeometry(L.pins, L.tails, p.width, p.pinThick, p.tailThick, 100)
  const edges = new THREE.EdgesGeometry(geo, 25).getAttribute('position')

  it('has no seam where the pins meet the board', () => {
    // World: x = along the board, y = through its thickness, z = across its width. The pins end
    // at x = tailThick; an edge there may only run across a socket floor, never across a pin.
    for (let i = 0; i < edges.count; i += 2) {
      const a = new THREE.Vector3().fromBufferAttribute(edges, i)
      const b = new THREE.Vector3().fromBufferAttribute(edges, i + 1)
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

  it('is a closed solid (every edge shared by two faces)', () => {
    const key = (v: THREE.Vector3) => `${v.x.toFixed(4)},${v.y.toFixed(4)},${v.z.toFixed(4)}`
    const count = new Map<string, number>()
    const pos = geo.getAttribute('position')
    for (let t = 0; t < pos.count; t += 3) {
      const v = [0, 1, 2].map((k) => key(new THREE.Vector3().fromBufferAttribute(pos, t + k)))
      for (let k = 0; k < 3; k++) {
        const e = [v[k], v[(k + 1) % 3]].sort().join('|')
        count.set(e, (count.get(e) ?? 0) + 1)
      }
    }
    const open = [...count.values()].filter((n) => n !== 2)
    expect(open.length).toBe(0)
  })
})
