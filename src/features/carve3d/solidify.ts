// Outer shell of a mesh that is not watertight.
//
// The slicer reads material from triangle winding, which only works on closed surfaces. Models
// exported from games and renderers are usually not closed: single-sided body panels, separate
// overlapping parts, a full interior behind the skin. Sliced as they are, most sections never
// close and the plan carves fragments (seats, dashboard, pieces of sill) instead of the body.
//
// What a carving needs is the model's OUTSIDE: everything that cannot be reached from the
// surrounding air is material. So for such a mesh:
//   1. voxelise the surface (every triangle, whatever its winding or whether it is closed),
//   2. thicken it by `gap` voxels so cracks between panels are sealed,
//   3. flood-fill the air from the grid border (6-connected scanline fill),
//   4. grow the air back by the same `gap` (a morphological closing: thin panels keep their
//      thickness, cracks narrower than ~2·gap stay sealed),
//   5. everything the air never reached is solid; mesh its boundary with surface nets, which
//      gives a closed, consistently wound triangle soup the rest of the pipeline slices exactly.
// A watertight mesh is left untouched (it already slices exactly, at full precision).
import { yieldFrame } from './slicer'

export interface SolidifyOptions {
  /** Voxels along the model's longest side. */
  resolution?: number
  /** Upper bound on grid cells (memory: ~2 bytes per cell). */
  maxCells?: number
  /** Cracks up to about 2·gap voxels wide are treated as closed. */
  gap?: number
  onProgress?: (fraction: number) => void
}

export interface ShellResult {
  positions: Float32Array
  /** True when the mesh was rebuilt from its outer shell. */
  solidified: boolean
  /** Voxel edge in the file's units (0 when not solidified). */
  voxel: number
}

// ---- watertightness ------------------------------------------------------------------------

/**
 * Unpaired edges of a triangle soup: corners are welded (relative tolerance), then every edge
 * a→b must be matched by an edge b→a. Open boundaries, single-sided panels and flipped
 * triangles all leave unpaired edges.
 */
export function unpairedEdges(positions: Float32Array): { unpaired: number; edges: number } {
  const n = positions.length / 3
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const tol = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) * 1e-7, 1e-12)
  const ids = new Map<string, number>()
  const corner = new Uint32Array(n)
  for (let c = 0; c < n; c++) {
    const key = `${Math.round(positions[3 * c] / tol)},${Math.round(positions[3 * c + 1] / tol)},${Math.round(positions[3 * c + 2] / tol)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = ids.size
      ids.set(key, id)
    }
    corner[c] = id
  }
  const V = ids.size
  const balance = new Map<number, number>()
  let edges = 0
  for (let t = 0; t < n; t += 3)
    for (let e = 0; e < 3; e++) {
      const a = corner[t + e]
      const b = corner[t + ((e + 1) % 3)]
      if (a === b) continue
      edges++
      const key = a < b ? a * V + b : b * V + a
      balance.set(key, (balance.get(key) ?? 0) + (a < b ? 1 : -1))
    }
  let unpaired = 0
  for (const v of balance.values()) unpaired += Math.abs(v)
  return { unpaired, edges }
}

/** Closed and consistently wound, give or take a handful of float-noise edges. */
export function isWatertight(positions: Float32Array): boolean {
  const { unpaired, edges } = unpairedEdges(positions)
  return unpaired <= Math.max(0, edges * 1e-4)
}

// ---- voxel grid ----------------------------------------------------------------------------

const BLOCK = 1 // surface (thickened)
const AIR = 2 // reached from outside

/** Grow the `bit` set by r voxels along one axis (box dilation, separable). */
function dilateAxis(g: Uint8Array, tmp: Uint8Array, bit: number, r: number, len: number, stride: number, outerCount: number, outerStride: number, innerCount: number, innerStride: number) {
  for (let o = 0; o < outerCount; o++)
    for (let q = 0; q < innerCount; q++) {
      const base = o * outerStride + q * innerStride
      // Distance since the last set voxel, scanning forward then backward.
      let last = -Infinity
      for (let i = 0; i < len; i++) {
        const k = base + i * stride
        if (g[k] & bit) last = i
        tmp[k] = i - last <= r ? 1 : 0
      }
      last = Infinity
      for (let i = len - 1; i >= 0; i--) {
        const k = base + i * stride
        if (g[k] & bit) last = i
        if (last - i <= r) tmp[k] = 1
      }
    }
  for (let k = 0; k < g.length; k++) g[k] = tmp[k] ? g[k] | bit : g[k] & ~bit
}

function dilate(g: Uint8Array, tmp: Uint8Array, bit: number, r: number, nx: number, ny: number, nz: number) {
  if (r <= 0) return
  dilateAxis(g, tmp, bit, r, nx, 1, nz, nx * ny, ny, nx)
  dilateAxis(g, tmp, bit, r, ny, nx, nz, nx * ny, nx, 1)
  dilateAxis(g, tmp, bit, r, nz, nx * ny, ny, nx, nx, 1)
}

/** 6-connected scanline flood fill of AIR through cells without BLOCK, seeded at (0,0,0). */
function floodAir(g: Uint8Array, nx: number, ny: number, nz: number) {
  const free = (k: number) => (g[k] & (BLOCK | AIR)) === 0
  const stack: number[] = [0]
  const sxy = nx * ny
  while (stack.length) {
    const seed = stack.pop()!
    if (!free(seed)) continue
    const row = seed - (seed % nx)
    let a = seed
    while (a > row && free(a - 1)) a--
    let b = seed
    while (b < row + nx - 1 && free(b + 1)) b++
    for (let k = a; k <= b; k++) g[k] |= AIR
    const y = Math.floor(row / nx) % ny
    const z = Math.floor(row / sxy)
    // One seed per free run in each neighbouring row.
    const scan = (off: number) => {
      let inRun = false
      for (let k = a; k <= b; k++) {
        const f = free(k + off)
        if (f && !inRun) stack.push(k + off)
        inRun = f
      }
    }
    if (y > 0) scan(-nx)
    if (y < ny - 1) scan(nx)
    if (z > 0) scan(-sxy)
    if (z < nz - 1) scan(sxy)
  }
}

/** Growable typed arrays for the mesher. */
class F32 {
  a = new Float32Array(1 << 16)
  n = 0
  push3(x: number, y: number, z: number) {
    if (this.n + 3 > this.a.length) {
      const b = new Float32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = x
    this.a[this.n++] = y
    this.a[this.n++] = z
  }
}
class U32 {
  a = new Uint32Array(1 << 16)
  n = 0
  push4(p: number, q: number, r: number, s: number) {
    if (this.n + 4 > this.a.length) {
      const b = new Uint32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = p
    this.a[this.n++] = q
    this.a[this.n++] = r
    this.a[this.n++] = s
  }
}

/** Corner offsets of a cell (bit c: x = c&1, y = c>>1&1, z = c>>2&1) and its 12 edges. */
const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
]

/**
 * Outer shell of `positions` as a closed triangle soup (same units and frame as the input).
 * Watertight input is returned as is.
 */
export async function outerShell(positions: Float32Array, opts: SolidifyOptions = {}): Promise<ShellResult> {
  if (isWatertight(positions)) return { positions, solidified: false, voxel: 0 }
  const progress = opts.onProgress ?? (() => {})

  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (let i = 0; i < positions.length; i += 3) {
    const x = positions[i], y = positions[i + 1], z = positions[i + 2]
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    if (y < minY) minY = y
    if (y > maxY) maxY = y
    if (z < minZ) minZ = z
    if (z > maxZ) maxZ = z
  }
  const ex = maxX - minX, ey = maxY - minY, ez = maxZ - minZ
  const longest = Math.max(ex, ey, ez)
  if (!(longest > 0)) return { positions, solidified: false, voxel: 0 }

  const gap = Math.max(0, Math.round(opts.gap ?? 2))
  const pad = gap + 2
  let cell = longest / (opts.resolution ?? 512)
  const maxCells = opts.maxCells ?? 40_000_000
  const dims = (c: number) => [ex, ey, ez].map((e) => Math.ceil(e / c) + 1 + 2 * pad)
  while (dims(cell).reduce((a, b) => a * b, 1) > maxCells) cell *= 1.05
  const [nx, ny, nz] = dims(cell)
  const sxy = nx * ny
  // Voxel (i, j, k) is centred on origin + (i, j, k)·cell.
  const ox = minX - pad * cell, oy = minY - pad * cell, oz = minZ - pad * cell

  const g = new Uint8Array(nx * ny * nz)

  // 1. Surface voxels: sample every triangle at half-voxel spacing.
  const triCount = positions.length / 9
  for (let t = 0; t < triCount; t++) {
    if ((t & 0x3fff) === 0) {
      progress(0.4 * (t / triCount))
      await yieldFrame()
    }
    const o = t * 9
    const ax = (positions[o] - ox) / cell, ay = (positions[o + 1] - oy) / cell, az = (positions[o + 2] - oz) / cell
    const bx = (positions[o + 3] - ox) / cell, by = (positions[o + 4] - oy) / cell, bz = (positions[o + 5] - oz) / cell
    const cx = (positions[o + 6] - ox) / cell, cy = (positions[o + 7] - oy) / cell, cz = (positions[o + 8] - oz) / cell
    const longestEdge = Math.max(Math.hypot(bx - ax, by - ay, bz - az), Math.hypot(cx - bx, cy - by, cz - bz), Math.hypot(ax - cx, ay - cy, az - cz))
    const n = Math.max(1, Math.ceil(longestEdge * 2))
    for (let u = 0; u <= n; u++)
      for (let v = 0; v <= n - u; v++) {
        const s = u / n
        const w = v / n
        const i = Math.round(ax + (bx - ax) * s + (cx - ax) * w)
        const j = Math.round(ay + (by - ay) * s + (cy - ay) * w)
        const k = Math.round(az + (bz - az) * s + (cz - az) * w)
        g[(k * ny + j) * nx + i] = BLOCK
      }
  }

  // 2–4. Seal cracks, flood the air, give the air back what the sealing took.
  progress(0.45)
  await yieldFrame()
  const tmp = new Uint8Array(g.length)
  dilate(g, tmp, BLOCK, gap, nx, ny, nz)
  progress(0.55)
  await yieldFrame()
  floodAir(g, nx, ny, nz)
  progress(0.65)
  await yieldFrame()
  dilate(g, tmp, AIR, gap, nx, ny, nz)
  // Solid = never reached by air. Reuse tmp as the solid mask.
  const solid = tmp
  for (let k = 0; k < g.length; k++) solid[k] = g[k] & AIR ? 0 : 1
  progress(0.75)
  await yieldFrame()

  // 5. Surface nets: one vertex per cell (2×2×2 voxels) whose corners disagree, at the mean of
  // its crossing edges' midpoints; one quad per crossing voxel edge, from the four cells around
  // it, wound so the normal points from solid to air.
  const verts = new F32()
  const quads = new U32()
  const layer = [new Int32Array(sxy).fill(-1), new Int32Array(sxy).fill(-1)]
  const corner = new Uint8Array(8)
  const cnx = nx - 1, cny = ny - 1, cnz = nz - 1
  for (let k = 0; k < cnz; k++) {
    if ((k & 15) === 0) {
      progress(0.75 + 0.25 * (k / cnz))
      await yieldFrame()
    }
    const cur = layer[k & 1]
    const prev = layer[(k + 1) & 1]
    cur.fill(-1)
    for (let j = 0; j < cny; j++)
      for (let i = 0; i < cnx; i++) {
        const base = (k * ny + j) * nx + i
        let mask = 0
        for (let c = 0; c < 8; c++) {
          const v = solid[base + (c & 1) + ((c >> 1) & 1) * nx + ((c >> 2) & 1) * sxy]
          corner[c] = v
          mask |= v << c
        }
        if (mask === 0 || mask === 255) continue
        let sx = 0, sy = 0, sz = 0, m = 0
        for (const [p, q] of EDGES) {
          if (corner[p] === corner[q]) continue
          sx += ((p & 1) + (q & 1)) / 2
          sy += (((p >> 1) & 1) + ((q >> 1) & 1)) / 2
          sz += (((p >> 2) & 1) + ((q >> 2) & 1)) / 2
          m++
        }
        const id = verts.n / 3
        verts.push3(ox + (i + sx / m) * cell, oy + (j + sy / m) * cell, oz + (k + sz / m) * cell)
        cur[j * nx + i] = id

        // Edges leaving voxel (i, j, k) — the cell's lowest corner — along +x, +y, +z. The four
        // cells sharing each edge all have indices ≤ this cell's, so they already have vertices.
        const s0 = corner[0]
        const at = (buf: Int32Array, jj: number, ii: number) => buf[jj * nx + ii]
        if (j > 0 && k > 0 && s0 !== corner[1]) {
          // x-edge: cells (i, j-1..j, k-1..k); CCW seen from +x is (y-,z-) (y+,z-) (y+,z+) (y-,z+).
          const q0 = at(prev, j - 1, i), q1 = at(prev, j, i), q2 = id, q3 = at(cur, j - 1, i)
          if (s0) quads.push4(q0, q1, q2, q3)
          else quads.push4(q3, q2, q1, q0)
        }
        if (i > 0 && k > 0 && s0 !== corner[2]) {
          // y-edge: cells (i-1..i, j, k-1..k); CCW seen from +y is (z-,x-) (z+,x-) (z+,x+) (z-,x+).
          const q0 = at(prev, j, i - 1), q1 = at(cur, j, i - 1), q2 = id, q3 = at(prev, j, i)
          if (s0) quads.push4(q0, q1, q2, q3)
          else quads.push4(q3, q2, q1, q0)
        }
        if (i > 0 && j > 0 && s0 !== corner[4]) {
          // z-edge: cells (i-1..i, j-1..j, k); CCW seen from +z is (x-,y-) (x+,y-) (x+,y+) (x-,y+).
          const q0 = at(cur, j - 1, i - 1), q1 = at(cur, j - 1, i), q2 = id, q3 = at(cur, j, i - 1)
          if (s0) quads.push4(q0, q1, q2, q3)
          else quads.push4(q3, q2, q1, q0)
        }
      }
  }

  const V = verts.a
  const Q = quads.a
  const out = new Float32Array((quads.n / 4) * 18)
  let w = 0
  const put = (v: number) => {
    out[w++] = V[3 * v]
    out[w++] = V[3 * v + 1]
    out[w++] = V[3 * v + 2]
  }
  for (let q = 0; q < quads.n; q += 4) {
    put(Q[q])
    put(Q[q + 1])
    put(Q[q + 2])
    put(Q[q])
    put(Q[q + 2])
    put(Q[q + 3])
  }
  progress(1)
  return { positions: out, solidified: true, voxel: cell }
}
