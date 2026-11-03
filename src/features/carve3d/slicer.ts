// Horizontal cross-sections of a triangle soup.
//
// Pipeline per plane: the mesh's corners are welded into shared vertices once (topology) ->
// every triangle crossing the plane gives a directed segment between two of its crossing EDGES,
// oriented by the triangle's winding so material is always on the left -> segments are chained
// through the edges they share, which closes every loop of a watertight mesh exactly, whatever
// its detail size or non-manifold edges -> chains a broken mesh leaves open are joined across
// gaps up to WELD mm -> NonZero union (so overlapping shells add up instead of cancelling) ->
// RDP simplification.
import ClipperLib from 'clipper-lib'
import type { Contour, Pt } from '../../model/types'
import { simplify } from '../../geometry/offset'

const SCALE = 1000
/** Open chain ends closer than this are joined (mm): bridges cracks in a non-watertight mesh. */
export const WELD = 0.05
/** Corners this close share a vertex (mm): file formats repeat vertices per triangle. */
const VERTEX_WELD = 1e-4
/**
 * A plane closer than this to a vertex is moved just above it (mm). Flat faces of exported
 * models carry float noise, so a plane at a terrace height would otherwise split the terrace
 * into slivers above and below the plane.
 */
const PLANE_EPS = 5e-5
/** Triangles this far beyond the plane are still candidates (room for the nudge above), mm. */
const CANDIDATE_MARGIN = 0.01
/** RDP tolerance for the output contours (mm). */
const SIMPLIFY_TOL = 0.005

export interface SliceResult {
  contours: Contour[]
  /** Chains that never closed. Non-zero means the mesh is not watertight at this height. */
  openChains: number
}

/** Let the event loop run (keeps the UI responsive between slow steps). */
export const yieldFrame = () => new Promise<void>((r) => setTimeout(r))

type IntPath = { X: number; Y: number }[]

/** NonZero union of closed loops. Loops carry their own orientation, so overlapping shells add. */
export function nonZeroUnion(loops: Contour[]): Contour[] {
  const paths: IntPath[] = loops
    .filter((c) => c.closed && c.pts.length >= 3)
    .map((c) => c.pts.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) })))
  if (!paths.length) return []
  const clip = new ClipperLib.Clipper()
  clip.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const out: IntPath[] = []
  clip.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return out
    .filter((p) => p.length >= 3)
    .map((p) => ({ closed: true, pts: p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })) }))
}

// ---- topology ------------------------------------------------------------------------------

/** Welded vertices of a triangle soup. */
interface Topology {
  /** Vertex id of every corner (3 per triangle). */
  corner: Uint32Array
  vx: Float64Array
  vy: Float64Array
  vz: Float64Array
}

const topologies = new WeakMap<Float32Array, Topology>()

/** Weld coincident corners (within VERTEX_WELD) into shared vertices. Cached per array. */
function topologyOf(positions: Float32Array): Topology {
  const hit = topologies.get(positions)
  if (hit) return hit
  const n = positions.length / 3
  const corner = new Uint32Array(n)
  const ids = new Map<string, number>()
  const vx: number[] = []
  const vy: number[] = []
  const vz: number[] = []
  const q = (v: number) => Math.round(v / VERTEX_WELD)
  for (let c = 0; c < n; c++) {
    const x = positions[3 * c]
    const y = positions[3 * c + 1]
    const z = positions[3 * c + 2]
    const key = `${q(x)},${q(y)},${q(z)}`
    let id = ids.get(key)
    if (id === undefined) {
      id = vx.length
      ids.set(key, id)
      vx.push(x)
      vy.push(y)
      vz.push(z)
    }
    corner[c] = id
  }
  const topo = { corner, vx: Float64Array.from(vx), vy: Float64Array.from(vy), vz: Float64Array.from(vz) }
  topologies.set(positions, topo)
  return topo
}

// ---- slicing -------------------------------------------------------------------------------

/**
 * Cross-section of a flat xyz triangle array (mm, Z up) at height z.
 * Returns closed regions with holes, XY in design space (y down, so Y is negated).
 */
export function sliceAt(positions: Float32Array, z: number): Contour[] {
  return sliceDetailed(positions, z).contours
}

/** `tris` limits the work to the given triangle indices (see createMeshSlicer). */
export function sliceDetailed(positions: Float32Array, z: number, tris?: Uint32Array): SliceResult {
  const { corner, vx, vy, vz } = topologyOf(positions)
  const triCount = tris ? tris.length : positions.length / 9
  const triAt = (q: number) => (tris ? tris[q] : q)

  // A vertex on (or within float noise of) the plane: move the plane just above it, so flat
  // faces at this height count as below and the section is the material above the plane.
  let zq = z
  for (let pass = 0; pass < 8; pass++) {
    let top = -Infinity
    for (let q = 0; q < triCount; q++) {
      const o = 3 * triAt(q)
      for (let e = 0; e < 3; e++) {
        const vz0 = vz[corner[o + e]]
        if (Math.abs(vz0 - zq) <= PLANE_EPS && vz0 > top) top = vz0
      }
    }
    if (top === -Infinity) break
    zq = top + 2 * PLANE_EPS
  }

  // 1. Triangle / plane crossings -> directed segments between crossing edges ("nodes").
  // A node is the edge (lo, hi vertex id); its point is computed from the edge alone, so both
  // triangles sharing the edge meet at exactly the same place.
  const nodeOf = new Map<number, number>()
  const nx: number[] = []
  const ny: number[] = []
  const V = vx.length
  const node = (a: number, b: number): number => {
    const lo = a < b ? a : b
    const hi = a < b ? b : a
    const key = lo * V + hi
    let id = nodeOf.get(key)
    if (id === undefined) {
      id = nx.length
      nodeOf.set(key, id)
      const f = (zq - vz[lo]) / (vz[hi] - vz[lo])
      nx.push(vx[lo] + f * (vx[hi] - vx[lo]))
      ny.push(vy[lo] + f * (vy[hi] - vy[lo]))
    }
    return id
  }
  const segFrom: number[] = []
  const segTo: number[] = []
  const v = [0, 0, 0]
  for (let q = 0; q < triCount; q++) {
    const o = 3 * triAt(q)
    v[0] = corner[o]
    v[1] = corner[o + 1]
    v[2] = corner[o + 2]
    const b0 = vz[v[0]] < zq
    const b1 = vz[v[1]] < zq
    const b2 = vz[v[2]] < zq
    if (b0 === b1 && b1 === b2) continue
    // Walking the corners in winding order (outward normal), the section runs from the edge
    // that steps down below the plane to the edge that climbs back above it: material on the
    // left seen from above, so outer loops come out counter-clockwise.
    let from = -1
    let to = -1
    const below = [b0, b1, b2]
    for (let e = 0; e < 3; e++) {
      const i = v[e]
      const j = v[(e + 1) % 3]
      if (below[e] === below[(e + 1) % 3] || i === j) continue
      if (below[e]) to = node(i, j)
      else from = node(i, j)
    }
    if (from < 0 || to < 0 || from === to) continue // degenerate triangle
    segFrom.push(from)
    segTo.push(to)
  }
  const m = segFrom.length
  if (!m) return { contours: [], openChains: 0 }

  // 2. Directed chaining through shared edges. On a watertight mesh every node has as many
  // segments leaving as arriving, so every walk returns to its start.
  const out: number[][] = Array.from({ length: nx.length }, () => [])
  for (let s = 0; s < m; s++) out[segFrom[s]].push(s)
  const used = new Uint8Array(m)
  const loops: Contour[] = []
  const open: number[][] = []
  for (let s0 = 0; s0 < m; s0++) {
    if (used[s0]) continue
    used[s0] = 1
    const start = segFrom[s0]
    const chain = [start]
    let cur = segTo[s0]
    for (;;) {
      if (cur === start) break
      chain.push(cur)
      let next = -1
      for (const s of out[cur])
        if (!used[s]) {
          next = s
          break
        }
      if (next < 0) break
      used[next] = 1
      cur = segTo[next]
    }
    if (cur === start) {
      if (chain.length >= 3) loops.push({ closed: true, pts: chain.map((k) => ({ x: nx[k], y: ny[k] })) })
    } else open.push(chain)
  }

  // 3. Repair: a mesh with cracks or flipped triangles leaves chains open. Join chain ends that
  // lie within WELD (a flipped chain is joined reversed), close a chain whose ends meet, and
  // orient a repaired loop by its majority direction against the closed loops' convention.
  const openChains = joinOpenChains(open, nx, ny, loops)

  // 4. NonZero union gives clean regions with holes; flip to design space (y down).
  const regions = nonZeroUnion(loops)
    .map((c) => ({ closed: true, pts: simplify(c.pts, SIMPLIFY_TOL, true).map((p: Pt) => ({ x: p.x, y: -p.y })) }))
    .filter((c) => c.pts.length >= 3)
  return { contours: regions, openChains }
}

/**
 * Greedy gap joining of open chains (node index lists). Closed results are pushed to `loops`;
 * returns how many chains stayed open.
 */
function joinOpenChains(open: number[][], nx: number[], ny: number[], loops: Contour[]): number {
  if (!open.length) return 0
  const dist = (a: number, b: number) => Math.hypot(nx[a] - nx[b], ny[a] - ny[b])
  const alive = new Uint8Array(open.length).fill(1)
  // Length-weighted travel direction per chain, before any reversal: +1 per forward segment.
  let left = 0
  for (let c0 = 0; c0 < open.length; c0++) {
    if (!alive[c0]) continue
    alive[c0] = 0
    let chain = open[c0].slice()
    let forward = 0
    let total = 0
    const tally = (pts: number[], sign: number) => {
      for (let k = 0; k + 1 < pts.length; k++) {
        const d = dist(pts[k], pts[k + 1])
        forward += sign * d
        total += d
      }
    }
    tally(chain, 1)
    for (;;) {
      const end = chain[chain.length - 1]
      if (chain.length >= 3 && dist(end, chain[0]) <= WELD) break
      let best = -1
      let bestD = WELD
      let reversed = false
      for (let c = 0; c < open.length; c++) {
        if (!alive[c]) continue
        const o = open[c]
        const ds = dist(end, o[0])
        if (ds <= bestD) {
          best = c
          bestD = ds
          reversed = false
        }
        const de = dist(end, o[o.length - 1])
        if (de < bestD) {
          best = c
          bestD = de
          reversed = true
        }
      }
      if (best < 0) break
      alive[best] = 0
      const piece = reversed ? open[best].slice().reverse() : open[best]
      tally(piece, reversed ? -1 : 1)
      chain = chain.concat(bestD === 0 ? piece.slice(1) : piece)
    }
    const end = chain[chain.length - 1]
    if (chain.length >= 3 && dist(end, chain[0]) <= WELD) {
      if (end === chain[0]) chain.pop()
      // Mostly travelled against the winding convention: the loop runs the wrong way round.
      if (total > 0 && forward < 0) chain.reverse()
      loops.push({ closed: true, pts: chain.map((k) => ({ x: nx[k], y: ny[k] })) })
    } else left++
  }
  return left
}

// ---- repeated slicing of one mesh ----------------------------------------------------------

/**
 * Repeated plane queries over one mesh: triangles are bucketed by their z-extent once, so each
 * slice only visits triangles that actually straddle the plane instead of the whole mesh.
 * Multi-sided planning slices the same rotated mesh at every stage depth, so this is what keeps
 * the job light. A single plane query can be a few orders of magnitude cheaper than
 * sliceDetailed over all triangles on large models.
 */
export interface MeshSlicer {
  slice(z: number): SliceResult
}

export function createMeshSlicer(positions: Float32Array): MeshSlicer {
  const triCount = positions.length / 9
  topologyOf(positions)
  const zmin = new Float32Array(triCount)
  const zmax = new Float32Array(triCount)
  for (let t = 0; t < triCount; t++) {
    const o = t * 9
    const a = positions[o + 2]
    const b = positions[o + 5]
    const c = positions[o + 8]
    zmin[t] = Math.min(a, b, c)
    zmax[t] = Math.max(a, b, c)
  }
  // Triangle indices sorted by their low z: a binary search finds every triangle that could
  // touch the plane; the zmax test drops the rest. The margin keeps triangles the plane nudge
  // (see sliceDetailed) may move onto.
  const order = new Uint32Array(triCount)
  for (let i = 0; i < triCount; i++) order[i] = i
  order.sort((x, y) => zmin[x] - zmin[y])
  const scratch = new Uint32Array(triCount)
  return {
    slice(z: number): SliceResult {
      let lo = 0
      let hi = triCount
      while (lo < hi) {
        const mid = (lo + hi) >> 1
        if (zmin[order[mid]] <= z + CANDIDATE_MARGIN) lo = mid + 1
        else hi = mid
      }
      let n = 0
      for (let i = 0; i < lo; i++) {
        const t = order[i]
        if (zmax[t] >= z - CANDIDATE_MARGIN) scratch[n++] = t
      }
      return sliceDetailed(positions, z, n === triCount ? undefined : scratch.subarray(0, n))
    },
  }
}
