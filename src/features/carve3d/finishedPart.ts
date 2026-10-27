// The finished part of a multi-sided job: every setup's carve applied to one block.
//
// Each stage's finished surface (carvedSurface) is a height map in that side's frame: material
// above it is gone. The part is what survives all of them, so the block is sampled on a voxel
// grid in the ORIGINAL model frame, every sample is taken into each side's frame and tested
// against that stage's height map, and the surface of what remains is meshed with surface nets.
//
//   f(p) = min( inside-block distance, min over stages of h_s(q_s) − q_s.z ),  q_s = side frame of p
//
// f > 0 is material. The field is clamped to ±one cell so the mesher places walls (where a
// height map jumps) halfway between samples instead of skewing them towards the deep side.
import { CarveCancelled } from './carvePlan'
import { carvedSurface } from './finishedSurface'
import type { Heightfield } from './heightfield'
import type { PlacedModel } from './loadModel'
import type { MultiSidePlan } from './multiSide'
import { sideFrame } from './sideAnalysis'
import { yieldFrame } from './slicer'

/** Indexed triangle mesh in the original model frame (mm, Z up). */
export interface PartMesh {
  positions: Float32Array
  indices: Uint32Array
}

/** Bilinear height at world (x, y); NaN outside the map (that stage never cut there). */
function heightAt(hf: Heightfield, x: number, y: number): number {
  const fx = (x - hf.x0) / hf.dx
  const fy = (y - hf.y0) / hf.dy
  if (fx < 0 || fy < 0 || fx > hf.nx - 1 || fy > hf.ny - 1) return NaN
  const i = Math.min(hf.nx - 2, Math.floor(fx))
  const j = Math.min(hf.ny - 2, Math.floor(fy))
  const tx = fx - i
  const ty = fy - j
  const k = j * hf.nx + i
  const a = hf.h[k] + (hf.h[k + 1] - hf.h[k]) * tx
  const b = hf.h[k + hf.nx] + (hf.h[k + hf.nx + 1] - hf.h[k + hf.nx]) * tx
  return a + (b - a) * ty
}

/**
 * Surface nets over a node field (x fastest). One vertex per cell that straddles the surface,
 * at the mean of its edge crossings; one quad per sign-changing edge, wound outward (f > 0 is
 * inside). Nodes on the grid border must be outside so the mesh closes.
 */
export function surfaceNets(
  f: Float32Array,
  nx: number,
  ny: number,
  nz: number,
  origin: [number, number, number],
  cell: number,
): PartMesh {
  const cx = nx - 1
  const cy = ny - 1
  const cz = nz - 1
  const vid = new Int32Array(cx * cy * cz).fill(-1)
  const pos: number[] = []
  const node = (i: number, j: number, k: number) => (k * ny + j) * nx + i
  // Corner offsets and the 12 cube edges as corner-index pairs.
  const C = [
    [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
    [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
  ]
  const E = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ]
  const v = new Float64Array(8)
  for (let k = 0; k < cz; k++)
    for (let j = 0; j < cy; j++)
      for (let i = 0; i < cx; i++) {
        let mask = 0
        for (let c = 0; c < 8; c++) {
          v[c] = f[node(i + C[c][0], j + C[c][1], k + C[c][2])]
          if (v[c] > 0) mask |= 1 << c
        }
        if (mask === 0 || mask === 255) continue
        let sx = 0
        let sy = 0
        let sz = 0
        let n = 0
        for (const [a, b] of E) {
          const ina = v[a] > 0
          if (ina === v[b] > 0) continue
          const t = v[a] / (v[a] - v[b])
          sx += C[a][0] + (C[b][0] - C[a][0]) * t
          sy += C[a][1] + (C[b][1] - C[a][1]) * t
          sz += C[a][2] + (C[b][2] - C[a][2]) * t
          n++
        }
        vid[(k * cy + j) * cx + i] = pos.length / 3
        pos.push(origin[0] + (i + sx / n) * cell, origin[1] + (j + sy / n) * cell, origin[2] + (k + sz / n) * cell)
      }

  const idx: number[] = []
  const cellId = (i: number, j: number, k: number) => vid[(k * cy + j) * cx + i]
  const quad = (a: number, b: number, c: number, d: number, flip: boolean) => {
    if (a < 0 || b < 0 || c < 0 || d < 0) return
    if (flip) idx.push(a, d, c, a, c, b)
    else idx.push(a, b, c, a, c, d)
  }
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const inA = f[node(i, j, k)] > 0
        // Edge along +x: the four cells around it, counter-clockwise seen from +x (y right, z up).
        if (i < cx && j > 0 && k > 0 && j < ny - 1 && k < nz - 1 && inA !== f[node(i + 1, j, k)] > 0)
          quad(cellId(i, j - 1, k - 1), cellId(i, j, k - 1), cellId(i, j, k), cellId(i, j - 1, k), !inA)
        // Edge along +y: counter-clockwise seen from +y (z right, x up).
        if (j < cy && i > 0 && k > 0 && i < nx - 1 && k < nz - 1 && inA !== f[node(i, j + 1, k)] > 0)
          quad(cellId(i - 1, j, k - 1), cellId(i - 1, j, k), cellId(i, j, k), cellId(i, j, k - 1), !inA)
        // Edge along +z: counter-clockwise seen from +z (x right, y up).
        if (k < cz && i > 0 && j > 0 && i < nx - 1 && j < ny - 1 && inA !== f[node(i, j, k + 1)] > 0)
          quad(cellId(i - 1, j - 1, k), cellId(i, j - 1, k), cellId(i, j, k), cellId(i - 1, j, k), !inA)
      }
  return { positions: new Float32Array(pos), indices: new Uint32Array(idx) }
}

/**
 * The finished part: the block with every stage of every side carved away, as a mesh in the
 * original model frame. `maxNodes` bounds the voxel grid (resolution adapts to the block size).
 */
export async function buildFinishedPart(
  placed: PlacedModel,
  plan: MultiSidePlan,
  signal?: AbortSignal,
  onProgress?: (fraction: number) => void,
  maxNodes = 3_000_000,
): Promise<PartMesh | null> {
  const block = plan.block
  if (!block || !plan.sides.length) return null
  const ext = [0, 1, 2].map((a) => block.max[a] - block.min[a])
  const cell = Math.max(0.25, Math.cbrt((ext[0] * ext[1] * ext[2]) / maxNodes))
  // Nodes at cell centres inside the block, plus one outside layer on every face so the mesh closes.
  const n = ext.map((e) => Math.max(1, Math.round(e / cell)) + 2)
  const [nx, ny, nz] = n
  const step = ext.map((e, a) => e / (n[a] - 2))
  const origin: [number, number, number] = [0, 1, 2].map((a) => block.min[a] - step[a] / 2) as [number, number, number]
  const pt = (a: number, i: number) => origin[a] + i * step[a]
  const clampF = Math.max(...step)

  // Start from the block: distance to the nearest block face, negative outside.
  const f = new Float32Array(nx * ny * nz)
  for (let k = 0; k < nz; k++) {
    const z = pt(2, k)
    const dz = Math.min(z - block.min[2], block.max[2] - z)
    for (let j = 0; j < ny; j++) {
      const y = pt(1, j)
      const dyz = Math.min(dz, y - block.min[1], block.max[1] - y)
      for (let i = 0; i < nx; i++) {
        const x = pt(0, i)
        f[(k * ny + j) * nx + i] = Math.max(-clampF, Math.min(clampF, dyz, x - block.min[0], block.max[0] - x))
      }
    }
  }

  const stages = plan.sides.flatMap((s) => s.plans.map((p) => ({ side: s, plan: p })))
  for (let s = 0; s < stages.length; s++) {
    if (signal?.aborted) throw new CarveCancelled()
    const { side, plan: p } = stages[s]
    const { hf } = await carvedSurface(p, p.bit, signal, 150_000)
    const { toSide } = sideFrame(side.side, placed)
    // rotateToSide is an axis permutation: one transform per sample is all it takes.
    for (let k = 0; k < nz; k++) {
      if (k % 16 === 0) {
        if (signal?.aborted) throw new CarveCancelled()
        await yieldFrame()
      }
      const z = pt(2, k)
      for (let j = 0; j < ny; j++) {
        const y = pt(1, j)
        for (let i = 0; i < nx; i++) {
          const o = (k * ny + j) * nx + i
          if (f[o] <= -clampF) continue
          const q = toSide(pt(0, i), y, z)
          const h = heightAt(hf, q[0], q[1])
          if (Number.isNaN(h)) continue
          const d = h - q[2]
          if (d < f[o]) f[o] = Math.max(-clampF, d)
        }
      }
    }
    onProgress?.((s + 1) / (stages.length + 1))
  }

  await yieldFrame()
  const mesh = surfaceNets(f, nx, ny, nz, origin, 1)
  // surfaceNets works in node units with a uniform cell; rescale per axis (cells may differ a hair).
  const pos = mesh.positions
  for (let v = 0; v < pos.length; v += 3)
    for (let a = 0; a < 3; a++) pos[v + a] = origin[a] + (pos[v + a] - origin[a]) * step[a]
  onProgress?.(1)
  return mesh
}
