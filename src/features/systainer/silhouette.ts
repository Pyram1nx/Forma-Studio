// Top-view silhouettes of triangle soups, for pockets (layout.ts) and for items whose traced
// pockets come from their own mesh (catalog.ts). Kept apart from layout.ts so the catalogue can use
// it without a circular import.
import type { Contour, Pt } from '../../model/types'
import { signedArea, simplify, unionNonZero } from '../../geometry/offset'

/** Outline, seen from above, of the part of the posed model below height `zMax`. */
export function silhouette(tris: Float32Array, zMax: number): Contour[] {
  const polys: Contour[] = []
  const P: [number, number, number][] = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  for (let i = 0; i < tris.length; i += 9) {
    for (let k = 0; k < 3; k++) P[k] = [tris[i + k * 3], tris[i + k * 3 + 1], tris[i + k * 3 + 2]]
    if (P[0][2] >= zMax && P[1][2] >= zMax && P[2][2] >= zMax) continue
    // Clip to z <= zMax (Sutherland–Hodgman against one plane).
    let pts: Pt[]
    if (P[0][2] <= zMax && P[1][2] <= zMax && P[2][2] <= zMax) pts = P.map(([x, y]) => ({ x, y }))
    else {
      pts = []
      for (let k = 0; k < 3; k++) {
        const a = P[k]
        const b = P[(k + 1) % 3]
        const ain = a[2] <= zMax
        const bin = b[2] <= zMax
        if (ain) pts.push({ x: a[0], y: a[1] })
        if (ain !== bin) {
          const t = (zMax - a[2]) / (b[2] - a[2])
          pts.push({ x: a[0] + t * (b[0] - a[0]), y: a[1] + t * (b[1] - a[1]) })
        }
      }
    }
    if (pts.length < 3) continue
    const area = signedArea(pts)
    if (Math.abs(area) < 1e-4) continue
    polys.push({ closed: true, pts: area < 0 ? pts.reverse() : pts })
  }
  return unionNonZero(polys).map((c) => ({ closed: true, pts: simplify(c.pts, 0.05, true) }))
}
