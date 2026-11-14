// Board meshes for the Joinery 3D view: a board's layers (./joints) extruded along b, with
// smooth walls along curves and crease lines only where faces really meet.
import * as THREE from 'three'
import type { Pt } from '../../model/types'
import * as R from './region'
import type { BoardSolid } from './joints'

/** Point-in-region with per-ring bounds, for the many edge tests below. */
function fastContains(region: R.Region) {
  const rings = region.map((ring) => ({ ring, b: R.bounds([ring]) }))
  return (p: Pt) => {
    let w = 0
    for (const { ring, b } of rings) {
      if (p.y < b.minY || p.y > b.maxY || p.x > b.maxX) continue
      for (let i = 0, n = ring.length; i < n; i++) {
        const a = ring[i]
        const c = ring[(i + 1) % n]
        if (a.y <= p.y) {
          if (c.y > p.y && (c.x - a.x) * (p.y - a.y) - (p.x - a.x) * (c.y - a.y) > 0) w++
        } else if (c.y <= p.y && (c.x - a.x) * (p.y - a.y) - (p.x - a.x) * (c.y - a.y) < 0) w--
      }
    }
    return w !== 0
  }
}

/** Walls meeting at more than this read as a crease (drawn, flat-shaded); less is a curve. */
const CREASE = (28 * Math.PI) / 180

/**
 * One board as a mesh and its crease lines. Joint plane (a, c) and b map to the world as
 * x = b, y = c, z = a (the board width stands up). UVs run u along the board's grain.
 */
export function boardGeometry(solid: BoardSolid): { mesh: THREE.BufferGeometry; edges: THREE.BufferGeometry } {
  const pos: number[] = []
  const nor: number[] = []
  const uv: number[] = []
  const lines: number[] = []
  const grainC = solid.grain === 'c'

  const vert = (a: number, b: number, c: number, na: number, nb: number, nc: number) => {
    pos.push(b, c, a)
    nor.push(nb, nc, na)
    if (Math.abs(nb) > 0.7) uv.push(grainC ? c : a, grainC ? a : c)
    else if (grainC) uv.push(Math.abs(nc) > 0.7 ? a : c, b)
    else uv.push(b, Math.abs(nc) > 0.7 ? a : c)
  }
  const line = (a0: number, b0: number, c0: number, a1: number, b1: number, c1: number) => lines.push(b0, c0, a0, b1, c1, a1)

  const layers = solid.layers.filter((l) => l.b1 > l.b0 + 1e-6 && l.region.length)
  const inside = layers.map((l) => fastContains(l.region))

  layers.forEach((layer, li) => {
    const { b0, b1 } = layer
    const below = li > 0 && Math.abs(layers[li - 1].b1 - b0) < 1e-6 ? inside[li - 1] : null
    const above = li < layers.length - 1 && Math.abs(layers[li + 1].b0 - b1) < 1e-6 ? inside[li + 1] : null

    for (const piece of R.pieces(layer.region)) {
      // Caps.
      const contour = piece.outer.map((p) => new THREE.Vector2(p.x, p.y))
      const holes = piece.holes.map((h) => h.map((p) => new THREE.Vector2(p.x, p.y)))
      const all = [...contour, ...holes.flat()]
      for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(contour, holes)) {
        const [p, q, r] = [all[i], all[j], all[k]]
        const ccw = (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x) > 0
        // (a, c, b) is right-handed like (z, y, x) reversed: +b faces want clockwise (a, c) order.
        const top = ccw ? [p, r, q] : [p, q, r]
        const bot = ccw ? [p, q, r] : [p, r, q]
        for (const v of top) vert(v.x, b1, v.y, 0, 1, 0)
        for (const v of bot) vert(v.x, b0, v.y, 0, -1, 0)
      }

      // Walls, smooth along curves; crease lines on caps and sharp corners.
      for (const ring of [piece.outer, ...piece.holes]) {
        const n = ring.length
        const norms = ring.map((p, i) => {
          const q = ring[(i + 1) % n]
          const dx = q.x - p.x
          const dy = q.y - p.y
          const l = Math.hypot(dx, dy) || 1
          return { x: dy / l, y: -dx / l, len: l }
        })
        const smooth = (i: number) => {
          const a = norms[(i - 1 + n) % n]
          const b = norms[i]
          const ang = Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y)))
          return ang < CREASE
        }
        const vn = ring.map((_, i) => {
          if (!smooth(i)) return null
          const a = norms[(i - 1 + n) % n]
          const b = norms[i]
          const l = Math.hypot(a.x + b.x, a.y + b.y) || 1
          return { x: (a.x + b.x) / l, y: (a.y + b.y) / l }
        })
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n
          const p = ring[i]
          const q = ring[j]
          const e = norms[i]
          if (e.len < 1e-9) continue
          const np = vn[i] ?? e
          const nq = vn[j] ?? e
          // Outward is +normal for both outer rings and holes (opposite windings). Order (p,b0) (q,b0) (q,b1).
          vert(p.x, b0, p.y, np.x, 0, np.y)
          vert(p.x, b1, p.y, np.x, 0, np.y)
          vert(q.x, b1, q.y, nq.x, 0, nq.y)
          vert(p.x, b0, p.y, np.x, 0, np.y)
          vert(q.x, b1, q.y, nq.x, 0, nq.y)
          vert(q.x, b0, q.y, nq.x, 0, nq.y)
          if (!smooth(i)) line(p.x, b0, p.y, p.x, b1, p.y)

          // Cap outlines, except where the wall runs on into the next layer.
          for (const [b, next] of [
            [b0, below],
            [b1, above],
          ] as const) {
            if (!next) {
              line(p.x, b, p.y, q.x, b, q.y)
              continue
            }
            const steps = Math.max(1, Math.ceil(e.len / 0.5))
            let from = -1
            for (let s = 0; s <= steps; s++) {
              let draw = false
              if (s < steps) {
                const t = (s + 0.5) / steps
                const m = { x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t }
                const eps = 0.02
                const continues = next({ x: m.x - e.x * eps, y: m.y - e.y * eps }) && !next({ x: m.x + e.x * eps, y: m.y + e.y * eps })
                draw = !continues
              }
              if (draw && from < 0) from = s
              if (!draw && from >= 0) {
                const t0 = from / steps
                const t1 = s / steps
                line(p.x + (q.x - p.x) * t0, b, p.y + (q.y - p.y) * t0, p.x + (q.x - p.x) * t1, b, p.y + (q.y - p.y) * t1)
                from = -1
              }
            }
          }
        }
      }
    }
  })

  // Wall winding: the vertex order above assumes (a, c) rings with outer rings counter-clockwise.
  // Fix any face whose winding disagrees with its normal (cheap, and keeps the code above simple).
  for (let i = 0; i < pos.length; i += 9) {
    const ax = pos[i + 3] - pos[i]
    const ay = pos[i + 4] - pos[i + 1]
    const az = pos[i + 5] - pos[i + 2]
    const bx = pos[i + 6] - pos[i]
    const by = pos[i + 7] - pos[i + 1]
    const bz = pos[i + 8] - pos[i + 2]
    const cx = ay * bz - az * by
    const cy = az * bx - ax * bz
    const cz = ax * by - ay * bx
    const nx = nor[i] + nor[i + 3] + nor[i + 6]
    const ny = nor[i + 1] + nor[i + 4] + nor[i + 7]
    const nz = nor[i + 2] + nor[i + 5] + nor[i + 8]
    if (cx * nx + cy * ny + cz * nz < 0) {
      for (const arr of [pos, nor] as const) for (let k = 0; k < 3; k++) [arr[i + 3 + k], arr[i + 6 + k]] = [arr[i + 6 + k], arr[i + 3 + k]]
      const u = (i / 3) * 2
      ;[uv[u + 2], uv[u + 4]] = [uv[u + 4], uv[u + 2]]
      ;[uv[u + 3], uv[u + 5]] = [uv[u + 5], uv[u + 3]]
    }
  }

  const mesh = new THREE.BufferGeometry()
  mesh.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3))
  mesh.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3))
  mesh.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2))
  const edges = new THREE.BufferGeometry()
  edges.setAttribute('position', new THREE.Float32BufferAttribute(lines, 3))
  return { mesh, edges }
}

