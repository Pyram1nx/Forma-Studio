// The finished piece as a height map, cut with the bit's real profile.
//
// In layer i the bit centre may visit every point outside the forbidden region F_i (the region
// enclosed by the layer's toolpath) with its tip at z_i. A surface sample at distance r from the
// nearest allowed centre is therefore cut down to z_i + heightAt(r), where heightAt is the
// inverse of the bit's radius profile (0 for a flat bit, a circle for a ball nose, a cone for a
// V-bit). The distance to the allowed region is a Euclidean distance transform of the
// rasterised F_i, so each layer costs O(samples) whatever the bit.
import type { Bit } from './bits'
import { CarveCancelled, type CarvePlan } from './carvePlan'
import { bitProfile, createHeightfield, rasterize, worldRect, isoSegments, type Heightfield } from './heightfield'
import { yieldFrame } from './slicer'


export interface CarvedSurface {
  hf: Heightfield
  /** Cut lines: iso-lines at the foot and top edge of every step, LineSegments pairs in world space. */
  cutLines: Float32Array
}

const INF = 1e20

/**
 * 1D squared distance transform (Felzenszwalb & Huttenlocher) of f with sample spacing s,
 * written into d. v and z are scratch buffers of length n and n + 1.
 */
function dt1d(f: Float64Array, d: Float64Array, n: number, s: number, v: Int32Array, z: Float64Array) {
  const s2 = s * s
  const cross = (q: number, p: number) => (f[q] + s2 * q * q - (f[p] + s2 * p * p)) / (2 * s2 * (q - p))
  // Lower envelope of the parabolas rooted at the finite samples only.
  let k = -1
  for (let q = 0; q < n; q++) {
    if (f[q] >= INF) continue
    if (k < 0) {
      k = 0
      v[0] = q
      z[0] = -INF
      z[1] = INF
      continue
    }
    let sx = cross(q, v[k])
    while (sx <= z[k]) sx = cross(q, v[--k]) // z[0] = −∞ stops this at k = 0
    k++
    v[k] = q
    z[k] = sx
    z[k + 1] = INF
  }
  if (k < 0) {
    d.fill(INF, 0, n)
    return
  }
  k = 0
  for (let q = 0; q < n; q++) {
    while (z[k + 1] < q) k++
    const t = s * (q - v[k])
    d[q] = t * t + f[v[k]]
  }
}

/** Squared distance (mm²) from every sample to the nearest sample with src[k] = 1. */
export function distanceSquared(src: Uint8Array, nx: number, ny: number, dx: number, dy: number): Float64Array {
  const out = new Float64Array(nx * ny)
  const m = Math.max(nx, ny)
  const f = new Float64Array(m)
  const d = new Float64Array(m)
  const v = new Int32Array(m)
  const z = new Float64Array(m + 1)
  // Columns (along y) first, then rows (along x).
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) f[j] = src[j * nx + i] ? 0 : INF
    dt1d(f, d, ny, dy, v, z)
    for (let j = 0; j < ny; j++) out[j * nx + i] = d[j]
  }
  for (let j = 0; j < ny; j++) {
    const row = j * nx
    for (let i = 0; i < nx; i++) f[i] = out[row + i]
    dt1d(f, d, nx, dx, v, z)
    for (let i = 0; i < nx; i++) out[row + i] = d[i]
  }
  return out
}

/**
 * Height map of the finished piece for `plan` cut with `bit`. Yields between layers and throws
 * CarveCancelled when `signal` aborts.
 */
export async function carvedSurface(plan: CarvePlan, bit: Bit, signal?: AbortSignal, maxSamples = 250_000): Promise<CarvedSurface> {
  const H = plan.modelH
  const hf = createHeightfield(worldRect(plan.stock), H, H - Math.max(plan.stockThickness, plan.carveDepth, plan.throughDepth), maxSamples)
  const prof = bitProfile(bit)
  const R = prof.radius

  // Padded grid: allowed centres just outside the stock still cut its edge.
  const pad = Math.ceil(R / Math.min(hf.dx, hf.dy)) + 1
  const px = hf.nx + 2 * pad
  const py = hf.ny + 2 * pad
  const padded = { nx: px, ny: py, x0: hf.x0 - pad * hf.dx, y0: hf.y0 - pad * hf.dy, dx: hf.dx, dy: hf.dy }
  const R2 = R * R

  for (const layer of plan.layers) {
    if (signal?.aborted) throw new CarveCancelled()
    await yieldFrame()
    if (signal?.aborted) throw new CarveCancelled()
    const tipZ = H - layer.depth
    const forbidden = rasterize(padded, layer.toolpath)
    const allowed = new Uint8Array(forbidden.length)
    for (let k = 0; k < forbidden.length; k++) allowed[k] = forbidden[k] ? 0 : 1
    const D = distanceSquared(allowed, px, py, hf.dx, hf.dy)
    for (let j = 0; j < hf.ny; j++) {
      const prow = (j + pad) * px + pad
      const row = j * hf.nx
      for (let i = 0; i < hf.nx; i++) {
        const d2 = D[prow + i]
        if (d2 > R2) continue
        const z = Math.max(hf.bottom, tipZ + prof.heightAt(Math.sqrt(d2)))
        if (z < hf.h[row + i]) hf.h[row + i] = z
      }
    }
  }

  // Through-cut: the outline is cut to the carve depth. When that reaches the stock bottom the
  // piece is freed and everything outside it is gone; on thicker stock a skin stays below.
  if (plan.throughCut && plan.outline.length) {
    const inside = rasterize(hf, plan.outline)
    const zCut = H - plan.throughDepth
    const freed = zCut <= hf.bottom + 1e-6
    for (let k = 0; k < inside.length; k++) if (!inside[k]) hf.h[k] = freed ? hf.bottom : Math.min(hf.h[k], zCut)
  }

  // Cut lines on every step: just above each layer floor (the foot of the wall) and just below
  // the previous floor (the step's top edge, the one you see from above).
  const parts: Float32Array[] = []
  let total = 0
  let prevZ = H
  for (const layer of plan.layers) {
    const z = H - layer.depth
    for (const iz of [z + 0.05, prevZ - 0.05]) {
      const seg = isoSegments(hf, iz)
      parts.push(seg)
      total += seg.length
    }
    prevZ = z
  }
  const cutLines = new Float32Array(total)
  let o = 0
  for (const p of parts) {
    cutLines.set(p, o)
    o += p.length
  }
  return { hf, cutLines }
}
