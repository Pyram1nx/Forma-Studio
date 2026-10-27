// Tool route for the carving animation: the bit centre's path, layer by layer, in world space
// (mm, Z up). Clearing is contour-parallel. Each ring keeps the bit centre a fixed distance
// outside the layer's forbidden region, so waste is eaten from the outside in and the finishing
// pass hugs the model last, where the bit has the least material to chew through.
import type { Contour } from '../../model/types'
import { boolean, offsetContours, signedArea } from '../../geometry/offset'
import type { Bit } from './bits'
import type { CarvePlan } from './carvePlan'

export interface RoutePoint {
  x: number
  y: number
  z: number
  /** The move INTO this point is a non-cutting travel. */
  rapid: boolean
}

/** Upper bound on clearing rings per layer; keeps the build time bounded on large stock. */
const MAX_RINGS = 300
const MIN_STEPOVER = 0.25
const SAFE_CLEARANCE = 5
/** The bit drops to this height above the cut in one rapid, then feeds in. */
const APPROACH = 1
const THROUGH_PASSES = 3

/** Area of closed contours with holes subtracted. */
function netArea(cs: Contour[]): number {
  let a = 0
  for (const c of cs) if (c.closed) a += signedArea(c.pts)
  return Math.abs(a)
}

/**
 * Contour-parallel rings around a layer's forbidden region F, outermost first. Ring k is the
 * boundary of F grown by k·step, clipped to the stock. The first k whose growth covers the whole
 * stock gives nothing new, so it ends the sequence.
 */
function clearingRings(toolpath: Contour[], stock: Contour[], step: number): Contour[][] {
  if (!toolpath.length) return []
  const stockArea = netArea(stock)
  const rings: Contour[][] = []
  for (let k = 1; k <= MAX_RINGS; k++) {
    const clipped = boolean('intersection', offsetContours(toolpath, k * step), stock)
    if (netArea(clipped) >= stockArea - 1e-3) break
    const ring = clipped.filter((c) => c.pts.length >= 3)
    if (ring.length) rings.push(ring)
  }
  return rings.reverse()
}

/** One closed loop at tip height tipZ: approach from safe height, feed around, retract. */
function cutLoop(out: RoutePoint[], c: Contour, tipZ: number, safeZ: number): void {
  const pts = c.pts
  let n = pts.length
  // Closed contours often repeat their first point; the closing move is added below.
  const first = pts[0]
  const last = pts[n - 1]
  if (n > 1 && Math.abs(last.x - first.x) < 1e-9 && Math.abs(last.y - first.y) < 1e-9) n--
  if (n < 3) return
  // Design space y points down; world y points up.
  const x0 = first.x
  const y0 = -first.y
  out.push({ x: x0, y: y0, z: safeZ, rapid: true })
  out.push({ x: x0, y: y0, z: tipZ + APPROACH, rapid: true })
  out.push({ x: x0, y: y0, z: tipZ, rapid: false })
  for (let i = 1; i < n; i++) out.push({ x: pts[i].x, y: -pts[i].y, z: tipZ, rapid: false })
  out.push({ x: x0, y: y0, z: tipZ, rapid: false })
  out.push({ x: x0, y: y0, z: safeZ, rapid: true })
}

/**
 * One pass over a set of design-space contours at tip height tipZ. The next loop is the one
 * whose start is nearest the bit, which keeps the rapid travel short.
 */
function cutContours(out: RoutePoint[], contours: Contour[], tipZ: number, safeZ: number): void {
  const todo = contours.filter((c) => c.pts.length >= 3)
  while (todo.length) {
    let pick = 0
    if (out.length) {
      const at = out[out.length - 1]
      let best = Infinity
      for (let i = 0; i < todo.length; i++) {
        const p = todo[i].pts[0]
        const d = (p.x - at.x) ** 2 + (-p.y - at.y) ** 2
        if (d < best) {
          best = d
          pick = i
        }
      }
    }
    cutLoop(out, todo.splice(pick, 1)[0], tipZ, safeZ)
  }
}

/**
 * Bit-centre route for the whole carve: every layer shallow to deep (clearing rings outside in,
 * then the finishing pass), then the through-cut passes if requested. Horizontal travel only
 * happens at the safe height, so the bit never sweeps across the stock below the model top.
 * Outline-only plans (plan.rings === false, multi-sided jobs without pocket output) skip the
 * clearing rings and just follow the outlines around the mesh.
 */
export function buildRoute(plan: CarvePlan, bit: Bit): RoutePoint[] {
  const R = bit.diameter / 2
  const safeZ = plan.modelH + SAFE_CLEARANCE
  const out: RoutePoint[] = []
  const grownStock = offsetContours(plan.stock, R)
  const rings = plan.rings !== false

  for (const layer of plan.layers) {
    const tipZ = plan.modelH - layer.depth
    const step = Math.max(MIN_STEPOVER, 1.4 * layer.sideOffset)
    if (rings) for (const ring of clearingRings(layer.toolpath, grownStock, step)) cutContours(out, ring, tipZ, safeZ)
    cutContours(out, layer.toolpath, tipZ, safeZ)
  }

  if (plan.throughCut && plan.outline.length) {
    const outer = offsetContours(plan.outline, R)
    const from = plan.layers.length ? plan.layers[plan.layers.length - 1].depth : 0
    const to = plan.throughDepth
    const passes = to - from > 1e-6 ? THROUGH_PASSES : 1
    for (let p = 1; p <= passes; p++) {
      const depth = from + ((to - from) * p) / passes
      cutContours(out, outer, plan.modelH - depth, safeZ)
    }
  }
  return out
}

/** Total path length, mm (cutting and rapid). */
export function routeLength(route: RoutePoint[]): number {
  let len = 0
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    len += Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
  }
  return len
}
