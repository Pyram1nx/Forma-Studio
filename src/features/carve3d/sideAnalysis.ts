// Which faces of the stock block need cutting, and how deep, for multi-sided carving.
//
// The model is analysed one axis pair at a time (top/bottom, front/back, left/right). Each face
// of the pair is rotated to face up and rasterised into a z-buffer height map: h(x, y) is the
// first model surface a straight bit would meet coming down from that face. The waste column
// above the first surface is that face's work. Opposite faces never duplicate each other: in a
// column with material, one face's waste lies above it and the other's below, so each face
// carves its own — the inside of a bowl from the top, the overhang under its rim from the
// bottom. A column that is open all the way through (outside the model's footprint on that
// face) is nobody's layered work: the outline cut-out removes it.
import type { PlacedModel } from './loadModel'

export type SideId = 'top' | 'bottom' | 'front' | 'back' | 'left' | 'right'

/** Canonical processing order: the flip sequence a user would follow around the block. */
export const SIDE_ORDER: SideId[] = ['top', 'bottom', 'front', 'back', 'left', 'right']

export const SIDE_LABEL: Record<SideId, string> = {
  top: 'Top',
  bottom: 'Bottom',
  front: 'Front',
  back: 'Back',
  left: 'Left',
  right: 'Right',
}

/** Which grid axis mirrors between the two frames of an opposite pair (frames are xy-centred). */
const PAIRS: { a: SideId; b: SideId; mirror: 'x' | 'y' }[] = [
  { a: 'top', b: 'bottom', mirror: 'y' },
  { a: 'front', b: 'back', mirror: 'y' },
  { a: 'left', b: 'right', mirror: 'x' },
]

/** Row-major 3x3 rotations taking the model space to a frame where the side faces +Z. */
const SIDE_ROT: Record<SideId, number[]> = {
  top: [1, 0, 0, 0, 1, 0, 0, 0, 1],
  bottom: [1, 0, 0, 0, -1, 0, 0, 0, -1],
  front: [1, 0, 0, 0, 0, 1, 0, -1, 0], // -Y up
  back: [1, 0, 0, 0, 0, -1, 0, 1, 0], // +Y up
  left: [0, 0, 1, 0, 1, 0, -1, 0, 0], // -X up
  right: [0, 0, -1, 0, 1, 0, 1, 0, 0], // +X up
}

/**
 * The model rotated so `side` faces up: mm, Z up, min Z = 0, XY centred — the same placement
 * convention as `placeModel`, so plan and preview code works on it unchanged.
 */
export function rotateToSide(placed: PlacedModel, side: SideId): PlacedModel {
  const m = SIDE_ROT[side]
  const src = placed.positions
  const p = new Float32Array(src.length)
  for (let i = 0; i < src.length; i += 3) {
    const x = src[i]
    const y = src[i + 1]
    const z = src[i + 2]
    p[i] = m[0] * x + m[1] * y + m[2] * z
    p[i + 1] = m[3] * x + m[4] * y + m[5] * z
    p[i + 2] = m[6] * x + m[7] * y + m[8] * z
  }
  let minX = Infinity
  let minY = Infinity
  let minZ = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let maxZ = -Infinity
  for (let i = 0; i < p.length; i += 3) {
    if (p[i] < minX) minX = p[i]
    if (p[i] > maxX) maxX = p[i]
    if (p[i + 1] < minY) minY = p[i + 1]
    if (p[i + 1] > maxY) maxY = p[i + 1]
    if (p[i + 2] < minZ) minZ = p[i + 2]
    if (p[i + 2] > maxZ) maxZ = p[i + 2]
  }
  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  for (let i = 0; i < p.length; i += 3) {
    p[i] -= cx
    p[i + 1] -= cy
    p[i + 2] -= minZ
  }
  return {
    positions: p,
    bbox: { min: { x: minX - cx, y: minY - cy, z: 0 }, max: { x: maxX - cx, y: maxY - cy, z: maxZ - minZ } },
    size: { x: maxX - minX, y: maxY - minY, z: maxZ - minZ },
  }
}

// ---- height maps ---------------------------------------------------------------------------

/** Z-buffer of the model surface over a regular grid in a rotated frame (world mm, Z up). */
export interface HeightMap {
  nx: number
  ny: number
  /** World position of sample (0, 0), mm. */
  x0: number
  y0: number
  dx: number
  dy: number
  /**
   * h[j * nx + i] = highest ('max') or lowest ('min') surface z in the cell, ±Infinity where no
   * triangle covers the cell (an open column on that face).
   */
  h: Float64Array
}

/**
 * Rasterise every triangle's XY footprint into the grid and keep the extreme surface z per cell.
 * Cell-centre sampling; a triangle thinner than the cell can be missed, which only skews the
 * statistics by a cell, never the plan itself (the plan slices the real mesh).
 */
export function heightMap(placed: PlacedModel, cell: number, mode: 'max' | 'min'): HeightMap {
  const b = placed.bbox
  const nx = Math.max(2, Math.ceil((b.max.x - b.min.x) / cell - 1e-9) + 1)
  const ny = Math.max(2, Math.ceil((b.max.y - b.min.y) / cell - 1e-9) + 1)
  const w = Math.max(b.max.x - b.min.x, 1e-6)
  const d = Math.max(b.max.y - b.min.y, 1e-6)
  const map: HeightMap = { nx, ny, x0: b.min.x, y0: b.min.y, dx: w / (nx - 1), dy: d / (ny - 1), h: new Float64Array(nx * ny) }
  map.h.fill(-Infinity)

  const p = placed.positions
  const sign = mode === 'max' ? 1 : -1 // work in flipped z so both modes are a running max
  for (let t = 0; t < p.length; t += 9) {
    // Vertices in grid coordinates, z flipped for the running max.
    const gx = [(p[t] - map.x0) / map.dx, (p[t + 3] - map.x0) / map.dx, (p[t + 6] - map.x0) / map.dx]
    const gy = [(p[t + 1] - map.y0) / map.dy, (p[t + 4] - map.y0) / map.dy, (p[t + 7] - map.y0) / map.dy]
    const gz = [sign * p[t + 2], sign * p[t + 5], sign * p[t + 8]]
    const area = (gx[1] - gx[0]) * (gy[2] - gy[0]) - (gx[2] - gx[0]) * (gy[1] - gy[0])
    if (Math.abs(area) < 1e-12) continue
    const i0 = Math.max(0, Math.floor(Math.min(gx[0], gx[1], gx[2])))
    const i1 = Math.min(nx - 1, Math.ceil(Math.max(gx[0], gx[1], gx[2])))
    const j0 = Math.max(0, Math.floor(Math.min(gy[0], gy[1], gy[2])))
    const j1 = Math.min(ny - 1, Math.ceil(Math.max(gy[0], gy[1], gy[2])))
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        // Barycentric weights at the grid sample itself, so the footprint boundary columns are
        // covered too (a centre-offset sample would fall outside the last triangle row).
        const px = i
        const py = j
        const w0 = ((gx[1] - px) * (gy[2] - py) - (gx[2] - px) * (gy[1] - py)) / area
        const w1 = ((gx[2] - px) * (gy[0] - py) - (gx[0] - px) * (gy[2] - py)) / area
        const w2 = 1 - w0 - w1
        if (w0 < -1e-9 || w1 < -1e-9 || w2 < -1e-9) continue
        const z = w0 * gz[0] + w1 * gz[1] + w2 * gz[2]
        const k = j * nx + i
        if (z > map.h[k]) map.h[k] = z
      }
  }
  if (mode === 'min')
    // Covered cells hold the flipped max of −z, so flip back; a cell with no surface at all is
    // an open column: from below there is nothing to cut, so it reads as h = 0 and the depth
    // comparison hands the column to the opposite face.
    for (let k = 0; k < map.h.length; k++) map.h[k] = map.h[k] === -Infinity ? 0 : -map.h[k]
  return map
}

// ---- per-side analysis ---------------------------------------------------------------------

/** A column shallower than this leaves nothing for a router (mm). */
export const CUT_MIN_DEPTH = 0.2
/** A face with work over less area than this is not worth a flip (mm²). */
export const CUT_MIN_AREA = 2
export interface SideAnalysis {
  side: SideId
  /** True when this face has work worth a setup. */
  needed: boolean
  /** Depth of the deepest waste column, measured from the model's own face (mm). */
  cutDepth: number
  /** Total area with waste deeper than CUT_MIN_DEPTH (mm²). */
  area: number
}

type Map3 = (x: number, y: number, z: number) => [number, number, number]

/**
 * rotateToSide as a point map, both ways: `toSide` takes a point of the original model frame
 * into the side's frame, `fromSide` brings it back. rotateToSide rotates (a 90° axis
 * permutation) and re-centres, so the offsets come from the permuted bbox — exact, no mesh work.
 */
export function sideFrame(side: SideId, placed: PlacedModel): { toSide: Map3; fromSide: Map3 } {
  const R = SIDE_ROT[side]
  const origMin = [placed.bbox.min.x, placed.bbox.min.y, placed.bbox.min.z]
  const origMax = [placed.bbox.max.x, placed.bbox.max.y, placed.bbox.max.z]
  const rmin = [0, 0, 0]
  const rmax = [0, 0, 0]
  for (let k = 0; k < 3; k++) {
    let c = -1
    let sign = 0
    for (let j = 0; j < 3; j++)
      if (R[k * 3 + j] !== 0) {
        c = j
        sign = R[k * 3 + j]
      }
    rmin[k] = sign > 0 ? origMin[c] : -origMax[c]
    rmax[k] = sign > 0 ? origMax[c] : -origMin[c]
  }
  const cx = (rmin[0] + rmax[0]) / 2
  const cy = (rmin[1] + rmax[1]) / 2
  const cz = rmin[2]
  return {
    // p' = R · p − c
    toSide: (x, y, z) => [
      R[0] * x + R[1] * y + R[2] * z - cx,
      R[3] * x + R[4] * y + R[5] * z - cy,
      R[6] * x + R[7] * y + R[8] * z - cz,
    ],
    fromSide: (xs, ys, zs) => {
      const vx = xs + cx
      const vy = ys + cy
      const vz = zs + cz
      // p = Rᵀ · (p' + c)
      return [R[0] * vx + R[3] * vy + R[6] * vz, R[1] * vx + R[4] * vy + R[7] * vz, R[2] * vx + R[5] * vy + R[8] * vz]
    },
  }
}

/** Nearest-sample lookup of a height map; −Infinity where the map never covered. */
function sampleMap(m: HeightMap, x: number, y: number): number {
  const i = Math.min(m.nx - 1, Math.max(0, Math.round((x - m.x0) / m.dx)))
  const j = Math.min(m.ny - 1, Math.max(0, Math.round((y - m.y0) / m.dy)))
  return m.h[j * m.nx + i]
}

/**
 * Analyse all six faces of the placed model. Only the model's own extent is considered: the
 * stock face of the top/bottom pair sits on the model face, and the four side pairs keep the
 * block margin above them (the caller adds that margin where it matters).
 *
 * Two refinements keep the job light and non-duplicative:
 *  - Open columns (no mesh under them on either face of a pair) are nobody's work: that waste is
 *    the outline through-cut around the silhouette, not layered carving.
 *  - The four side faces only get waste that is SHADOWED from both the top and the bottom
 *    (true overhangs, side bores). Waste the vertical carves already reach would only be
 *    carved again from the side — a cone vase gains nothing from its four side faces.
 */
export function analyzeSides(placed: PlacedModel, cell = 1): Record<SideId, SideAnalysis> {
  const out = {} as Record<SideId, SideAnalysis>
  for (const s of SIDE_ORDER) out[s] = { side: s, needed: false, cutDepth: 0, area: 0 }

  // Vertical reference maps in the original frame: the first surface from above and from below.
  const zTop = heightMap(placed, cell, 'max')
  const zBot = heightMap(placed, cell, 'min')
  const SHADOW_EPS = cell * 0.5

  for (const { a, b, mirror } of PAIRS) {
    const A = rotateToSide(placed, a)
    const B = rotateToSide(placed, b)
    const hA = heightMap(A, cell, 'max')
    const hB = heightMap(B, cell, 'max')
    // An open column (no surface on this face) reads as the full model depth: the waste above
    // it runs down to the opposite face of the model.
    const depthAt = (m: HeightMap, size: number, i: number, j: number) => {
      const h = m.h[j * m.nx + i]
      return h === -Infinity ? size : size - h
    }
    const vertical = a === 'top'
    const invA = vertical ? null : sideFrame(a, placed).fromSide
    const invB = vertical ? null : sideFrame(b, placed).fromSide
    for (let j = 0; j < hA.ny; j++)
      for (let i = 0; i < hA.nx; i++) {
        const ii = mirror === 'x' ? hB.nx - 1 - i : i
        const jj = mirror === 'y' ? hB.ny - 1 - j : j
        const dA = depthAt(hA, A.size.z, i, j)
        const dB =
          ii >= 0 && ii < hB.nx && jj >= 0 && jj < hB.ny ? depthAt(hB, B.size.z, ii, jj) : B.size.z
        // The two faces' waste in a column is different material — above the first surface
        // seen from one face, below the first surface seen from the other — so each face takes
        // its own; neither can reach the other's through the model.
        const faces = [
          { side: a, d: dA, size: A.size.z, m: hA, wi: i, wj: j, inv: invA },
          { side: b, d: dB, size: B.size.z, m: hB, wi: ii, wj: jj, inv: invB },
        ]
        for (const f of faces) {
          // A face has work in this column only if material sits strictly inside it: flush
          // (depth ≈ 0) means nothing to remove, and a column reaching the opposite face
          // (depth ≈ full) is open — the outline cut-out's job, not layered carving.
          if (!(f.d > CUT_MIN_DEPTH && f.d < f.size - 0.01)) continue
          let d = f.d
          if (f.inv) {
            // Trim the column to its shadowed waste: march from the face towards the first
            // surface, keep the deepest point the top and bottom carves cannot reach. The march
            // samples the OPEN segment only (one step short of the surface) — a sample at the
            // surface itself lands on the model boundary, where grid quantisation would read
            // the model's own material as shadowed waste.
            const xs = f.m.x0 + f.wi * f.m.dx
            const ys = f.m.y0 + f.wj * f.m.dy
            const steps = Math.min(400, Math.max(1, Math.ceil(d / cell)))
            let best = 0
            for (let t = 1; t <= steps; t++) {
              const zs = f.size - (d * t) / (steps + 1)
              const [xo, yo, zo] = f.inv(xs, ys, zs)
              const zt = sampleMap(zTop, xo, yo)
              const zb = sampleMap(zBot, xo, yo)
              if (zo < zt - SHADOW_EPS && zo > zb + SHADOW_EPS) best = (d * t) / (steps + 1)
            }
            // Shadowed right up to the last open sample: the waste runs on to the surface itself,
            // so the face carves the full column (stopping a step short leaves a skin behind).
            d = best >= (d * steps) / (steps + 1) - 1e-9 ? d : best
          }
          if (d > CUT_MIN_DEPTH) {
            const rec = out[f.side]
            rec.area += cell * cell
            if (d > rec.cutDepth) rec.cutDepth = d
          }
        }
      }
  }
  for (const s of SIDE_ORDER) out[s].needed = out[s].area >= CUT_MIN_AREA
  return out
}
