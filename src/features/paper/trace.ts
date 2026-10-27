// Vectorising the ink mask into real-world millimetre contours.
//
// Centerline mode (pen lines): Zhang-Suen thinning -> spur pruning -> skeleton
// graph walk -> mm polylines -> endpoint stitching (spatial grid) -> smoothing
// that irons out pixel stair-steps but pins corners -> RDP.
//
// Outline mode (filled shapes): marching squares on the mask -> closed loops
// (outer boundaries and holes) -> mm -> smoothing -> RDP -> holes grouped
// under the outer loop that contains them.
import type { Contour, Pt } from '../../model/types'
import { signedArea, simplify } from '../../geometry/offset'

export type VectorMode = 'centerline' | 'outline'

export interface VectorResult {
  mode: VectorMode
  /** One entry per shape: centerline = one open/closed polyline; outline = outer loop + holes. */
  groups: Contour[][]
  /** Average stroke width estimate in mm (ink area / line length). */
  strokeWidthMm: number
  lineCount: number
}

/** Polylines shorter than this (mm) are dropped as noise. */
const MIN_LINE_MM = 1.5
/** RDP tolerance (mm). Corners survive; pixel stair-steps are averaged out. */
const RDP_MM = 0.08
/** Width (scan px) of the Gaussian that irons out pixel stair-steps. */
const SMOOTH_SIGMA_PX = 2
/** A path turning more than CORNER_DEG over CORNER_SPAN_PX is a real corner and is not smoothed. */
const CORNER_DEG = 55
const CORNER_SPAN_PX = 4

/** Lets the UI repaint between heavy steps. */
export const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

// Neighbour offsets in circular order (right, bottom-right, bottom, ...).
const DX = [1, 1, 0, -1, -1, -1, 0, 1]
const DY = [0, 1, 1, 1, 0, -1, -1, -1]

/* ------------------------------------------------------------------ */
/* Zhang-Suen thinning                                                 */
/* ------------------------------------------------------------------ */

/**
 * Reduce 8-connected strokes to 1px skeletons. Works on a copy. Each pass
 * yields to the event loop so the UI stays responsive.
 */
export async function thin(mask: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const img = mask.slice()
  const del: number[] = []
  let changed = true
  let iter = 0
  while (changed && iter < 500) {
    changed = false
    iter++
    for (let step = 0; step < 2; step++) {
      del.length = 0
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!img[i]) continue
          const p2 = img[i - w]
          const p3 = img[i - w + 1]
          const p4 = img[i + 1]
          const p5 = img[i + w + 1]
          const p6 = img[i + w]
          const p7 = img[i + w - 1]
          const p8 = img[i - 1]
          const p9 = img[i - w - 1]
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
          if (B < 2 || B > 6) continue
          // A = number of 0 -> 1 transitions going round p2..p9.
          const A =
            (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
            (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0)
          if (A !== 1) continue
          if (step === 0) {
            if (p2 * p4 * p6) continue
            if (p4 * p6 * p8) continue
          } else {
            if (p2 * p4 * p8) continue
            if (p2 * p6 * p8) continue
          }
          del.push(i)
        }
      }
      if (del.length) {
        changed = true
        for (const i of del) img[i] = 0
      }
      await yieldToUi()
    }
  }
  return img
}

/* ------------------------------------------------------------------ */
/* Skeleton classification and spur pruning                            */
/* ------------------------------------------------------------------ */

/** Node = junction (a real branch point). Endpoint = skeleton pixel with one neighbour. */
interface Classes {
  node: Uint8Array
  endpoint: Uint8Array
}

/**
 * Classify skeleton pixels. A pixel is a junction candidate when its crossing
 * number (separate branches leaving it) is >= 3. Touching candidates form one
 * cluster; the cluster is a real junction only when at least three distinct
 * non-cluster pixels attach to it. Thinning leaves 2x2 clumps and staircase
 * corners that look like junctions by crossing number alone; those clusters
 * have two attachments and stay ordinary path pixels.
 */
function classify(sk: Uint8Array, w: number, h: number): Classes {
  const N = w * h
  const node = new Uint8Array(N)
  const endpoint = new Uint8Array(N)
  const cand = new Uint8Array(N)
  const ring = new Uint8Array(8)
  for (let i = 0; i < N; i++) {
    if (!sk[i]) continue
    const x = i % w
    const y = (i - x) / w
    let n = 0
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      const v = nx >= 0 && ny >= 0 && nx < w && ny < h ? sk[ny * w + nx] : 0
      ring[k] = v
      n += v
    }
    if (n === 1) endpoint[i] = 1
    let cn = 0
    for (let k = 0; k < 8; k++) if (ring[k] && !ring[(k + 1) & 7]) cn++
    if (cn >= 3) cand[i] = 1
  }

  const seen = new Uint8Array(N)
  const stamp = new Int32Array(N)
  let cid = 0
  const members: number[] = []
  for (let s = 0; s < N; s++) {
    if (!cand[s] || seen[s]) continue
    cid++
    members.length = 0
    members.push(s)
    seen[s] = 1
    for (let m = 0; m < members.length; m++) {
      const p = members[m]
      const x = p % w
      const y = (p - x) / w
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (cand[q] && !seen[q]) {
          seen[q] = 1
          members.push(q)
        }
      }
    }
    // Count distinct attachments: skeleton pixels next to the cluster that are not in it.
    let branches = 0
    for (const p of members) {
      const x = p % w
      const y = (p - x) / w
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k]
        const ny = y + DY[k]
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
        const q = ny * w + nx
        if (sk[q] && !cand[q] && stamp[q] !== cid) {
          stamp[q] = cid
          branches++
        }
      }
    }
    if (branches >= 3) for (const p of members) node[p] = 1
  }
  return { node, endpoint }
}

/**
 * Remove short spurs: walk from every endpoint along plain pixels; if the walk
 * reaches a junction within `maxLen` pixels, erase the walk. Repeats a few rounds
 * because removing a spur can turn its junction into a plain pixel.
 * Returns the number of pixels removed.
 */
export function pruneSpurs(sk: Uint8Array, w: number, h: number, maxLen: number): number {
  const N = w * h
  const mark = new Int32Array(N)
  let st = 0
  let removedTotal = 0
  for (let round = 0; round < 4; round++) {
    const { node, endpoint } = classify(sk, w, h)
    let removed = 0
    for (let e = 0; e < N; e++) {
      if (!endpoint[e] || !sk[e]) continue
      st++
      const path: number[] = [e]
      mark[e] = st
      let cur = e
      let hit = false
      while (path.length <= maxLen) {
        const x = cur % w
        const y = (cur - x) / w
        let nextPlain = -1
        for (let k = 0; k < 8; k++) {
          const nx = x + DX[k]
          const ny = y + DY[k]
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
          const q = ny * w + nx
          if (!sk[q]) continue
          if (node[q]) hit = true
          else if (mark[q] !== st && nextPlain < 0) nextPlain = q
        }
        if (hit || nextPlain < 0) break
        mark[nextPlain] = st
        path.push(nextPlain)
        cur = nextPlain
      }
      if (hit && path.length <= maxLen) {
        for (const p of path) sk[p] = 0
        removed += path.length
      }
    }
    removedTotal += removed
    if (!removed) break
  }
  return removedTotal
}

/* ------------------------------------------------------------------ */
/* Skeleton -> polylines                                               */
/* ------------------------------------------------------------------ */

/** A traced path as pixel indices (y * w + x). */
interface RawPath {
  idx: number[]
  closed: boolean
}

/**
 * Split a 1px skeleton into paths. Nodes are junctions (see classify). Paths run
 * between nodes or endpoints through plain pixels. Leftover plain pixels form
 * closed loops.
 */
export function traceSkeleton(sk: Uint8Array, w: number, h: number): RawPath[] {
  const N = w * h
  const { node, endpoint } = classify(sk, w, h)
  const visited = new Uint8Array(N)
  const buf = new Int32Array(8)

  // Fills `buf` with the skeleton neighbours of i and returns how many.
  const neighbours = (i: number): number => {
    const x = i % w
    const y = (i - x) / w
    let c = 0
    for (let k = 0; k < 8; k++) {
      const nx = x + DX[k]
      const ny = y + DY[k]
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue
      const j = ny * w + nx
      if (sk[j]) buf[c++] = j
    }
    return c
  }

  // Follow plain pixels from `first` (which follows `start`) until a node.
  const walk = (start: number, first: number): number[] => {
    const path = [start]
    let prev = start
    let cur = first
    for (;;) {
      path.push(cur)
      if (node[cur]) break
      visited[cur] = 1
      let next = -1
      let nodeNext = -1
      const c = neighbours(cur)
      for (let k = 0; k < c; k++) {
        const j = buf[k]
        if (j === prev) continue
        if (node[j]) nodeNext = j
        else if (!visited[j]) {
          // A second unvisited neighbour is the redundant twin of a staircase step:
          // absorb it so it cannot start a stray 2-pixel piece later.
          if (next < 0) next = j
          else visited[j] = 1
        }
      }
      if (next >= 0) {
        prev = cur
        cur = next
      } else if (nodeNext >= 0) {
        prev = cur
        cur = nodeNext
      } else break
    }
    return path
  }

  const out: RawPath[] = []

  // 1. Walk out from every endpoint.
  for (let i = 0; i < N; i++) {
    if (!endpoint[i] || !sk[i]) continue
    const c = neighbours(i)
    if (c === 0) continue
    const j = buf[0]
    if (node[j]) {
      out.push({ idx: [i, j], closed: false })
    } else if (!visited[j]) {
      visited[i] = 1
      out.push({ idx: walk(i, j), closed: false })
    }
  }

  // 2. Walk out from junctions along any branch not yet taken.
  for (let i = 0; i < N; i++) {
    if (!node[i]) continue
    const c = neighbours(i)
    const list: number[] = []
    for (let k = 0; k < c; k++) list.push(buf[k])
    for (const j of list) {
      if (node[j] || visited[j]) continue
      out.push({ idx: walk(i, j), closed: false })
    }
  }

  // 3. Whatever is left is a pure loop. Walk around it from any pixel.
  for (let i = 0; i < N; i++) {
    if (!sk[i] || node[i] || visited[i]) continue
    visited[i] = 1
    const c = neighbours(i)
    let first = -1
    for (let k = 0; k < c; k++) {
      const j = buf[k]
      if (!visited[j] && !node[j]) {
        first = j
        break
      }
    }
    if (first < 0) continue
    const path = walk(i, first)
    const last = path[path.length - 1]
    const closed = !node[last] && path.length >= 4 && adjacent8(last, i, w)
    out.push({ idx: path, closed })
  }
  return out
}

/** True when two pixel indices touch (8-neighbourhood). */
function adjacent8(a: number, b: number, w: number): boolean {
  const ax = a % w
  const ay = (a - ax) / w
  const bx = b % w
  const by = (b - bx) / w
  return Math.abs(ax - bx) <= 1 && Math.abs(ay - by) <= 1
}

/* ------------------------------------------------------------------ */
/* Smoothing                                                           */
/* ------------------------------------------------------------------ */

/** One Chaikin corner-cutting pass. Kept for callers that want a rounder curve. */
export function chaikin(pts: Pt[], closed: boolean): Pt[] {
  const n = pts.length
  if (n < 3) return pts.slice()
  const out: Pt[] = []
  if (!closed) out.push(pts[0])
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i]
    const b = pts[(i + 1) % n]
    out.push({ x: 0.75 * a.x + 0.25 * b.x, y: 0.75 * a.y + 0.25 * b.y })
    out.push({ x: 0.25 * a.x + 0.75 * b.x, y: 0.25 * a.y + 0.75 * b.y })
  }
  if (!closed) out.push(pts[n - 1])
  return out
}

/**
 * Iron the pixel stair-steps out of a dense traced path (one point per pixel or
 * marching-squares edge), before RDP. Repeated 1-2-1 averaging approximates a
 * Gaussian of SMOOTH_SIGMA_PX scan pixels. Real corners — where the path turns
 * more than CORNER_DEG over CORNER_SPAN_PX — and open ends are held fixed, so a
 * square stays square and lines keep their length. `pxMm` = mm per scan pixel.
 */
export function smoothTrace(pts: Pt[], closed: boolean, pxMm: number): Pt[] {
  const n = pts.length
  if (n < 5) return pts.slice()
  const step = polylineLength(pts, closed) / (closed ? n : n - 1)
  if (!(step > 0)) return pts.slice()
  const sigma = (SMOOTH_SIGMA_PX * pxMm) / step
  const iters = Math.min(80, Math.round(2 * sigma * sigma)) // binomial variance: 1/2 per pass
  if (iters < 1) return pts.slice()

  const at = (i: number) => pts[closed ? (i + n) % n : clampIdx(i, n)]
  const turn = new Float64Array(n)
  const k = Math.max(2, Math.round((CORNER_SPAN_PX * pxMm) / step))
  for (let i = 0; i < n; i++) {
    if (!closed && (i < k || i >= n - k)) continue
    const a = at(i - k)
    const b = pts[i]
    const c = at(i + k)
    const ux = b.x - a.x, uy = b.y - a.y
    const vx = c.x - b.x, vy = c.y - b.y
    const lu = Math.hypot(ux, uy)
    const lv = Math.hypot(vx, vy)
    if (lu < 1e-9 || lv < 1e-9) continue
    turn[i] = Math.acos(Math.max(-1, Math.min(1, (ux * vx + uy * vy) / (lu * lv))))
  }
  const fixed = new Uint8Array(n)
  if (!closed) fixed[0] = fixed[n - 1] = 1
  const limit = (CORNER_DEG * Math.PI) / 180
  for (let i = 0; i < n; i++) {
    if (turn[i] < limit) continue
    // Only the sharpest point of each corner is pinned.
    let peak = true
    for (let d = -k; d <= k && peak; d++) {
      if (d === 0) continue
      const j = closed ? (i + d + n) % n : i + d
      if (j < 0 || j >= n) continue
      if (turn[j] > turn[i] || (turn[j] === turn[i] && d < 0)) peak = false
    }
    if (peak) fixed[i] = 1
  }

  let xs = Float64Array.from(pts, (p) => p.x)
  let ys = Float64Array.from(pts, (p) => p.y)
  let nx = new Float64Array(n)
  let ny = new Float64Array(n)
  for (let it = 0; it < iters; it++) {
    for (let i = 0; i < n; i++) {
      if (fixed[i]) {
        nx[i] = xs[i]
        ny[i] = ys[i]
        continue
      }
      const p = closed ? (i - 1 + n) % n : i - 1
      const q = closed ? (i + 1) % n : i + 1
      nx[i] = 0.25 * xs[p] + 0.5 * xs[i] + 0.25 * xs[q]
      ny[i] = 0.25 * ys[p] + 0.5 * ys[i] + 0.25 * ys[q]
    }
    ;[xs, nx] = [nx, xs]
    ;[ys, ny] = [ny, ys]
  }
  const out: Pt[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = { x: xs[i], y: ys[i] }
  return out
}

const clampIdx = (i: number, n: number) => (i < 0 ? 0 : i >= n ? n - 1 : i)

function polylineLength(pts: Pt[], closed: boolean): number {
  let L = 0
  for (let i = 0; i + 1 < pts.length; i++) L += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y)
  if (closed && pts.length > 2) L += Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y)
  return L
}

/* ------------------------------------------------------------------ */
/* Centerline mode                                                     */
/* ------------------------------------------------------------------ */

interface Piece {
  pts: Pt[]
  closed: boolean
}

/** Thin the mask and turn the skeleton into millimetre polylines. */
async function centerline(
  mask: Uint8Array,
  w: number,
  h: number,
  ppm: number,
  ppmY: number,
  inkPx: number,
): Promise<{ groups: Contour[][]; lengthMm: number }> {
  const sk = await thin(mask, w, h)
  await yieldToUi()
  let skelPx = 0
  for (let i = 0; i < sk.length; i++) skelPx += sk[i]
  // Stroke width in px: ink pixels per skeleton pixel.
  const swPx = skelPx > 0 ? inkPx / skelPx : 1
  pruneSpurs(sk, w, h, Math.max(3, Math.round(1.5 * swPx)))
  await yieldToUi()

  const raw = traceSkeleton(sk, w, h)
  let pieces: Piece[] = []
  for (const r of raw) {
    if (r.idx.length < 2 && !r.closed) continue
    const pts: Pt[] = r.idx.map((i) => {
      const x = i % w
      const y = (i - x) / w
      return { x: (x + 0.5) / ppm, y: (y + 0.5) / ppmY }
    })
    pieces.push({ pts, closed: r.closed })
  }
  // Stitch breaks at junctions and spurs. Tolerance: about 1.5 stroke widths, at least 2 px, at most 0.6 mm.
  const tol = Math.min(0.6, Math.max(1.5 * (swPx / ppm), 2 / Math.min(ppm, ppmY)))
  // Twigs go before joining too: where a twig meets a stroke three ends touch,
  // and joining could pair an arc with the twig and leave the stroke open.
  // Twigs go before joining too: where a twig meets a stroke, joining could
  // pair the stroke with the twig and leave the stroke itself open.
  const sw = swPx / ppm
  const pxX = (q: Pt) => q.x * ppm - 0.5
  const pxY = (q: Pt) => q.y * ppmY - 0.5
  // Two ends may be bridged only when a short walk through the ink connects
  // them: then they belong to one stroke (a straight test fails where the
  // skeleton wandered onto a blot fused to the stroke).
  // A straight bridge that is almost all ink also counts: faint pencil can
  // drop out of the mask for a hair's width without being two strokes.
  const straightOnInk = (a: Pt, b: Pt) => {
    const ax = pxX(a)
    const ay = pxY(a)
    const bx = pxX(b)
    const by = pxY(b)
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) * 2))
    let hit = 0
    for (let k = 0; k <= n; k++) {
      const x = Math.round(ax + ((bx - ax) * k) / n)
      const y = Math.round(ay + ((by - ay) * k) / n)
      if (x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x]) hit++
    }
    return hit >= 0.85 * (n + 1)
  }
  const onInk = (a: Pt, b: Pt) => straightOnInk(a, b) || inkConnected(mask, w, h, pxX(a), pxY(a), pxX(b), pxY(b), 2 * swPx + 4)
  const bridge = Math.min(4, Math.max(tol, 3 * sw))
  pieces = dropBranchStubs(pieces, sw, 'junction', { joinTol: tol, reach: bridge, onInk }, tol)
  pieces = joinEndpoints(pieces, tol)
  // Twigs that were not at a clean junction still hang off a stroke now.
  pieces = dropBranchStubs(pieces, sw, 'touch', undefined, tol)
  // Gaps the skeleton leaves inside one stroke (around a blot, a bump of
  // grain) are wider than the join tolerance: bridge them over the ink.
  pieces = joinEndpoints(pieces, bridge, onInk)
  pieces = dropBranchStubs(pieces, sw, 'touch', undefined, tol)
  await yieldToUi()

  const groups: Contour[][] = []
  const pxMm = 2 / (ppm + ppmY)
  let lengthMm = 0
  for (const { pts, closed } of pieces) {
    const L = polylineLength(pts, closed)
    if (L < MIN_LINE_MM) continue
    lengthMm += L
    const simp = simplify(smoothTrace(pts, closed, pxMm), RDP_MM, closed)
    if (simp.length < 2) continue
    groups.push([{ pts: simp, closed }])
  }
  return { groups, lengthMm }
}

/**
 * Is (bx, by) reachable from (ax, ay) through ink pixels (8-connected) by a
 * path at most `slack` px longer than the straight distance? Both points snap
 * to ink within 2 px. The search stays in a box around the two points, so it
 * is cheap however large the drawing is.
 */
function inkConnected(mask: Uint8Array, w: number, h: number, ax: number, ay: number, bx: number, by: number, slack: number): boolean {
  const snap = (x: number, y: number): number => {
    const x0 = Math.round(x)
    const y0 = Math.round(y)
    let best = -1
    let bd = Infinity
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const X = x0 + dx
        const Y = y0 + dy
        if (X < 0 || Y < 0 || X >= w || Y >= h || !mask[Y * w + X]) continue
        const d = dx * dx + dy * dy
        if (d < bd) {
          bd = d
          best = Y * w + X
        }
      }
    return best
  }
  const s = snap(ax, ay)
  const t = snap(bx, by)
  if (s < 0 || t < 0) return false
  if (s === t) return true
  const limit = Math.hypot(bx - ax, by - ay) + slack
  const m = Math.ceil(limit)
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)) - m)
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)) - m)
  const x1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx)) + m)
  const y1 = Math.min(h - 1, Math.ceil(Math.max(ay, by)) + m)
  const bw = x1 - x0 + 1
  const dist = new Float32Array(bw * (y1 - y0 + 1)).fill(Infinity)
  const queue: number[] = [s]
  dist[(Math.floor(s / w) - y0) * bw + (s % w) - x0] = 0
  // Breadth-first by steps; diagonal steps count as one, so the step limit is generous enough.
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]
    const px = p % w
    const py = (p - px) / w
    const d = dist[(py - y0) * bw + px - x0]
    if (p === t) return true
    if (d >= limit) continue
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue
        const X = px + dx
        const Y = py + dy
        if (X < x0 || Y < y0 || X > x1 || Y > y1) continue
        const q = Y * w + X
        if (!mask[q]) continue
        const k = (Y - y0) * bw + X - x0
        if (dist[k] !== Infinity) continue
        dist[k] = d + 1
        queue.push(q)
      }
  }
  return false
}

/**
 * Drop short side branches: an open piece shorter than about 3 stroke widths
 * (at least 2.5 mm) that hangs off a stroke by one end, its other end free, is
 * a bump on that stroke (grain, a dust speck, a blot of ink) that the skeleton
 * turned into a twig — not something that was drawn. Short pieces standing on
 * their own are left alone.
 *
 * `junction` (raw skeleton pieces, before joining): the twig's base is a
 * junction — at least two other pieces end there, or one does and another
 * stroke's loose end (no partner within the join tolerance) waits within
 * `reach` along the ink, where the skeleton left a gap. A piece meeting just
 * one other end with nothing loose nearby is a link in a chain of fragments:
 * the last link of an open stroke is that stroke's real tip, so it stays.
 * `touch` (after joining): the twig's base touches another piece anywhere.
 * Tiny closed loops that touch a stroke go too: the skeleton circling a
 * pinhole in the ink.
 */
export function dropBranchStubs(
  pieces: Piece[],
  strokeMm: number,
  mode: 'junction' | 'touch' = 'touch',
  j?: { joinTol: number; reach: number; onInk: (a: Pt, b: Pt) => boolean },
  tipTol = 0.3,
): Piece[] {
  const stubMax = Math.max(2.5, 3 * strokeMm)
  const touch = Math.max(0.3, 1.2 * strokeMm)
  const len = pieces.map((p) => polylineLength(p.pts, p.closed))
  const near = (a: Pt, b: Pt) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 <= t2
  /** Does q come within `r` of any other piece, anywhere along it? */
  const touchesAny = (q: Pt, self: number, r: number) => {
    const t2 = r * r
    for (let j = 0; j < pieces.length; j++) {
      if (j === self) continue
      const pts = pieces[j].pts
      const segs = pieces[j].closed ? pts.length : pts.length - 1
      for (let k = 0; k < Math.max(1, segs); k++) {
        const a = pts[k]
        const b = pts[(k + 1) % pts.length]
        const dx = b.x - a.x
        const dy = b.y - a.y
        const l2 = dx * dx + dy * dy
        const t = l2 ? Math.max(0, Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / l2)) : 0
        const ex = a.x + t * dx - q.x
        const ey = a.y + t * dy - q.y
        if (ex * ex + ey * ey <= t2) return true
      }
    }
    return false
  }
  /** How many other pieces have an end at q. */
  const t2 = touch * touch
  const endsAt = (q: Pt, self: number) => {
    let n = 0
    for (let j = 0; j < pieces.length; j++) {
      if (j === self || pieces[j].closed) continue
      const pts = pieces[j].pts
      if (near(q, pts[0]) || near(q, pts[pts.length - 1])) n++
    }
    return n
  }
  // Ends with no partner end within the join tolerance (junction mode only).
  const loose: Pt[] = []
  if (j) {
    const ends: { p: Pt; i: number }[] = []
    pieces.forEach((p, i) => {
      if (!p.closed) ends.push({ p: p.pts[0], i }, { p: p.pts[p.pts.length - 1], i })
    })
    const jt2 = j.joinTol * j.joinTol
    for (const e of ends)
      if (!ends.some((f) => f !== e && (f.p.x - e.p.x) ** 2 + (f.p.y - e.p.y) ** 2 <= jt2)) loose.push(e.p)
  }
  const looseNear = (base: Pt, tip: Pt) =>
    !!j && loose.some((q) => q !== tip && Math.hypot(q.x - base.x, q.y - base.y) <= j.reach && j.onInk(base, q))
  // The tip is free when nothing is within the join tolerance of it: a twig
  // sticks out of its stroke, while a short arc's ends meet other ends.
  const hangs = (base: Pt, tip: Pt, i: number) => {
    if (touchesAny(tip, i, tipTol)) return false
    if (mode === 'touch') return touchesAny(base, i, touch)
    const n = endsAt(base, i)
    return n >= 2 || (n === 1 && looseNear(base, tip))
  }
  return pieces.filter((p, i) => {
    // A tiny loop fused to a stroke is the skeleton circling a pinhole in the ink.
    if (p.closed) return !(len[i] < 2 * stubMax && p.pts.some((q) => touchesAny(q, i, tipTol)))
    if (len[i] >= stubMax) return true
    const a = p.pts[0]
    const b = p.pts[p.pts.length - 1]
    return !(hangs(a, b, i) || hangs(b, a, i))
  })
}

/**
 * Stitch open polylines whose endpoints nearly touch, and close any line whose
 * ends meet. Candidate pairs come from a spatial grid (cell = tol), are sorted by
 * distance and joined greedily with chain bookkeeping: O(P log P) for P endpoints
 * instead of re-scanning every pair after each join.
 */
export function joinEndpoints(input: Piece[], tol: number, canJoin?: (a: Pt, b: Pt) => boolean): Piece[] {
  const done: Piece[] = []
  // Chains: open pieces being joined. Endpoint ids: 2k = head of chain k, 2k+1 = tail.
  interface Chain {
    pts: Pt[]
    s: number
    e: number
    alive: boolean
  }
  const chains: Chain[] = []
  const ep: Pt[] = []
  for (const p of input) {
    if (p.closed) {
      done.push(p)
      continue
    }
    if (p.pts.length < 2) continue
    const k = chains.length
    chains.push({ pts: p.pts, s: 2 * k, e: 2 * k + 1, alive: true })
    ep.push(p.pts[0], p.pts[p.pts.length - 1])
  }
  const E = ep.length
  if (E === 0) return done

  const chainOf = new Int32Array(E)
  for (let k = 0; k < chains.length; k++) {
    chainOf[2 * k] = k
    chainOf[2 * k + 1] = k
  }
  const dead = new Uint8Array(E)

  // Spatial grid of endpoints, cell size = tol.
  const cell = Math.max(tol, 1e-9)
  const grid = new Map<string, number[]>()
  const keyOf = (cx: number, cy: number) => `${cx},${cy}`
  for (let a = 0; a < E; a++) {
    const k = keyOf(Math.floor(ep[a].x / cell), Math.floor(ep[a].y / cell))
    const list = grid.get(k)
    if (list) list.push(a)
    else grid.set(k, [a])
  }

  // Candidate pairs within tol.
  const pairs: { d: number; a: number; b: number }[] = []
  for (let a = 0; a < E; a++) {
    const cx = Math.floor(ep[a].x / cell)
    const cy = Math.floor(ep[a].y / cell)
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const list = grid.get(keyOf(cx + dx, cy + dy))
        if (!list) continue
        for (const b of list) {
          if (b <= a) continue
          const d = Math.hypot(ep[a].x - ep[b].x, ep[a].y - ep[b].y)
          if (d <= tol && (!canJoin || canJoin(ep[a], ep[b]))) pairs.push({ d, a, b })
        }
      }
    }
  }
  pairs.sort((p, q) => p.d - q.d)

  const finishClosed = (C: Chain) => {
    const pts = C.pts
    const first = pts[0]
    const last = pts[pts.length - 1]
    const trimmed = pts.length > 3 && Math.hypot(first.x - last.x, first.y - last.y) <= tol * 1.5 ? pts.slice(0, -1) : pts
    done.push({ pts: trimmed, closed: true })
  }

  for (const { a, b } of pairs) {
    if (dead[a] || dead[b]) continue
    const ca = chainOf[a]
    const cb = chainOf[b]
    if (ca === cb) {
      // Both free ends of one chain meet: close the loop.
      const C = chains[ca]
      if (!C.alive || C.pts.length < 4) continue
      dead[a] = 1
      dead[b] = 1
      C.alive = false
      finishClosed(C)
      continue
    }
    const X = chains[ca]
    const Y = chains[cb]
    // Make `a` the tail of X and `b` the head of Y.
    if (X.s === a) {
      X.pts.reverse()
      const t = X.s
      X.s = X.e
      X.e = t
    }
    if (Y.e === b) {
      Y.pts.reverse()
      const t = Y.s
      Y.s = Y.e
      Y.e = t
    }
    X.pts = X.pts.concat(Y.pts)
    X.e = Y.e
    chainOf[X.e] = ca
    Y.alive = false
    Y.pts = []
    dead[a] = 1
    dead[b] = 1
  }

  for (const C of chains) {
    if (C.alive && C.pts.length >= 2) done.push({ pts: C.pts, closed: false })
  }
  return done
}

/* ------------------------------------------------------------------ */
/* Outline mode (marching squares)                                     */
/* ------------------------------------------------------------------ */

/**
 * Marching squares on the mask (padded by one background pixel so every loop
 * closes). Returns closed loops in pixel-edge coordinates (pixel i spans [i, i+1]).
 */
export function marchingLoops(mask: Uint8Array, w: number, h: number): Pt[][] {
  const GW = w + 2
  const sample = (gx: number, gy: number): number =>
    gx >= 1 && gy >= 1 && gx <= w && gy <= h ? mask[(gy - 1) * w + (gx - 1)] : 0

  // Edge ids: horizontal edge (gx,gy)-(gx+1,gy) = 2*n, vertical (gx,gy)-(gx,gy+1) = 2*n+1
  // where n = gy*GW + gx is the node index in the padded grid.
  const adj = new Map<number, number[]>()
  const link = (a: number, b: number) => {
    const la = adj.get(a)
    if (la) la.push(b)
    else adj.set(a, [b])
    const lb = adj.get(b)
    if (lb) lb.push(a)
    else adj.set(b, [a])
  }

  for (let cy = 0; cy < h + 1; cy++) {
    for (let cx = 0; cx < w + 1; cx++) {
      const tl = sample(cx, cy)
      const tr = sample(cx + 1, cy)
      const br = sample(cx + 1, cy + 1)
      const bl = sample(cx, cy + 1)
      const code = tl * 8 + tr * 4 + br * 2 + bl
      if (code === 0 || code === 15) continue
      const eT = (cy * GW + cx) * 2
      const eR = (cy * GW + cx + 1) * 2 + 1
      const eB = ((cy + 1) * GW + cx) * 2
      const eL = (cy * GW + cx) * 2 + 1
      switch (code) {
        case 1:
        case 14:
          link(eL, eB)
          break
        case 2:
        case 13:
          link(eB, eR)
          break
        case 3:
        case 12:
          link(eL, eR)
          break
        case 4:
        case 11:
          link(eT, eR)
          break
        case 5:
          link(eT, eL)
          link(eB, eR)
          break
        case 6:
        case 9:
          link(eT, eB)
          break
        case 7:
        case 8:
          link(eT, eL)
          break
        case 10:
          link(eT, eR)
          link(eL, eB)
          break
        default:
          break
      }
    }
  }

  // Midpoint of an edge id in pixel-edge coordinates.
  const mid = (id: number): Pt => {
    const t = id & 1
    const n = id >> 1
    const gx = n % GW
    const gy = (n - gx) / GW
    // Padded node (gx,gy) is the centre of pixel (gx-1,gy-1), i.e. (gx-0.5, gy-0.5).
    return t === 0 ? { x: gx, y: gy - 0.5 } : { x: gx - 0.5, y: gy }
  }

  const seen = new Set<number>()
  const loops: Pt[][] = []
  for (const start of adj.keys()) {
    if (seen.has(start)) continue
    const ids: number[] = []
    let prev = -1
    let cur = start
    for (;;) {
      seen.add(cur)
      ids.push(cur)
      const nb = adj.get(cur)
      if (!nb || nb.length < 2) break
      const next = nb[0] !== prev ? nb[0] : nb[1]
      if (next === start || seen.has(next)) break
      prev = cur
      cur = next
    }
    if (ids.length >= 3) loops.push(ids.map(mid))
  }
  return loops
}

interface Box {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

function boxOf(pts: Pt[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Ray-casting point-in-polygon. */
function pointInPoly(p: Pt, poly: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]
    const b = poly[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/**
 * Group loops into shapes: a loop nested at even depth is an outer boundary (or
 * an island), at odd depth it is a hole that belongs to its immediate parent.
 */
export function groupLoops(loops: Pt[][]): Contour[][] {
  const n = loops.length
  const area = loops.map((l) => Math.abs(signedArea(l)))
  const boxes = loops.map(boxOf)
  // Largest first, so a parent is always processed before its children.
  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => area[b] - area[a])
  const parent = new Int32Array(n).fill(-1)
  const depth = new Int32Array(n)
  for (const i of order) {
    let best = -1
    const bi = boxes[i]
    for (const j of order) {
      if (area[j] <= area[i]) break
      const bj = boxes[j]
      if (bj.minX > bi.minX || bj.maxX < bi.maxX || bj.minY > bi.minY || bj.maxY < bi.maxY) continue
      if (!pointInPoly(loops[i][0], loops[j])) continue
      if (best < 0 || area[j] < area[best]) best = j
    }
    parent[i] = best
    depth[i] = best < 0 ? 0 : depth[best] + 1
  }

  const groups: Contour[][] = []
  const groupOf = new Int32Array(n).fill(-1)
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 0) {
      groupOf[i] = groups.length
      groups.push([{ pts: loops[i], closed: true }])
    }
  }
  for (let i = 0; i < n; i++) {
    if (depth[i] % 2 === 1 && parent[i] >= 0) {
      groups[groupOf[parent[i]]].push({ pts: loops[i], closed: true })
    }
  }
  return groups
}

/* ------------------------------------------------------------------ */
/* Entry point                                                         */
/* ------------------------------------------------------------------ */

/**
 * Turn an ink mask into millimetre geometry. `ppm` is pixels per mm along x and
 * `ppmY` along y (defaults to ppm); the flattened paper's top-left corner is (0,0) in mm.
 */
export async function vectorise(
  mask: Uint8Array,
  w: number,
  h: number,
  ppm: number,
  mode: VectorMode,
  ppmY: number = ppm,
): Promise<VectorResult> {
  let inkPx = 0
  for (let i = 0; i < mask.length; i++) inkPx += mask[i]
  const inkAreaMm2 = inkPx / (ppm * ppmY)

  if (mode === 'centerline') {
    const { groups, lengthMm } = await centerline(mask, w, h, ppm, ppmY, inkPx)
    const sw = lengthMm > 0 ? inkAreaMm2 / lengthMm : 0
    return { mode, groups, strokeWidthMm: round2(sw), lineCount: groups.length }
  }

  // Outline: marching squares, then mm, then simplify and smooth each loop.
  const loopsMm = marchingLoops(mask, w, h).map((l) =>
    l.map((p) => ({ x: p.x / ppm, y: p.y / ppmY })),
  )
  await yieldToUi()
  const smooth: Pt[][] = []
  const pxMm = 2 / (ppm + ppmY)
  let perimeterMm = 0
  for (const l of loopsMm) {
    const s = simplify(smoothTrace(l, true, pxMm), RDP_MM, true)
    if (s.length < 3) continue
    perimeterMm += polylineLength(s, true)
    smooth.push(s)
  }
  const groups = groupLoops(smooth)
  // A thin stroke has perimeter ~ 2 x its length, so width ~ area / (perimeter / 2).
  const sw = perimeterMm > 0 ? inkAreaMm2 / (perimeterMm / 2) : 0
  return { mode, groups, strokeWidthMm: round2(sw), lineCount: groups.length }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100
}
